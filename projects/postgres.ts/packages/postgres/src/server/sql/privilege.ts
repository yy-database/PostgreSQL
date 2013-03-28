/** Privilege checks that run on the execution path, not just in the catalogue text. */

import { ServerError } from '../errors.ts';
import { type AclObjectType, type AclEntry, aclGrants, defaultAcl, defaultNamespaceAcl, parseAcl, privilegeLetter } from './acl.ts';
import { PG_DATABASE_OWNER_ROLE, POSTGRES_ROLE, SYSTEM_NAMESPACES, pgGetUserById } from './catalog.ts';
import { type ClusterDatabase, type ClusterRole, findRole, roleIsSuperuser } from './cluster.ts';
import type { CatalogDoc, UserRelation } from './catalog.ts';
import type { Database } from './database.ts';

export interface GrantTarget {
    /** `database`, `schema` or `table`. */
    type: AclObjectType;
    /** Database name, schema name or table name as the statement wrote it. */
    name: string;
}

export function currentRole(database: Database): ClusterRole {
    const role = findRole(database.roles, database.session.user);
    if (!role) throw new ServerError('42704', `role "${database.session.user}" does not exist`);
    return role;
}

/** The `pg_roles` oid new objects are owned by. */
export function currentRoleOid(database: Database): number {
    return currentRole(database).oid;
}

export function currentDatabaseRow(database: Database): ClusterDatabase | undefined {
    return database.databases.find((row) => row.datname === database.session.database);
}

/** Namespace oid for a schema name, or `undefined` when it does not exist. */
export function namespaceOid(name: string): number | undefined {
    return SYSTEM_NAMESPACES.find((namespace) => namespace.name === name)?.oid;
}

/** `true` when `user` owns the current database. */
function ownsCurrentDatabase(database: Database, user: string): boolean {
    const row = currentDatabaseRow(database);
    if (!row) return false;
    return pgGetUserById(row.datdba, database.roles) === user;
}

function isSchemaOwner(database: Database, namespace: { oid: number; name: string }, user: string): boolean {
    // `public` belongs to the pseudo-role `pg_database_owner`, whose members are
    // the owners of the current database. Every other schema is owned by postgres.
    if (namespace.name === 'public') return ownsCurrentDatabase(database, user);
    return findRole(database.roles, user)?.oid === POSTGRES_ROLE;
}

function schemaAclEntries(database: Database, namespace: { oid: number; name: string }): AclEntry[] {
    const text = database.catalog.namespaceAcls?.[String(namespace.oid)] ?? defaultNamespaceAcl(namespace.name);
    return text === null ? [] : parseAcl(text);
}

function denied(type: AclObjectType, name: string): ServerError {
    if (type === 'schema') return new ServerError('42501', `permission denied for schema ${name}`);
    if (type === 'database') return new ServerError('42501', `permission denied for database "${name}"`);
    return new ServerError('42501', `permission denied for table ${name}`);
}

/**
 * Checks one privilege before a statement touches an object.
 *
 * Superusers bypass every check, owners hold every privilege implicitly, and
 * other roles are resolved through the stored ACL text (`datacl`, `nspacl`,
 * `relacl`) or the seeded default ACL when the column is still null.
 */
export function checkGrant(database: Database, target: GrantTarget, privilege: string): void {
    const user = database.session.user;
    if (roleIsSuperuser(database.roles, user)) return;
    if (target.type === 'database') {
        const row = database.databases.find((candidate) => candidate.datname === target.name);
        if (!row) throw new ServerError('3D000', `database "${target.name}" does not exist`);
        if (pgGetUserById(row.datdba, database.roles) === user) return;
        const letter = privilegeLetter('database', privilege);
        if (letter === undefined) throw new ServerError('22023', `unrecognized privilege type: "${privilege}"`);
        const owner = pgGetUserById(row.datdba, database.roles);
        const entries = row.datacl === null && typeof owner === 'string' ? defaultAcl('database', owner) : row.datacl === null ? [] : parseAcl(row.datacl);
        if (!aclGrants(entries, user, letter)) throw denied('database', target.name);
        return;
    }
    if (target.type === 'schema') {
        const namespace = SYSTEM_NAMESPACES.find((candidate) => candidate.name === target.name);
        if (!namespace) throw new ServerError('3F000', `schema "${target.name}" does not exist`);
        if (isSchemaOwner(database, namespace, user)) return;
        const letter = privilegeLetter('schema', privilege);
        if (letter === undefined) throw new ServerError('22023', `unrecognized privilege type: "${privilege}"`);
        if (aclGrants(schemaAclEntries(database, namespace), user, letter)) return;
        throw denied('schema', target.name);
    }
    const relation = relationByName(database.catalog, target.name);
    if (!relation) throw new ServerError('42P01', `relation "${target.name}" does not exist`);
    checkGrantOnTable(database, relation, privilege);
}

/** Relation lookup shared by the grant entry points and the table checks. */
export function relationByName(doc: CatalogDoc, name: string): UserRelation | undefined {
    return doc.relations.find((relation) => relation.name === name);
}

export function checkGrantOnTable(database: Database, relation: UserRelation, privilege: string): void {
    const user = database.session.user;
    if (roleIsSuperuser(database.roles, user)) return;
    if (pgGetUserById(relation.owner, database.roles) === user) return;
    const letter = privilegeLetter('table', privilege);
    if (letter === undefined) throw new ServerError('22023', `unrecognized privilege type: "${privilege}"`);
    if (relation.relacl === null || relation.relacl === undefined) throw denied('table', relation.name);
    if (!aclGrants(parseAcl(relation.relacl), user, letter)) throw denied('table', relation.name);
}

/** DML entry point keyed by the relation oid resolved by the engine. */
export function checkGrantOnOid(database: Database, oid: number, privilege: string): void {
    const relation = database.catalog.relations.find((candidate) => candidate.oid === oid);
    if (relation) checkGrantOnTable(database, relation, privilege);
}

/** `ALTER TABLE`/`DROP TABLE`/index DDL require ownership, not a table grant. */
export function checkTableOwner(database: Database, relation: UserRelation): void {
    const user = database.session.user;
    if (roleIsSuperuser(database.roles, user)) return;
    if (pgGetUserById(relation.owner, database.roles) === user) return;
    throw new ServerError('42501', `must be owner of table ${relation.name}`);
}
