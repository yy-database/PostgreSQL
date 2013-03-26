/** Cluster-wide database directory shared by every session on one data directory. */

import { ServerError } from '../errors.ts';
import { FIRST_USER_OID, POSTGRES_ROLE, pgGetUserById } from './catalog.ts';
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

/** Database privilege letters PostgreSQL stores in `datacl`. */
const DATABASE_PRIVILEGES: Record<string, string> = {
    connect: 'c',
    create: 'C',
    temp: 'T',
    temporary: 'T',
};

/** PostgreSQL's implicit database ACL: PUBLIC gets TEMP and CONNECT, the owner gets all three. */
const DEFAULT_PUBLIC_PRIVILEGES = 'Tc';
const DEFAULT_OWNER_PRIVILEGES = 'CTc';

/** Roles known to the catalogue. `pg_database_owner` is built in and cannot log in. */
const KNOWN_ROLES = new Set(['postgres', 'pg_database_owner']);

/** One `datacl` element, `grantee=privileges/grantor`; an empty grantee is PUBLIC. */
interface AclEntry {
    grantee: string;
    privileges: string;
}

function parseAclEntry(text: string): AclEntry {
    const equals = text.indexOf('=');
    const slash = text.lastIndexOf('/');
    if (equals < 0 || slash <= equals) return { grantee: text, privileges: '' };
    return { grantee: text.slice(0, equals), privileges: text.slice(equals + 1, slash) };
}

/** Splits a `datacl` text-array literal into entries, unquoting role names. */
function aclEntries(datacl: string): AclEntry[] {
    const body = datacl.trim().replace(/^\{/, '').replace(/\}$/, '');
    if (body.length === 0) return [];
    const entries: AclEntry[] = [];
    let current = '';
    let quoted = false;
    for (let index = 0; index < body.length; index += 1) {
        const character = body[index]!;
        if (quoted) {
            if (character === '\\') {
                current += body[index + 1] ?? '';
                index += 1;
            } else if (character === '"') quoted = false;
            else current += character;
            continue;
        }
        if (character === '"') {
            quoted = true;
            continue;
        }
        if (character === ',') {
            entries.push(parseAclEntry(current));
            current = '';
            continue;
        }
        current += character;
    }
    entries.push(parseAclEntry(current));
    return entries;
}

/** The ACL entries that apply to one database, materialising the default when `datacl` is null. */
function databaseAcl(database: ClusterDatabase): AclEntry[] {
    if (database.datacl !== null) return aclEntries(database.datacl);
    const owner = pgGetUserById(database.datdba);
    return [
        { grantee: '', privileges: DEFAULT_PUBLIC_PRIVILEGES },
        ...(typeof owner === 'string' ? [{ grantee: owner, privileges: DEFAULT_OWNER_PRIVILEGES }] : []),
    ];
}

/**
 * `has_database_privilege([user,] database, privilege)` over the cluster rows.
 *
 * Superusers and the database owner hold every privilege implicitly, matching
 * PostgreSQL. Other roles are resolved through `datacl`, falling back to the
 * default database ACL when the column is null.
 */
export function hasDatabasePrivilege(databases: ClusterDatabase[], user: string, databaseName: string, privilege: string): boolean {
    const letter = DATABASE_PRIVILEGES[privilege.toLowerCase()];
    if (letter === undefined) throw new ServerError('22023', `unrecognized privilege type: "${privilege}"`);
    if (!KNOWN_ROLES.has(user)) throw new ServerError('42704', `role "${user}" does not exist`);
    const database = databases.find((row) => row.datname === databaseName);
    if (!database) throw new ServerError('3D000', `database "${databaseName}" does not exist`);
    if (user === 'postgres') return true;
    const owner = pgGetUserById(database.datdba);
    if (typeof owner === 'string' && owner === user) return true;
    for (const entry of databaseAcl(database)) {
        if (entry.grantee !== '' && entry.grantee !== user) continue;
        if (entry.privileges.includes(letter)) return true;
    }
    return false;
}
