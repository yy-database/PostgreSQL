/** Storage adapter and the per-message catalog/table working set. */

import { ServerError } from '../errors.ts';
import { type CatalogDoc, type CursorViewRow, assertCatalog, emptyCatalog } from './catalog.ts';
import { type ClusterDatabase, type ClusterRole, ClusterStore } from './cluster.ts';
import type { SqlValue } from './types.ts';

/** Keeps `NaN` and the infinities intact, since JSON would turn them into null. */
function serializeRow(values: SqlValue[]): string {
    return JSON.stringify(values, (_key, value) => (typeof value === 'number' && !Number.isFinite(value) ? String(value) : value));
}

export interface StoredRow {
    key: Uint8Array;
    value: Uint8Array;
}

export interface StoredChange {
    kind: 'put' | 'delete';
    namespace: string;
    key: Uint8Array;
    value: Uint8Array | undefined;
}

/** The native `ServerStore` surface the engine writes through. */
export interface Storage {
    scan(
        namespace: string,
        prefix?: Uint8Array,
        after?: Uint8Array | null,
        before?: Uint8Array | null,
        limit?: number,
    ): StoredRow[];
    commitChanges(changes: StoredChange[]): void;
}

export const CATALOG_NAMESPACE = 'pg_catalog';
export const CATALOG_KEY = 'catalog';
export const DATA_NAMESPACE_PREFIX = 'pg_data.';
/** Non-transactional `nextval` high-water marks, one key per sequence oid. */
export const SEQUENCE_STATE_NAMESPACE = 'pg_sequence_state';
/** Secondary index entries, one namespace per index oid. */
export const INDEX_NAMESPACE_PREFIX = 'pg_index.';
/** Row-id high-water marks, one namespace per relation, beside the relation's rows. */
export const ROWID_NAMESPACE_PREFIX = 'pg_rowid.';

export function dataNamespace(relOid: number): string {
    return `${DATA_NAMESPACE_PREFIX}${relOid}`;
}

export function indexNamespace(indexOid: number): string {
    return `${INDEX_NAMESPACE_PREFIX}${indexOid}`;
}

export function rowIdNamespace(relOid: number): string {
    return `${ROWID_NAMESPACE_PREFIX}${relOid}`;
}

/** One index access path consumed by the current statement, for `EXPLAIN ANALYZE`. */
export interface IndexScanStat {
    relation: string;
    indexOid: number;
    index: string;
    indexCond: string;
    keysScanned: number;
    rowsFetched: number;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function encode(text: string): Uint8Array {
    return encoder.encode(text);
}

function decode(bytes: Uint8Array): string {
    return decoder.decode(bytes);
}

/** Lossless byte <-> string mapping: latin1 code units compare like raw bytes. */
function encodeKeyBytes(bytes: Uint8Array): string {
    return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('latin1');
}

function decodeKeyBytes(text: string): Uint8Array {
    return Buffer.from(text, 'latin1');
}

/** Loads the catalog, or returns an empty one on a fresh data directory. */
export function loadCatalog(storage: Storage): CatalogDoc {
    // 目录命名空间只存 `CATALOG_KEY` 一行，取一行就够，不必让原生扫描走完整段。
    const rows = storage.scan(CATALOG_NAMESPACE, undefined, undefined, undefined, 1);
    const row = rows.find((candidate) => decode(candidate.key) === CATALOG_KEY);
    if (!row) return emptyCatalog();
    return assertCatalog(JSON.parse(decode(row.value)) as unknown);
}

/**
 * One message's working copy of the catalog plus the tables it touched.
 *
 * Reads load a table on first use, writes mutate the in-memory copy and are
 * recorded as a diff. [`Database.commit`] sends every diff plus the catalog in
 * one `commitChanges` call, so one message is either fully durable or not at
 * all.
 */
/** Per-session state that outlives a single statement. */
export interface SessionRuntime {
    /** Role that opened this session, used by privilege checks. */
    user: string;
    /** Database this session is connected to, used by ownership checks. */
    database: string;
    /** `lastval()` in this session, or `null` when no sequence was advanced. */
    lastValue: number | null;
    /** `currval()` per sequence oid in this session. */
    lastBySequence: Map<number, number>;
    /** Live `pg_cursors` rows for the portals this session has open. */
    pgCursors?: () => CursorViewRow[];
    /** Channels this session currently listens on, read by `pg_listening_channels()`. */
    pgListeningChannels?: () => string[];
    /** Session value of `password_encryption`, read when a role password is stored. */
    passwordEncryption?: () => string;
}

export function createSessionRuntime(user = 'postgres', database = 'postgres'): SessionRuntime {
    return { user, database, lastValue: null, lastBySequence: new Map() };
}

export class Database {
    catalog: CatalogDoc;
    readonly session: SessionRuntime;
    /** Cluster store shared with every session on the store. */
    readonly cluster: ClusterStore;
    /**
     * Called before a statement changes an existing row, so the session can take
     * the row lock that keeps two writers from touching it at the same time.
     */
    onWrite?: (relOid: number, key: string, operation: 'update' | 'delete') => void;
    /** `true` while the owning transaction is `READ ONLY`. */
    readOnly = false;
    /** This message's working copy of `datacl`, keyed by database name. */
    private databaseAcls = new Map<string, string | null>();
    private readonly storage: Storage;
    private readonly tables = new Map<number, Map<string, SqlValue[]>>();
    private readonly writes = new Map<number, Map<string, SqlValue[] | null>>();
    /** Index entries written by this message, keyed by index oid then encoded key. */
    private readonly indexWrites = new Map<number, Map<string, SqlValue[] | null>>();
    /** Row-id counters loaded for this copy, so one scan serves every insert. */
    private readonly rowIdCounters = new Map<number, number>();
    /** Row-id counters this message advanced, persisted beside the relation's rows. */
    private readonly rowIdWrites = new Map<number, number>();
    /** Index access paths the executor really consumed in the current statement. */
    readonly scanStats: IndexScanStat[] = [];
    private catalogDirty = false;
    private rolesDirty = false;
    private clusterDirty = false;
    /** `pg_roles` working copy; shared with the cluster directory until a write clones it. */
    private rolesValue: ClusterRole[] = [];
    private rolesShared = false;

