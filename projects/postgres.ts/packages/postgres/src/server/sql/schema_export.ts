/**
 * `sql-schema.v0.json`: a deterministic projection of this cluster's catalogs.
 *
 * The catalog document inside `local-0.yyds` stays the single truth for
 * recovery. This file is the `yyds-sql-schema/v0` document that the yyds
 * gateways use as their registry, exported so a PostgreSQL data directory
 * carries the same artifact set as the other yyds-backed products. It is
 * rewritten atomically after every catalog or cluster commit and is never read
 * back as a source of truth.
 *
 * The registry contract has no cluster or schema dimension, so table names are
 * qualified as `<database>.<schema>.<table>` to keep every user relation in the
 * document distinguishable.
 */

import fs from 'node:fs';

import { CATALOG_NAMESPACE, loadCatalog, type Storage } from './database.ts';
import { databasePrefix, scopedStorage } from '../store.ts';
import { FIRST_USER_OID, SYSTEM_NAMESPACES, type CatalogDoc, type UserRelation } from './catalog.ts';
import { formatType, typeFromOid, typeOf } from './types.ts';

export const SCHEMA_CONTRACT = 'yyds-sql-schema/v0';
export const SCHEMA_FILE = 'sql-schema.v0.json';

type FieldTypeDocument = 'int32' | 'int64' | 'float64' | 'string' | 'bool' | 'bytes' | 'unknown';

interface FieldDocument {
    name: string;
    field_id: number;
    type: FieldTypeDocument;
    nullable: boolean;
    capacity: number | null;
    sql_type: string;
    default: string | null;
    auto_increment: boolean;
    next_value: number;
}

interface TableDocument {
    name: string;
    type_id: number;
    primary_key: string[];
    unique_constraints: string[][];
    fields: FieldDocument[];
}

interface IndexDocument {
    name: string;
    table: string;
    unique: boolean;
    columns: string[];
}

export interface SchemaDocument {
    contract: string;
    revision: number;
    next_type_id: number;
    next_field_id: number;
    tables: TableDocument[];
    indexes: IndexDocument[];
}

/** Field type lane the registry uses for PostgreSQL DDL tables. */
const FIELD_ID_STRIDE = 1_000_000;

function namespaceName(oid: number): string {
    return SYSTEM_NAMESPACES.find((namespace) => namespace.oid === oid)?.name ?? `ns${oid}`;
}

/** Registry type tag for one catalog column, or `unknown` when it cannot be expressed. */
function fieldType(typeOid: number): FieldTypeDocument {
    const type = typeFromOid(typeOid);
    switch (type?.key) {
        case 'int2':
        case 'int4':
        case 'oid':
        case 'regclass':
        case 'regtype':
        case 'regnamespace':
        case 'regproc':
            return 'int32';
        case 'int8':
            return 'int64';
        case 'float4':
        case 'float8':
            return 'float64';
        case 'text':
        case 'varchar':
        case 'bpchar':
        case 'name':
        case 'char':
            return 'string';
        case 'bool':
            return 'bool';
        case 'bytea':
            return 'bytes';
        default:
            return 'unknown';
    }
}

/** Declared length of a `varchar(n)` / `char(n)` column, or `null`. */
function fieldCapacity(typeOid: number, typmod: number): number | null {
    const type = typeFromOid(typeOid);
    if ((type?.key === 'varchar' || type?.key === 'bpchar') && typmod > 0) return typmod - 4;
    return null;
}

/** Rendered SQL type name for one column, including its modifier. */
function sqlType(typeOid: number, typmod: number): string {
    const type = typeFromOid(typeOid);
    return type === undefined ? formatType(typeOf('text')) : formatType(typeOf(type.key, typmod));
}

function tableName(database: string, relation: UserRelation): string {
    return `${database}.${namespaceName(relation.namespace)}.${relation.name}`;
}

/** Column names for one `conkey`/`indkey` attnum list, skipping expression entries. */
function columnNames(catalog: CatalogDoc, relid: number, attnums: number[]): string[] | null {
    const columns = catalog.columns.filter((column) => column.relid === relid);
    const names: string[] = [];
    for (const attnum of attnums) {
        const column = columns.find((candidate) => candidate.attnum === attnum);
        if (column === undefined) return null;
        names.push(column.name);
    }
    return names;
}

