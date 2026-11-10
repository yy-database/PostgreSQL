/** Adapts the native `ServerStore` to the engine's `Storage` surface. */

import type { ServerStore } from '../native.ts';
import {
    CATALOG_KEY,
    CATALOG_NAMESPACE,
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

/** One `ServerStore` handle exposed as the engine's narrow storage interface. */
export function storageFor(store: ServerStore): Storage {
    return {
        scan(
            namespace: string,
            prefix?: Uint8Array,
            after?: Uint8Array | null,
            before?: Uint8Array | null,
            limit?: number,
        ): StoredRow[] {
            // 扁平传输：整段结果一次跨边界，行是零拷贝视图。千行级关系加载
            // 付的是每行对象加两次 `Buffer` 拷贝的成本，这里一次压掉。
            return readFlatRows(
                store.scanFlat(
                    namespace,
                    prefix === undefined ? EMPTY : Buffer.from(prefix),
                    after === undefined || after === null ? null : Buffer.from(after),
                    before === undefined || before === null ? null : Buffer.from(before),
                    limit ?? 0,
                ),
            );
        },
        commitChanges(changes: StoredChange[]): void {
            store.commitChanges(
                changes.map((change) => ({
                    kind: change.kind,
                    namespace: change.namespace,
                    key: Buffer.from(change.key),
                    ...(change.value === undefined ? {} : { value: Buffer.from(change.value) }),
                })),
            );
        },
    };
}

/** Namespace prefix that isolates one database inside the shared store. */
export function databasePrefix(name: string): string {
    return `db:${name}:`;
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
            return storage.scan(prefix + namespace, scanPrefix, after, before, limit);
        },
        commitChanges(changes: StoredChange[]): void {
            storage.commitChanges(
                changes.map((change) => ({ ...change, namespace: prefix + change.namespace })),
            );
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