    private constructor(storage: Storage, catalog: CatalogDoc, session: SessionRuntime, cluster: ClusterStore) {
        this.storage = storage;
        this.catalog = catalog;
        this.session = session;
        this.cluster = cluster;
        // 角色表在绝大多数语句里只读，先共享集群目录那一份，写时再复制。
        this.rolesValue = cluster.doc.roles;
        this.rolesShared = true;
        for (const row of cluster.doc.databases) this.databaseAcls.set(row.datname, row.datacl);
    }

    /** This message's view of `pg_roles`; persisted on commit only when it was written. */
    get roles(): ClusterRole[] {
        return this.rolesValue;
    }

    set roles(value: ClusterRole[]) {
        this.rolesValue = value;
        this.rolesShared = false;
    }

    /**
     * Writable `pg_roles` working copy.
     *
     * `roles` aliases the cluster directory's array, so a write must go through
     * here first: the first write clones it, later writes reuse the copy. Without
     * this, `ALTER ROLE` would mutate rows other sessions still read and would
     * bypass both the commit batch and rollback.
     */
    mutableRoles(): ClusterRole[] {
        if (this.rolesShared) {
            this.rolesValue = structuredClone(this.rolesValue);
            this.rolesShared = false;
        }
        return this.rolesValue;
    }

    /**
     * Takes another working copy's roles into this one.
     *
     * A shared array stays shared: both sides copy before writing. An owned array
     * is the other copy's snapshot, so it must be cloned to keep `ROLLBACK TO`
     * from seeing later writes.
     */
    private adoptRoles(other: Database): void {
        this.rolesValue = other.rolesShared ? other.rolesValue : structuredClone(other.rolesValue);
        this.rolesShared = other.rolesShared;
    }

    /** Cluster-wide `pg_database` rows, with this message's `datacl` changes layered on top. */
    get databases(): ClusterDatabase[] {
        return this.cluster.doc.databases.map((row) => {
            const acl = this.databaseAcls.get(row.datname);
            return acl === undefined || acl === row.datacl ? row : { ...row, datacl: acl };
        });
    }

    /** `datacl` of one database as this message currently sees it. */
    databaseAcl(name: string): string | null | undefined {
        if (this.databaseAcls.has(name)) return this.databaseAcls.get(name);
        return this.cluster.doc.databases.find((row) => row.datname === name)?.datacl;
    }

    /** Records a `datacl` change in the working copy so a rollback can drop it. */
    setDatabaseAcl(name: string, text: string | null): void {
        this.databaseAcls.set(name, text);
        this.clusterDirty = true;
    }

