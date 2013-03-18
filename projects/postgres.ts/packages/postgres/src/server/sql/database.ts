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
export class Database {
    readonly catalog: CatalogDoc;
    private readonly storage: Storage;
    private readonly tables = new Map<number, Map<string, SqlValue[]>>();
    private readonly writes = new Map<number, Map<string, SqlValue[] | null>>();
    private catalogDirty = false;

    private constructor(storage: Storage, catalog: CatalogDoc) {
        this.storage = storage;
        this.catalog = catalog;
    }

    static open(storage: Storage): Database {
        return new Database(storage, loadCatalog(storage));
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

    /** Sends one statement's whole diff through the single commit boundary. */
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
    }
}
