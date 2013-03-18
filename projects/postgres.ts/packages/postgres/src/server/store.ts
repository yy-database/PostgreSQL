/** Adapts the native `ServerStore` to the engine's `Storage` surface. */

import type { ServerStore } from '../native.ts';
import type { Storage, StoredChange, StoredRow } from './sql/database.ts';

const EMPTY = Buffer.alloc(0);

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