    static open(storage: Storage, cluster: ClusterStore, session: SessionRuntime = createSessionRuntime()): Database {
        const catalog = loadCatalog(storage);
        // `nextval` survives statement rollback and separate sessions, so the
        // journal below is authoritative whenever it is ahead of the catalog.
        // 没有序列时该命名空间必然为空，省掉一次原生扫描。
        if (catalog.sequences.length > 0) {
            for (const stored of storage.scan(SEQUENCE_STATE_NAMESPACE)) {
                const oid = Number(decode(stored.key));
                const value = Number(decode(stored.value));
                const sequence = catalog.sequences.find((candidate) => candidate.oid === oid);
                if (sequence && Number.isFinite(value) && value > sequence.lastValue) sequence.lastValue = value;
            }
        }
        return new Database(storage, catalog, session, cluster);
    }

    /** Copies the working set for `SAVEPOINT`/`ROLLBACK TO`; shares row arrays. */
    clone(): Database {
        const copy = new Database(this.storage, structuredClone(this.catalog), this.session, this.cluster);
        copy.onWrite = this.onWrite;
        copy.readOnly = this.readOnly;
        copy.adoptRoles(this);
        copy.databaseAcls = new Map(this.databaseAcls);
        for (const [relOid, rows] of this.tables) copy.tables.set(relOid, new Map(rows));
        for (const [relOid, rows] of this.writes) copy.writes.set(relOid, new Map(rows));
        for (const [indexOid, rows] of this.indexWrites) copy.indexWrites.set(indexOid, new Map(rows));
        for (const [relOid, next] of this.rowIdCounters) copy.rowIdCounters.set(relOid, next);
        for (const [relOid, next] of this.rowIdWrites) copy.rowIdWrites.set(relOid, next);
        copy.catalogDirty = this.catalogDirty;
        copy.rolesDirty = this.rolesDirty;
        copy.clusterDirty = this.clusterDirty;
        return copy;
    }

    /** Rows of one user relation keyed by row id. */
    table(relOid: number): Map<string, SqlValue[]> {
        const cached = this.tables.get(relOid);
        if (cached) return cached;
        const rows = new Map<string, SqlValue[]>();
        for (const stored of this.storage.scan(dataNamespace(relOid))) {
            rows.set(decode(stored.key), JSON.parse(decode(stored.value)) as SqlValue[]);
        }
        this.tables.set(relOid, rows);
        return rows;
    }

    /**
     * Re-reads committed state for everything this transaction has not written.
     *
     * `READ COMMITTED` calls this before every statement, so a transaction sees
     * rows other sessions committed after its own `BEGIN`. The snapshot levels
     * never call it: their working copy is the snapshot.
     */
    refreshCommitted(): void {
        if (!this.catalogDirty) this.catalog = loadCatalog(this.storage);
        if (!this.rolesDirty) {
            this.rolesValue = this.cluster.doc.roles;
            this.rolesShared = true;
        }
        if (!this.clusterDirty) {
            this.databaseAcls = new Map();
            for (const row of this.cluster.doc.databases) this.databaseAcls.set(row.datname, row.datacl);
        }
        for (const relOid of [...this.tables.keys()]) {
            if (!this.writes.has(relOid)) this.tables.delete(relOid);
        }
    }

    /** Rows this transaction has changed, used to publish their versions on commit. */
    writtenRows(): { relOid: number; key: string }[] {
        const written: { relOid: number; key: string }[] = [];
        for (const [relOid, rows] of this.writes) {
            for (const key of rows.keys()) written.push({ relOid, key });
        }
        return written;
    }

    /** Byte footprint of one relation's stored rows, keys included. */
    relationBytes(relOid: number): number {
        let total = 0;
        for (const stored of this.storage.scan(dataNamespace(relOid))) total += stored.key.byteLength + stored.value.byteLength;
        return total;
    }

    /** Byte footprint of the catalog plus every user relation. */
    storeBytes(): number {
        let total = 0;
        for (const stored of this.storage.scan(CATALOG_NAMESPACE)) total += stored.key.byteLength + stored.value.byteLength;
        for (const relation of this.catalog.relations) total += this.relationBytes(relation.oid);
        return total;
    }

    /**
     * Hands out the next row id for one relation.
     *
     * The high-water mark lives in `pg_rowid.<relOid>`, beside the relation's
     * rows, so a plain INSERT commits only that table group instead of
     * rewriting the catalog. A catalog written by an older release carries the
     * counter in `nextRowId`; the largest visible row id is the third floor, so
     * neither migration nor a deleted tail can hand out a key twice.
     */
    nextRowId(relOid: number): string {
        let next = this.rowIdCounters.get(relOid);
        if (next === undefined) {
            next = 1;
            const legacy = this.catalog.nextRowId[String(relOid)];
            if (typeof legacy === 'number' && Number.isSafeInteger(legacy) && legacy > next) next = legacy;
            const stored = this.storage.scan(rowIdNamespace(relOid)).find((row) => decode(row.key) === 'next');
            if (stored !== undefined) {
                const value = Number(decode(stored.value));
                if (Number.isSafeInteger(value) && value > next) next = value;
            }
            for (const rowId of this.table(relOid).keys()) {
                const value = Number(rowId);
                if (Number.isSafeInteger(value) && value + 1 > next) next = value + 1;
            }
            this.rowIdCounters.set(relOid, next);
        }
        this.rowIdCounters.set(relOid, next + 1);
        this.rowIdWrites.set(relOid, next + 1);
        return String(next).padStart(10, '0');
    }

