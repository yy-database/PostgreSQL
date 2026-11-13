/** Adapts the native `ServerStore` to the engine's `Storage` surface.
 *
 * One data directory is one primary store plus one shard per table group. The
 * primary keeps the catalog documents, the sequence high-water marks and the
 * cluster row in `local-0.yykv`; every table and its own indexes live together
 * in `shards/<shard-id>/`, a self-contained single-shard directory. A regular
 * DML batch therefore still commits exactly one shard atomically, and a commit
 * only re-encodes the bytes of the groups it touched.
 *
 * Commit protocol, crash-safe by construction:
 *
 * - DML and creation: shard groups commit first, the catalog last. A crash
 *   between the two leaves a group shard the catalog does not reference, or a
 *   sequence counter lagging behind durable rows. Neither is visible: the
 *   sweep at open deletes unreferenced shard directories, and the next
 *   catalog commit converges.
 * - Drops: when the batch's catalog removes a relation or an index, the
 *   catalog commits first and the shard cleanup after. A crash leaves an
 *   orphan shard directory, which the same sweep removes at open.
 * - The client only ever sees success after the last commit, so a crash
 *   between commits loses at most the un-acked statement, never half a row.
 *
 * Migration: a directory written before per-table sharding keeps every
 * namespace in the primary shard. Opening such a directory copies each table
 * group into its own shard, then deletes those rows from the primary in one
 * atomic commit per database. The flip is the commit point: before it the old
 * layout is authoritative and a restart retries; after it the new layout is
 * authoritative and leftovers are swept. The whole pass is idempotent.
 */

import type { ServerStore, ServerStoreChange } from '../native.ts';
import { CLUSTER_KEY, CLUSTER_NAMESPACE } from './sql/cluster.ts';
import type { SqlValue } from './sql/types.ts';
import {
    CATALOG_KEY,
    CATALOG_NAMESPACE,
    ROWID_NAMESPACE_PREFIX,
    DATA_NAMESPACE_PREFIX,
    INDEX_NAMESPACE_PREFIX,
    SEQUENCE_STATE_NAMESPACE,
    type Storage,
    type StoredChange,
    type StoredRow,
} from './sql/database.ts';

const EMPTY = Buffer.alloc(0);
const decoder = new TextDecoder();

/** One stored row read as a zero-copy view over the flat `scanFlat` payload. */
function readFlatRows(payload: Buffer): StoredRow[] {
    const count = payload.readUInt32LE(0);
    const rows: StoredRow[] = [];
    let offset = 4;
    for (let index = 0; index < count; index += 1) {
        const keyLength = payload.readUInt32LE(offset);
        const valueLength = payload.readUInt32LE(offset + 4);
        offset += 8;
        rows.push({ key: payload.subarray(offset, offset + keyLength), value: payload.subarray(offset + keyLength, offset + keyLength + valueLength) });
        offset += keyLength + valueLength;
    }
    return rows;
}

/** Namespace split: the database a row belongs to and the tail inside it. */
interface Route {
    /** Database the namespace belongs to, or `null` for cluster-wide rows. */
    db: string | null;
    /** `data`, `rowid` and `index` route to a table-group shard, everything else stays primary. */
    kind: 'data' | 'rowid' | 'index' | 'none';
    /** Relation oid for `data`/`rowid`, index oid for `index`. */
    oid: number;
}

/**
 * Splits one stored namespace. The database name may itself contain colons,
 * so the split takes the last one: relation tails (`pg_data.<oid>` and
 * friends) never do.
 */
function parseRoute(namespace: string): Route {
    let db: string | null = null;
    let tail = namespace;
    if (namespace.startsWith('db:')) {
        const split = /^db:(.*):(.*)$/.exec(namespace);
        if (split) {
            db = split[1] ?? '';
            tail = split[2] ?? '';
        }
    }
    if (tail.startsWith(DATA_NAMESPACE_PREFIX) || tail.startsWith(INDEX_NAMESPACE_PREFIX) || tail.startsWith(ROWID_NAMESPACE_PREFIX)) {
        const kind = tail.startsWith(DATA_NAMESPACE_PREFIX)
            ? 'data'
            : tail.startsWith(ROWID_NAMESPACE_PREFIX)
              ? 'rowid'
              : 'index';
        const prefix = kind === 'data' ? DATA_NAMESPACE_PREFIX : kind === 'rowid' ? ROWID_NAMESPACE_PREFIX : INDEX_NAMESPACE_PREFIX;
        const oid = Number(tail.slice(prefix.length));
        if (Number.isSafeInteger(oid)) {
            return { db, kind, oid };
        }
    }
    return { db, kind: 'none', oid: 0 };
}

