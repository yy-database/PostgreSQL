/** Cluster-wide database directory shared by every session on one data directory. */

import { FIRST_USER_OID, POSTGRES_ROLE } from './catalog.ts';
import type { Storage, StoredChange } from './database.ts';

export const CLUSTER_NAMESPACE = 'pg_cluster';
export const CLUSTER_KEY = 'databases';
export const CLUSTER_VERSION = 1;

/** One `pg_database` row, stored in the cluster directory rather than per database. */
export interface ClusterDatabase {
    oid: number;
    datname: string;
    datdba: number;
    encoding: number;
    datlocprovider: string;
    datistemplate: boolean;
    datallowconn: boolean;
    datconnlimit: number;
    datfrozenxid: number;
    datminmxid: number;
    dattablespace: number;
    datcollate: string;
    datctype: string;
    daticulocale: string | null;
    daticurules: string | null;
    datcollversion: string | null;
    /** `datacl` kept as the text-array literal PostgreSQL sends on the wire. */
    datacl: string | null;
}

export interface ClusterDoc {
    version: number;
    /** Next oid handed to a database created at runtime. */
    nextOid: number;
    databases: ClusterDatabase[];
}

const TEMPLATE_ACL = '{=c/postgres,postgres=CTc/postgres}';

/** The three databases `initdb` seeds, in the system table's insertion order. */
export function seedCluster(): ClusterDoc {
    return {
        version: CLUSTER_VERSION,
        nextOid: FIRST_USER_OID,
        databases: [
            {
                oid: 5,
                datname: 'postgres',
                datdba: POSTGRES_ROLE,
                encoding: 6,
                datlocprovider: 'c',
                datistemplate: false,
                datallowconn: true,
                datconnlimit: -1,
                datfrozenxid: 722,
                datminmxid: 1,
                dattablespace: 1663,
                datcollate: 'C',
                datctype: 'C',
                daticulocale: null,
                daticurules: null,
                datcollversion: null,
                datacl: null,
            },
            {
                oid: 1,
                datname: 'template1',
                datdba: POSTGRES_ROLE,
                encoding: 6,
                datlocprovider: 'c',
                datistemplate: true,
                datallowconn: true,
                datconnlimit: -1,
                datfrozenxid: 722,
                datminmxid: 1,
                dattablespace: 1663,
                datcollate: 'C',
                datctype: 'C',
                daticulocale: null,
                daticurules: null,
                datcollversion: null,
                datacl: TEMPLATE_ACL,
            },
            {
                oid: 4,
                datname: 'template0',
                datdba: POSTGRES_ROLE,
                encoding: 6,
                datlocprovider: 'c',
                datistemplate: true,
                datallowconn: false,
                datconnlimit: -1,
                datfrozenxid: 722,
                datminmxid: 1,
                dattablespace: 1663,
                datcollate: 'C',
                datctype: 'C',
                daticulocale: null,
                daticurules: null,
                datcollversion: null,
                datacl: TEMPLATE_ACL,
            },
        ],
    };
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function encode(text: string): Uint8Array {
    return encoder.encode(text);
}

function decode(bytes: Uint8Array): string {
    return decoder.decode(bytes);
}

function assertCluster(value: unknown): ClusterDoc {
    const doc = value as Partial<ClusterDoc> | null;
    if (typeof doc !== 'object' || doc === null) throw new Error('cluster directory is not an object');
    if (typeof doc.version !== 'number') throw new Error('cluster directory has no version');
    if (typeof doc.nextOid !== 'number') throw new Error('cluster directory has no next oid');
    if (!Array.isArray(doc.databases)) throw new Error('cluster directory has no database list');
    for (const database of doc.databases as Partial<ClusterDatabase>[]) {
        if (typeof database.oid !== 'number' || typeof database.datname !== 'string') {
            throw new Error('cluster directory has an invalid database entry');
        }
    }
    return doc as ClusterDoc;
}

/**
 * The `pg_database` rows of one data directory.
 *
 * A fresh directory is seeded with `postgres`, `template1` and `template0` and
 * written once, so later restarts read the same rows.
 */
export class ClusterStore {
    readonly doc: ClusterDoc;
    private readonly storage: Storage;

    constructor(storage: Storage) {
        this.storage = storage;
        const stored = storage.scan(CLUSTER_NAMESPACE).find((row) => decode(row.key) === CLUSTER_KEY);
        if (stored) {
            this.doc = assertCluster(JSON.parse(decode(stored.value)) as unknown);
            return;
        }
        this.doc = seedCluster();
        this.storage.commitChanges([this.change()]);
    }

    find(name: string): ClusterDatabase | undefined {
        return this.doc.databases.find((database) => database.datname === name);
    }

    /** Oid for the next created database, without advancing the counter. */
    nextOid(): number {
        return this.doc.nextOid;
    }

    /** Adds one row and returns its `pg_database` mirror row in the cluster. */
    append(database: ClusterDatabase): ClusterDatabase {
        this.doc.databases.push(database);
        this.doc.nextOid = Math.max(this.doc.nextOid, database.oid + 1);
        return database;
    }

    remove(name: string): ClusterDatabase | undefined {
        const index = this.doc.databases.findIndex((database) => database.datname === name);
        if (index < 0) return undefined;
        const [removed] = this.doc.databases.splice(index, 1);
        return removed;
    }

    /** The single cluster-document row, staged into a statement's commit batch. */
    change(): StoredChange {
        return {
            kind: 'put',
            namespace: CLUSTER_NAMESPACE,
            key: encode(CLUSTER_KEY),
            value: encode(JSON.stringify(this.doc)),
        };
    }
}