    insertRow(relOid: number, values: SqlValue[]): string {
        const key = this.nextRowId(relOid);
        this.table(relOid).set(key, values);
        this.changesFor(relOid).set(key, values);
        return key;
    }

    updateRow(relOid: number, key: string, values: SqlValue[]): void {
        this.onWrite?.(relOid, key, 'update');
        this.table(relOid).set(key, values);
        this.changesFor(relOid).set(key, values);
    }

    deleteRow(relOid: number, key: string): void {
        if (!this.table(relOid).has(key)) return;
        this.onWrite?.(relOid, key, 'delete');
        if (!this.table(relOid).delete(key)) return;
        this.changesFor(relOid).set(key, null);
    }

    /**
     * Reads one index slice: committed entries from storage plus this message's
     * pending writes, so a statement sees uncommitted rows of its own transaction.
     * Keys are latin1 strings, whose code-unit order is raw byte order.
     */
    scanIndex(
        indexOid: number,
        prefix: Uint8Array | null,
        after: Uint8Array | null,
        before: Uint8Array | null,
        limit = 0,
    ): { key: string; values: SqlValue[] }[] {
        const namespace = indexNamespace(indexOid);
        const pending = this.indexWrites.get(indexOid);
        // 没有未提交写入时，原生扫描本身就按键字节升序返回，且已按 `limit` 截断。
        // 此前无条件建 Map 再全量排序，纯属把已排好的结果重排一遍。
        if (!pending) {
            return this.storage.scan(namespace, prefix ?? undefined, after, before, limit).map((stored) => ({
                key: encodeKeyBytes(stored.key),
                values: JSON.parse(decode(stored.value)) as SqlValue[],
            }));
        }
        const prefixText = prefix === null ? null : encodeKeyBytes(prefix);
        const lower = after === null ? null : encodeKeyBytes(after);
        const upper = before === null ? null : encodeKeyBytes(before);
        const rows = new Map<string, SqlValue[]>();
        // 有未提交写入时先取全量再合并，避免限流截断尚未覆盖的键。
        for (const stored of this.storage.scan(namespace, prefix ?? undefined, after, before, pending ? 0 : limit)) {
            const key = encodeKeyBytes(stored.key);
            const change = pending?.get(key);
            if (change === null) continue;
            if (change !== undefined) {
                rows.set(key, change);
                continue;
            }
            rows.set(key, JSON.parse(decode(stored.value)) as SqlValue[]);
        }
        if (pending) {
            for (const [key, values] of pending) {
                if (values === null || rows.has(key)) continue;
                if (prefixText !== null && !key.startsWith(prefixText)) continue;
                if (lower !== null && !(key > lower)) continue;
                if (upper !== null && !(key < upper)) continue;
                rows.set(key, values);
            }
        }
        const entries = [...rows.entries()]
            .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
            .map(([key, values]) => ({ key, values }));
        return limit > 0 ? entries.slice(0, limit) : entries;
    }

    putIndexEntry(indexOid: number, key: string, values: SqlValue[]): void {
        let entries = this.indexWrites.get(indexOid);
        if (!entries) {
            entries = new Map();
            this.indexWrites.set(indexOid, entries);
        }
        entries.set(key, values);
    }

    deleteIndexEntry(indexOid: number, key: string): void {
        let entries = this.indexWrites.get(indexOid);
        if (!entries) {
            entries = new Map();
            this.indexWrites.set(indexOid, entries);
        }
        entries.set(key, null);
    }

    markCatalogDirty(): void {
        this.catalogDirty = true;
    }

    markRolesDirty(): void {
        this.rolesDirty = true;
    }

    private changesFor(relOid: number): Map<string, SqlValue[] | null> {
        const existing = this.writes.get(relOid);
        if (existing) return existing;
        const created = new Map<string, SqlValue[] | null>();
        this.writes.set(relOid, created);
        return created;
    }