/** Builds the `yyds-sql-schema/v0` projection of one cluster's catalogs. */
export function buildSchemaDocument(storage: Storage, databases: string[]): SchemaDocument {
    const tables: TableDocument[] = [];
    const indexes: IndexDocument[] = [];
    let nextTypeId = 1;
    let nextFieldId = 1;
    let revision = 1;

    for (const database of databases) {
        const catalog = loadCatalog(scopedStorage(storage, databasePrefix(database)));
        revision = Math.max(revision, catalog.nextOid - FIRST_USER_OID + 1);
        for (const relation of catalog.relations) {
            if (relation.relkind !== 'r' || relation.persistence === 't') continue;
            const name = tableName(database, relation);
            nextTypeId = Math.max(nextTypeId, relation.oid + 1);
            const primary = catalog.constraints.find(
                (constraint) => constraint.relid === relation.oid && constraint.contype === 'p',
            );
            const primaryKey = primary === undefined ? [] : (columnNames(catalog, relation.oid, primary.conkey) ?? []);
            const uniqueConstraints: string[][] = [];
            for (const constraint of catalog.constraints) {
                if (constraint.relid !== relation.oid || constraint.contype !== 'u') continue;
                const columns = columnNames(catalog, relation.oid, constraint.conkey);
                if (columns !== null) uniqueConstraints.push(columns);
            }
            const fields: FieldDocument[] = [];
            for (const column of catalog.columns) {
                if (column.relid !== relation.oid) continue;
                const fieldId = relation.oid * FIELD_ID_STRIDE + column.attnum;
                nextFieldId = Math.max(nextFieldId, fieldId + 1);
                const autoIncrement = column.defaultKind === 'sequence';
                const sequence =
                    autoIncrement && column.sequenceOid !== null
                        ? catalog.sequences.find((candidate) => candidate.oid === column.sequenceOid)
                        : undefined;
                fields.push({
                    name: column.name,
                    field_id: fieldId,
                    type: fieldType(column.typeOid),
                    nullable: !column.notNull,
                    capacity: fieldCapacity(column.typeOid, column.typmod),
                    sql_type: sqlType(column.typeOid, column.typmod),
                    default: autoIncrement ? null : column.defaultText,
                    auto_increment: autoIncrement,
                    next_value: sequence === undefined ? 1 : sequence.lastValue + 1,
                });
            }
            fields.sort((left, right) => left.field_id - right.field_id);
            tables.push({ name, type_id: relation.oid, primary_key: primaryKey, unique_constraints: uniqueConstraints, fields });
            for (const index of catalog.indexes) {
                if (index.relid !== relation.oid || index.constraintOid !== null) continue;
                const columns = columnNames(catalog, relation.oid, index.indkey);
                if (columns === null) continue;
                indexes.push({ name: `${database}.${namespaceName(relation.namespace)}.${index.name}`, table: name, unique: index.unique, columns });
            }
        }
    }

    return { contract: SCHEMA_CONTRACT, revision, next_type_id: nextTypeId, next_field_id: nextFieldId, tables, indexes };
}

/** Serialized projection. Two identical catalogs always produce identical bytes. */
export function serializeSchemaDocument(document: SchemaDocument): string {
    return `${JSON.stringify(document, null, 2)}\n`;
}

/**
 * Rewrites `<dataDir>/sql-schema.v0.json` through a temp file, `fsync` and an
 * atomic replace. A failure leaves the previous document in place.
 */
export function writeSchemaExport(dataDir: string, storage: Storage, databases: string[]): void {
    const target = `${dataDir}/${SCHEMA_FILE}`;
    const temporary = `${target}.tmp`;
    const contents = serializeSchemaDocument(buildSchemaDocument(storage, databases));
    const handle = fs.openSync(temporary, 'w');
    try {
        fs.writeFileSync(handle, contents, 'utf8');
        fs.fsyncSync(handle);
    } finally {
        fs.closeSync(handle);
    }
    try {
        fs.renameSync(temporary, target);
    } catch (error) {
        fs.rmSync(temporary, { force: true });
        throw error;
    }
}

/** Whether one commit batch wrote catalog or cluster metadata. */
export function touchesSchema(namespace: string): boolean {
    return namespace === 'pg_cluster' || namespace === CATALOG_NAMESPACE || namespace.endsWith(`:${CATALOG_NAMESPACE}`);
}
