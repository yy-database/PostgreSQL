/** Adapts the native `ServerStore` to the engine's `Storage` surface. */

import type { ServerStore } from '../native.ts';
import {
    CATALOG_KEY,
    CATALOG_NAMESPACE,
    DATA_NAMESPACE_PREFIX,
    SEQUENCE_STATE_NAMESPACE,
    type Storage,
    type StoredChange,
    type StoredRow,
} from './sql/database.ts';

const EMPTY = Buffer.alloc(0);
const decoder = new TextDecoder();

/** One `ServerStore` handle exposed as the engine's narrow storage interface. */
export function storageFor(store: ServerStore): Storage {
    return {
        scan(namespace: string): StoredRow[] {
            return store.scan(namespace, EMPTY, null, null, 0);
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
        scan(namespace: string): StoredRow[] {
            return storage.scan(prefix + namespace);
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
    const doc = JSON.parse(decoder.decode(row.value)) as { relations?: { oid?: unknown }[] };
    const oids: number[] = [];
    for (const relation of doc.relations ?? []) {
        if (typeof relation.oid === 'number') oids.push(relation.oid);
    }
    return oids;
}

/** Every namespace one database can own, derived from its catalog. */
function databaseNamespaces(storage: Storage): string[] {
    return [
        CATALOG_NAMESPACE,
        SEQUENCE_STATE_NAMESPACE,
        ...relationOids(storage).map((oid) => `${DATA_NAMESPACE_PREFIX}${oid}`),
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