/** The table-group shard directory id one relation owns inside one database. */
function shardIdFor(db: string, relOid: number): string {
    return `local-${relOid}-${Buffer.from(db, 'utf8').toString('hex')}`;
}

/** The durable relations and index owners one catalog document declares. */
interface CatalogGroups {
    relations: Set<number>;
    indexOwners: Map<number, number>;
}

function catalogGroups(value: Uint8Array): CatalogGroups {
    const doc = JSON.parse(decoder.decode(value)) as {
        relations?: { oid?: unknown; relkind?: unknown }[];
        indexes?: { oid?: unknown; relid?: unknown }[];
    };
    const relations = new Set<number>();
    for (const relation of doc.relations ?? []) {
        if (typeof relation.oid === 'number' && relation.relkind === 'r') relations.add(relation.oid);
    }
    const indexOwners = new Map<number, number>();
    for (const index of doc.indexes ?? []) {
        if (typeof index.oid === 'number' && typeof index.relid === 'number') indexOwners.set(index.oid, index.relid);
    }
    return { relations, indexOwners };
}

/** One `ServerStore` handle exposed as the engine's narrow storage interface. */
export function storageFor(store: ServerStore): Storage {
    /** The durable catalog state per database, the source of shard routing. */
    const groups = new Map<string, CatalogGroups>();
    /** Live index-oid to relation-oid routing, kept in step with `groups`. */
    const indexOwners = new Map<string, Map<number, number>>();
    /** Shard ids are stable per group; the hex encoding stays cached. */
    const shardIds = new Map<string, string>();
    /**
     * 已提交的整表行缓存，最近使用的排最后。一次语句解析上千行 JSON 的开销
     * 远高于复制一份 Map，而语句之间只要没有提交，解码结果就一直有效。
     */
    const relationCache = new Map<string, Map<string, SqlValue[]>>();
    /** 缓存的关系数量上限，避免把整个数据目录都驻留在内存里。 */
    const RELATION_CACHE_LIMIT = 8;
    /** 超过这个行数的关系不做缓存，内存占用优先于读加速。 */
    const RELATION_CACHE_ROWS = 50_000;

    function shardId(db: string, relOid: number): string {
        const key = `${db}\u0000${relOid}`;
        const known = shardIds.get(key);
        if (known !== undefined) return known;
        const id = shardIdFor(db, relOid);
        shardIds.set(key, id);
        return id;
    }

    function primaryScan(namespace: string, limit = 0): StoredRow[] {
        return readFlatRows(store.scanFlat(namespace, EMPTY, null, null, limit));
    }

    function loadGroups(): void {
        groups.clear();
        indexOwners.clear();
        const cluster = primaryScan(CLUSTER_NAMESPACE).find((row) => decoder.decode(row.key) === CLUSTER_KEY);
        if (!cluster) return;
        const doc = JSON.parse(decoder.decode(cluster.value)) as { databases?: { datname?: unknown }[] };
        for (const database of doc.databases ?? []) {
            if (typeof database.datname !== 'string') continue;
            const catalog = primaryScan(databasePrefix(database.datname) + CATALOG_NAMESPACE, 1).find((row) => decoder.decode(row.key) === CATALOG_KEY);
            if (catalog) {
                const entry = catalogGroups(catalog.value);
                groups.set(database.datname, entry);
                indexOwners.set(database.datname, new Map(entry.indexOwners));
            }
        }
    }

    /** Copies every table group still living in the primary shard into its own. */
    function migrateFromSingleShard(): void {
        for (const [db, entry] of groups) {
            const flip: ServerStoreChange[] = [];
            for (const relOid of entry.relations) {
                const puts: ServerStoreChange[] = [];
                const tails = [
                    `${DATA_NAMESPACE_PREFIX}${relOid}`,
                    ...[...entry.indexOwners].filter(([, owner]) => owner === relOid).map(([indexOid]) => `${INDEX_NAMESPACE_PREFIX}${indexOid}`),
                ];
                for (const tail of tails) {
                    const namespace = databasePrefix(db) + tail;
                    for (const row of primaryScan(namespace)) {
                        puts.push({ kind: 'put', namespace, key: Buffer.from(row.key), value: Buffer.from(row.value) });
                        flip.push({ kind: 'delete', namespace, key: Buffer.from(row.key) });
                    }
                }
                if (puts.length > 0) store.commitShard(shardId(db, relOid), puts);
            }
            // The flip is one atomic primary commit: before it the old layout
            // is authoritative, after it the copied groups are.
            if (flip.length > 0) store.commitChanges(flip);
        }
    }

    /** Deletes shard directories no durable catalog references. */
    function sweepOrphanShards(): void {
        const referenced = new Set<string>();
        for (const [db, entry] of groups) {
            for (const relOid of entry.relations) referenced.add(shardId(db, relOid));
        }
        for (const id of store.listShards()) {
            if (!referenced.has(id)) store.dropShard(id);
        }
    }

    loadGroups();
    migrateFromSingleShard();
    sweepOrphanShards();

    function routeNamespace(namespace: string, owners: Map<string, Map<number, number>>): string {
        const route = parseRoute(namespace);
        if (route.db === null) return '';
        if (route.kind === 'data' || route.kind === 'rowid') return shardId(route.db, route.oid);
        if (route.kind === 'index') {
            const owner = owners.get(route.db)?.get(route.oid);
            // An index the catalogs never learned has no group of its own and
            // no rows anywhere: it reads and writes through the primary, which
            // stays empty for it. `cloneDatabase` relies on this when it probes
            // `pg_index.<oid>` for every recorded oid, tables included.
            if (owner === undefined) return '';
            return shardId(route.db, owner);
        }
        return '';
    }

    return {
        scan(
            namespace: string,
            prefix?: Uint8Array,
            after?: Uint8Array | null,
            before?: Uint8Array | null,
            limit?: number,
        ): StoredRow[] {
            const target = routeNamespace(namespace, indexOwners);
            // 扁平传输：整段结果一次跨边界，行是零拷贝视图。千行级关系加载
            // 付的是每行对象加两次 `Buffer` 拷贝的成本，这里一次压掉。
            const payload =
                target === ''
                    ? store.scanFlat(
                          namespace,
                          prefix === undefined ? EMPTY : Buffer.from(prefix),
                          after === undefined || after === null ? null : Buffer.from(after),
                          before === undefined || before === null ? null : Buffer.from(before),
                          limit ?? 0,
                      )
                    : store.scanShardFlat(
                          target,
                          namespace,
                          prefix === undefined ? EMPTY : Buffer.from(prefix),
                          after === undefined || after === null ? null : Buffer.from(after),
                          before === undefined || before === null ? null : Buffer.from(before),
                          limit ?? 0,
                      );
            return readFlatRows(payload);
        },
        cachedRelation(namespace: string): Map<string, SqlValue[]> | undefined {
            const cached = relationCache.get(namespace);
            if (cached === undefined) return undefined;
            // 命中即刷新 LRU 顺序。
            relationCache.delete(namespace);
            relationCache.set(namespace, cached);
            return cached;
        },
        rememberRelation(namespace: string, rows: Map<string, SqlValue[]>): void {
            if (rows.size > RELATION_CACHE_ROWS) return;
            relationCache.delete(namespace);
            relationCache.set(namespace, rows);
            while (relationCache.size > RELATION_CACHE_LIMIT) {
                const oldest = relationCache.keys().next().value;
                if (oldest === undefined) break;
                relationCache.delete(oldest);
            }
        },
        commitChanges(changes: StoredChange[]): void {
            // 提交会改变已提交状态，先失效缓存再接写入，避免中途失败留下旧值。
            for (const change of changes) relationCache.delete(change.namespace);
            const native: ServerStoreChange[] = changes.map((change) => ({
                kind: change.kind,
                namespace: change.namespace,
                key: Buffer.from(change.key),
                ...(change.value === undefined ? {} : { value: Buffer.from(change.value) }),
            }));

            // Catalog rows inside the batch decide the commit order and the
            // index routing. A removal (dropped relation, dropped index, gone
            // database) makes the catalog the commit point; anything else
            // commits the data groups first.
            let removal = false;
            const fresh = new Map<string, CatalogGroups>();
            for (const change of changes) {
                const route = parseRoute(change.namespace);
                if (route.db === null || change.namespace !== databasePrefix(route.db) + CATALOG_NAMESPACE) continue;
                if (change.kind === 'delete') {
                    removal = true;
                    fresh.set(route.db, { relations: new Set(), indexOwners: new Map() });
                    continue;
                }
                if (change.value === undefined || decoder.decode(change.key) !== CATALOG_KEY) continue;
                const parsed = catalogGroups(change.value);
                const previous = groups.get(route.db);
                if (previous) {
                    for (const relOid of previous.relations) {
                        if (!parsed.relations.has(relOid)) removal = true;
                    }
                    for (const indexOid of previous.indexOwners.keys()) {
                        if (!parsed.indexOwners.has(indexOid)) removal = true;
                    }
                }
                fresh.set(route.db, parsed);
            }

            // Index routing for this batch sees both catalogs: entries for a
            // brand-new index only exist in the new one, deletes of a dropped
            // index only resolve through the old one. The live map keeps only
            // what the new catalog declares.
            let owners = indexOwners;
            if (fresh.size > 0) {
                owners = new Map(indexOwners);
                for (const [db, entry] of fresh) {
                    const merged = new Map(owners.get(db) ?? []);
                    for (const [indexOid, owner] of entry.indexOwners) merged.set(indexOid, owner);
                    owners.set(db, merged);
                }
                for (const [db, entry] of fresh) {
                    groups.set(db, entry);
                    indexOwners.set(db, new Map(entry.indexOwners));
                }
            }

            const buckets = new Map<string, ServerStoreChange[]>();
            for (const change of native) {
                const target = routeNamespace(change.namespace, owners);
                const bucket = buckets.get(target);
                if (bucket) bucket.push(change);
                else buckets.set(target, [change]);
            }
            const groupIds = [...buckets.keys()].filter((id) => id !== '').sort();
            const order = removal ? ['', ...groupIds] : [...groupIds, ''];
            for (const id of order) {
                const bucket = buckets.get(id);
                if (bucket === undefined || bucket.length === 0) continue;
                if (id === '') store.commitChanges(bucket);
                else store.commitShard(id, bucket);
            }
        },
    };
}