    /** Replaces the working set with another snapshot, used by rollback. */
    restore(other: Database): void {
        this.catalog = other.catalog;
        this.adoptRoles(other);
        this.databaseAcls = new Map(other.databaseAcls);
        this.tables.clear();
        for (const [relOid, rows] of other.tables) this.tables.set(relOid, rows);
        this.writes.clear();
        for (const [relOid, rows] of other.writes) this.writes.set(relOid, rows);
        this.indexWrites.clear();
        for (const [indexOid, rows] of other.indexWrites) this.indexWrites.set(indexOid, rows);
        this.rowIdCounters.clear();
        for (const [relOid, next] of other.rowIdCounters) this.rowIdCounters.set(relOid, next);
        this.rowIdWrites.clear();
        for (const [relOid, next] of other.rowIdWrites) this.rowIdWrites.set(relOid, next);
        this.catalogDirty = other.catalogDirty;
        this.rolesDirty = other.rolesDirty;
        this.clusterDirty = other.clusterDirty;
        // Sequences are not transactional: a statement that fails still burns
        // the values it handed out, exactly like `nextval` in PostgreSQL.
        for (const sequence of this.catalog.sequences) {
            const handed = this.session.lastBySequence.get(sequence.oid);
            if (handed !== undefined && handed > sequence.lastValue) {
                sequence.lastValue = handed;
                this.catalogDirty = true;
            }
        }
    }

    /** Advances a sequence, remembering the value for `currval`/`lastval`. */
    nextSequence(sequenceOid: number): number {
        if (this.readOnly) throw new ServerError('25006', 'cannot execute nextval() in a read-only transaction');
        const sequence = this.catalog.sequences.find((candidate) => candidate.oid === sequenceOid);
        if (!sequence) throw new ServerError('55000', 'sequence does not exist');
        // A discarded working set (failed statement) must not rewind the
        // counter: the session's highest handed-out value acts as a floor.
        const handed = this.session.lastBySequence.get(sequenceOid);
        const base = handed === undefined ? sequence.lastValue : Math.max(sequence.lastValue, handed);
        sequence.lastValue = base + 1;
        this.catalogDirty = true;
        // Persist immediately: like PostgreSQL, a later rollback must not hand
        // this value out again.
        this.storage.commitChanges([
            { kind: 'put', namespace: SEQUENCE_STATE_NAMESPACE, key: encode(String(sequenceOid)), value: encode(String(sequence.lastValue)) },
        ]);
        this.session.lastValue = sequence.lastValue;
        this.session.lastBySequence.set(sequence.oid, sequence.lastValue);
        return sequence.lastValue;
    }

    /** Sends one transaction's whole diff through the single commit boundary. */
    commit(): void {
        const changes: StoredChange[] = [];
        for (const [relOid, rows] of this.writes) {
            for (const [key, values] of rows) {
                changes.push({
                    kind: values === null ? 'delete' : 'put',
                    namespace: dataNamespace(relOid),
                    key: encode(key),
                    value: values === null ? undefined : encode(serializeRow(values)),
                });
            }
        }
        for (const [indexOid, entries] of this.indexWrites) {
            for (const [key, values] of entries) {
                changes.push({
                    kind: values === null ? 'delete' : 'put',
                    namespace: indexNamespace(indexOid),
                    key: decodeKeyBytes(key),
                    value: values === null ? undefined : encode(serializeRow(values)),
                });
            }
        }
        for (const [relOid, next] of this.rowIdWrites) {
            changes.push({
                kind: 'put',
                namespace: rowIdNamespace(relOid),
                key: encode('next'),
                value: encode(String(next)),
            });
        }
        if (this.catalogDirty) {
            changes.push({
                kind: 'put',
                namespace: CATALOG_NAMESPACE,
                key: encode(CATALOG_KEY),
                value: encode(JSON.stringify(this.catalog)),
            });
        }
        if (this.rolesDirty) this.cluster.doc.roles = this.roles;
        if (this.clusterDirty) {
            for (const row of this.cluster.doc.databases) {
                if (!this.databaseAcls.has(row.datname)) continue;
                row.datacl = this.databaseAcls.get(row.datname) ?? null;
            }
        }
        if (this.rolesDirty || this.clusterDirty) changes.push(this.cluster.change());
        if (changes.length === 0) return;
        try {
            this.storage.commitChanges(changes);
        } catch (error) {
            throw new ServerError('58030', 'could not write to the data directory', error instanceof Error ? error.message : String(error));
        }
        this.writes.clear();
        this.indexWrites.clear();
        this.rowIdWrites.clear();
        this.catalogDirty = false;
        this.rolesDirty = false;
        this.clusterDirty = false;
    }
}
