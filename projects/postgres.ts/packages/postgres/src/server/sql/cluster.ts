/** Cluster-wide database directory shared by every session on one data directory. */

import { ServerError } from '../errors.ts';
import { FIRST_USER_OID, POSTGRES_ROLE, PG_DATABASE_OWNER_ROLE, pgGetUserById } from './catalog.ts';
import { type AclEntry, aclGrants, defaultAcl, parseAcl, privilegeLetter } from './acl.ts';
import type { Storage, StoredChange } from './database.ts';

export const CLUSTER_NAMESPACE = 'pg_cluster';
export const CLUSTER_KEY = 'databases';
export const CLUSTER_VERSION = 2;

/** One `pg_roles` row, cluster-wide because roles are shared by every database. */
export interface ClusterRole {
    oid: number;
    rolname: string;
    rolsuper: boolean;
    rolinherit: boolean;
    rolcreaterole: boolean;
    rolcreatedb: boolean;
    rolcanlogin: boolean;
    rolreplication: boolean;
    rolbypassrls: boolean;
    rolconnlimit: number;
}

/** The two roles `initdb` seeds; both exist before any user role is created. */
export function seedRoles(): ClusterRole[] {
    return [
        {
            oid: POSTGRES_ROLE,
            rolname: 'postgres',
            rolsuper: true,
            rolinherit: true,
            rolcreaterole: true,
            rolcreatedb: true,
            rolcanlogin: true,
            rolreplication: true,
            rolbypassrls: true,
            rolconnlimit: -1,
        },
        {
            oid: PG_DATABASE_OWNER_ROLE,
            rolname: 'pg_database_owner',
            rolsuper: false,
            rolinherit: true,
            rolcreaterole: false,
            rolcreatedb: false,
            rolcanlogin: false,
            rolreplication: false,
            rolbypassrls: false,
            rolconnlimit: -1,
        },
    ];
}

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
    /** Next oid handed to a role created at runtime. */
    nextRoleOid: number;
    roles: ClusterRole[];
}

const TEMPLATE_ACL = '{=c/postgres,postgres=CTc/postgres}';

/** The three databases `initdb` seeds, in the system table's insertion order. */
export function seedCluster(): ClusterDoc {
    return {
        version: CLUSTER_VERSION,
        nextOid: FIRST_USER_OID,
        nextRoleOid: FIRST_USER_OID,
        roles: seedRoles(),
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
    // Directories written before roles existed keep working: seed the two built-in
    // roles instead of rejecting the data directory.
    if (!Array.isArray(doc.roles) || (doc.roles as Partial<ClusterRole>[]).some((role) => typeof role.rolname !== 'string')) {
        (doc as ClusterDoc).roles = seedRoles();
    }
    if (typeof doc.nextRoleOid !== 'number') {
        (doc as ClusterDoc).nextRoleOid = Math.max(FIRST_USER_OID, ...(doc.roles as ClusterRole[]).map((role) => role.oid + 1));
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
            const raw = JSON.parse(decode(stored.value)) as Partial<ClusterDoc>;
            const needsRoles = !Array.isArray(raw.roles) || typeof raw.nextRoleOid !== 'number';
            this.doc = assertCluster(raw);
            if (needsRoles) this.storage.commitChanges([this.change()]);
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

    findRole(name: string): ClusterRole | undefined {
        return this.doc.roles.find((role) => role.rolname === name);
    }

    /** Oid for the next created role, without advancing the counter. */
    nextRoleOid(): number {
        return this.doc.nextRoleOid;
    }

    appendRole(role: ClusterRole): ClusterRole {
        this.doc.roles.push(role);
        this.doc.nextRoleOid = Math.max(this.doc.nextRoleOid, role.oid + 1);
        return role;
    }

    removeRole(name: string): ClusterRole | undefined {
        const index = this.doc.roles.findIndex((role) => role.rolname === name);
        if (index < 0) return undefined;
        const [removed] = this.doc.roles.splice(index, 1);
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

/** Finds one role row by name. */
export function findRole(roles: ClusterRole[], name: string): ClusterRole | undefined {
    return roles.find((role) => role.rolname === name);
}

/** `true` when the role exists and carries `SUPERUSER`. */
export function roleIsSuperuser(roles: ClusterRole[], name: string): boolean {
    return findRole(roles, name)?.rolsuper === true;
}

/** The ACL entries that apply to one database, materialising the default when `datacl` is null. */
function databaseAcl(database: ClusterDatabase, roles: ClusterRole[]): AclEntry[] {
    if (database.datacl !== null) return parseAcl(database.datacl);
    const owner = pgGetUserById(database.datdba, roles);
    return typeof owner === 'string' ? defaultAcl('database', owner) : [];
}

/**
 * `has_database_privilege([user,] database, privilege)` over the cluster rows.
 *
 * Superusers and the database owner hold every privilege implicitly, matching
 * PostgreSQL. Other roles are resolved through `datacl`, falling back to the
 * default database ACL when the column is null.
 */
export function hasDatabasePrivilege(
    databases: ClusterDatabase[],
    roles: ClusterRole[],
    user: string,
    databaseName: string,
    privilege: string,
): boolean {
    const letter = privilegeLetter('database', privilege);
    if (letter === undefined) throw new ServerError('22023', `unrecognized privilege type: "${privilege}"`);
    const role = findRole(roles, user);
    if (!role) throw new ServerError('42704', `role "${user}" does not exist`);
    const database = databases.find((row) => row.datname === databaseName);
    if (!database) throw new ServerError('3D000', `database "${databaseName}" does not exist`);
    if (role.rolsuper) return true;
    const owner = pgGetUserById(database.datdba, roles);
    if (typeof owner === 'string' && owner === user) return true;
    return aclGrants(databaseAcl(database, roles), user, letter);
}