/** Namespace prefix that isolates one database inside the shared store. */
export function databasePrefix(name: string): string {
    return `db:${name}:`;
}

/**
 * One namespace inside one database's slice.
 *
 * The cluster directory is shared by every database, so it stays unprefixed;
 * prefixing it would strand `ALTER ROLE` and `CREATE DATABASE` changes under
 * the session's database and lose them on the next start.
 */
function scopeNamespace(prefix: string, namespace: string): string {
    return namespace === CLUSTER_NAMESPACE ? namespace : prefix + namespace;
}

/** One database's slice of the shared store, addressed by the `db:<name>:` prefix. */
export function scopedStorage(storage: Storage, prefix: string): Storage {
    return {
        scan(
            namespace: string,
            scanPrefix?: Uint8Array,
            after?: Uint8Array | null,
            before?: Uint8Array | null,
            limit?: number,
        ): StoredRow[] {
            return storage.scan(scopeNamespace(prefix, namespace), scanPrefix, after, before, limit);
        },
        commitChanges(changes: StoredChange[]): void {
            storage.commitChanges(
                changes.map((change) => ({ ...change, namespace: scopeNamespace(prefix, change.namespace) })),
            );
        },
        cachedRelation(namespace: string): Map<string, SqlValue[]> | undefined {
            return storage.cachedRelation?.(scopeNamespace(prefix, namespace));
        },
        rememberRelation(namespace: string, rows: Map<string, SqlValue[]>): void {
            storage.rememberRelation?.(scopeNamespace(prefix, namespace), rows);
        },
    };
}

