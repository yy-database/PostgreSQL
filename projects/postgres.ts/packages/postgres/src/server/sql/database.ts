/** Storage adapter and the per-message catalog/table working set. */

import { ServerError } from '../errors.ts';
import { type CatalogDoc, assertCatalog, emptyCatalog } from './catalog.ts';
import type { SqlValue } from './types.ts';

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
    scan(namespace: string): StoredRow[];
    commitChanges(changes: StoredChange[]): void;
}

const CATALOG_NAMESPACE = 'pg_catalog';
const CATALOG_KEY = 'catalog';
const DATA_NAMESPACE_PREFIX = 'pg_data.';
/** Non-transactional `nextval` high-water marks, one key per sequence oid. */
const SEQUENCE_STATE_NAMESPACE = 'pg_sequence_state';

export function dataNamespace(relOid: number): string {
    return `${DATA_NAMESPACE_PREFIX}${relOid}`;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function encode(text: string): Uint8Array {
    return encoder.encode(text);
}

function decode(bytes: Uint8Array): string {
    return decoder.decode(bytes);
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
    /** `lastval()` in this session, or `null` when no sequence was advanced. */
    lastValue: number | null;
    /** `currval()` per sequence oid in this session. */
    lastBySequence: Map<number, number>;
}

export function createSessionRuntime(): SessionRuntime {
    return { lastValue: null, lastBySequence: new Map() };
}

export class Database {
    catalog: CatalogDoc;
    readonly session: SessionRuntime;
    private readonly storage: Storage;
    private readonly tables = new Map<number, Map<string, SqlValue[]>>();
    private readonly writes = new Map<number, Map<string, SqlValue[] | null>>();
    private catalogDirty = false;

    private constructor(storage: Storage, catalog: CatalogDoc, session: SessionRuntime) {
        this.storage = storage;
        this.catalog = catalog;
        this.session = session;
    }

    static open(storage: Storage, session: SessionRuntime = createSessionRuntime()): Database {
        const catalog = loadCatalog(storage);
        // `nextval` survives statement rollback and separate sessions, so the
        // journal below is authoritative whenever it is ahead of the catalog.
        for (const stored of storage.scan(SEQUENCE_STATE_NAMESPACE)) {
            const oid = Number(decode(stored.key));
            const value = Number(decode(stored.value));
            const sequence = catalog.sequences.find((candidate) => candidate.oid === oid);
            if (sequence && Number.isFinite(value) && value > sequence.lastValue) sequence.lastValue = value;
        }
        return new Database(storage, catalog, session);
    }

    /** Copies the working set for `SAVEPOINT`/`ROLLBACK TO`; shares row arrays. */
    clone(): Database {
        const copy = new Database(this.storage, structuredClone(this.catalog), this.session);
        for (const [relOid, rows] of this.tables) copy.tables.set(relOid, new Map(rows));
        for (const [relOid, rows] of this.writes) copy.writes.set(relOid, new Map(rows));
        copy.catalogDirty = this.catalogDirty;
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
        this.table(relOid).set(key, values);
        this.changesFor(relOid).set(key, values);
    }

    deleteRow(relOid: number, key: string): void {
        if (!this.table(relOid).delete(key)) return;
        this.changesFor(relOid).set(key, null);
    }

    markCatalogDirty(): void {
        this.catalogDirty = true;
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
        this.tables.clear();
        for (const [relOid, rows] of other.tables) this.tables.set(relOid, rows);
        this.writes.clear();
        for (const [relOid, rows] of other.writes) this.writes.set(relOid, rows);
        this.catalogDirty = other.catalogDirty;
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
                    value: values === null ? undefined : encode(JSON.stringify(values)),
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
        if (changes.length === 0) return;
        try {
            this.storage.commitChanges(changes);
        } catch (error) {
            throw new ServerError('58030', 'could not write to the data directory', error instanceof Error ? error.message : String(error));
        }
        this.writes.clear();
        this.catalogDirty = false;
    }
}
