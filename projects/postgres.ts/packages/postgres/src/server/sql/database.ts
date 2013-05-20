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

export function dataNamespace(relOid: number): string {
    return `${DATA_NAMESPACE_PREFIX}${relOid}`;
}

export function indexNamespace(indexOid: number): string {
    return `${INDEX_NAMESPACE_PREFIX}${indexOid}`;
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
    const rows = storage.scan(CATALOG_NAMESPACE);
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
}

export function createSessionRuntime(user = 'postgres', database = 'postgres'): SessionRuntime {
    return { user, database, lastValue: null, lastBySequence: new Map() };
}

export class Database {
    catalog: CatalogDoc;
    readonly session: SessionRuntime;
    /** Cluster store shared with every session on the store. */
    readonly cluster: ClusterStore;
    /** This message's working copy of `pg_roles`, persisted on commit. */
    roles: ClusterRole[];
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
    /** Index access paths the executor really consumed in the current statement. */
    readonly scanStats: IndexScanStat[] = [];
    private catalogDirty = false;
    private rolesDirty = false;
    private clusterDirty = false;

    private constructor(storage: Storage, catalog: CatalogDoc, session: SessionRuntime, cluster: ClusterStore) {
        this.storage = storage;
        this.catalog = catalog;
        this.session = session;
        this.cluster = cluster;
        this.roles = structuredClone(cluster.doc.roles);
        for (const row of cluster.doc.databases) this.databaseAcls.set(row.datname, row.datacl);
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
        for (const stored of storage.scan(SEQUENCE_STATE_NAMESPACE)) {
            const oid = Number(decode(stored.key));
            const value = Number(decode(stored.value));
            const sequence = catalog.sequences.find((candidate) => candidate.oid === oid);
            if (sequence && Number.isFinite(value) && value > sequence.lastValue) sequence.lastValue = value;
        }
        return new Database(storage, catalog, session, cluster);
    }

    /** Copies the working set for `SAVEPOINT`/`ROLLBACK TO`; shares row arrays. */
    clone(): Database {
        const copy = new Database(this.storage, structuredClone(this.catalog), this.session, this.cluster);
        copy.onWrite = this.onWrite;
        copy.readOnly = this.readOnly;
        copy.roles = structuredClone(this.roles);
        copy.databaseAcls = new Map(this.databaseAcls);
        for (const [relOid, rows] of this.tables) copy.tables.set(relOid, new Map(rows));
        for (const [relOid, rows] of this.writes) copy.writes.set(relOid, new Map(rows));
        for (const [indexOid, rows] of this.indexWrites) copy.indexWrites.set(indexOid, new Map(rows));
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
        if (!this.rolesDirty) this.roles = structuredClone(this.cluster.doc.roles);
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

    nextRowId(relOid: number): string {
        const key = String(relOid);
        const next = this.catalog.nextRowId[key] ?? 1;
        this.catalog.nextRowId[key] = next + 1;
        this.catalogDirty = true;
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
    ): { key: string; values: SqlValue[] }[] {
        const namespace = indexNamespace(indexOid);
        const pending = this.indexWrites.get(indexOid);
        const prefixText = prefix === null ? null : encodeKeyBytes(prefix);
        const lower = after === null ? null : encodeKeyBytes(after);
        const upper = before === null ? null : encodeKeyBytes(before);
        const rows = new Map<string, SqlValue[]>();
        for (const stored of this.storage.scan(namespace, prefix ?? undefined, after, before, 0)) {
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
        return [...rows.entries()]
            .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
            .map(([key, values]) => ({ key, values }));
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
        this.roles = structuredClone(other.roles);
        this.databaseAcls = new Map(other.databaseAcls);
        this.tables.clear();
        for (const [relOid, rows] of other.tables) this.tables.set(relOid, rows);
        this.writes.clear();
        for (const [relOid, rows] of other.writes) this.writes.set(relOid, rows);
        this.indexWrites.clear();
        for (const [indexOid, rows] of other.indexWrites) this.indexWrites.set(indexOid, rows);
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
        this.catalogDirty = false;
        this.rolesDirty = false;
        this.clusterDirty = false;
    }
}