/** Relation oids recorded in one database's catalog, in document order. */
function relationOids(storage: Storage): number[] {
    const row = storage.scan(CATALOG_NAMESPACE).find((candidate) => decoder.decode(candidate.key) === CATALOG_KEY);
    if (!row) return [];
    const doc = JSON.parse(decoder.decode(row.value)) as {
        relations?: { oid?: unknown }[];
        indexes?: { oid?: unknown }[];
    };
    const oids: number[] = [];
    for (const relation of doc.relations ?? []) {
        if (typeof relation.oid === 'number') oids.push(relation.oid);
    }
    for (const index of doc.indexes ?? []) {
        if (typeof index.oid === 'number') oids.push(index.oid);
    }
    return oids;
}

/** Every namespace one database can own, derived from its catalog. */
function databaseNamespaces(storage: Storage): string[] {
    return [
        CATALOG_NAMESPACE,
        SEQUENCE_STATE_NAMESPACE,
        ...relationOids(storage).flatMap((oid) => [`${DATA_NAMESPACE_PREFIX}${oid}`, `${INDEX_NAMESPACE_PREFIX}${oid}`]),
    ];
}

/** Rows that clone one database's durable state into another's namespace. */
export function cloneDatabase(storage: Storage, source: string, target: string): StoredChange[] {
    const from = scopedStorage(storage, databasePrefix(source));
    const to = databasePrefix(target);
    const changes: StoredChange[] = [];
    for (const namespace of new Set(databaseNamespaces(from))) {
        for (const row of from.scan(namespace)) {
            changes.push({ kind: 'put', namespace: `${to}${namespace}`, key: row.key, value: row.value });
        }
    }
    return changes;
}

/** Deletes every durable row of one database, leaving the cluster row to the caller. */
export function purgeDatabase(storage: Storage, name: string): StoredChange[] {
    const scoped = scopedStorage(storage, databasePrefix(name));
    const prefix = databasePrefix(name);
    const changes: StoredChange[] = [];
    for (const namespace of new Set(databaseNamespaces(scoped))) {
        for (const row of scoped.scan(namespace)) {
            changes.push({ kind: 'delete', namespace: `${prefix}${namespace}`, key: row.key, value: undefined });
        }
    }
    return changes;
}
