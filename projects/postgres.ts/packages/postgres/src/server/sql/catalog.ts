/** The single catalog document and its pure `pg_catalog` projections. */

import { ServerError } from '../errors.ts';
import { type DataType, type SqlValue, formatType, typeOf } from './types.ts';

export const CATALOG_VERSION = 1;
export const FIRST_USER_OID = 16384;

export const SYSTEM_NAMESPACES = [
    { oid: 11, name: 'pg_catalog' },
    { oid: 99, name: 'pg_toast' },
    { oid: 2200, name: 'public' },
    { oid: 13207, name: 'information_schema' },
];

export const PUBLIC_NAMESPACE = 2200;
export const PG_CATALOG_NAMESPACE = 11;
export const POSTGRES_ROLE = 10;

export interface UserRelation {
    oid: number;
    name: string;
    namespace: number;
    /** `r` for a table, `i` for an index. */
    relkind: 'r' | 'i';
    relam: number;
    owner: number;
    relhasindex: boolean;
}

export interface UserColumn {
    relid: number;
    attnum: number;
    name: string;
    typeOid: number;
    typmod: number;
    notNull: boolean;
    /** Rendered `pg_get_expr` text, or `null` when the column has no default. */
    defaultText: string | null;
    /** Value `INSERT` uses when the column is omitted. */
    defaultValue: SqlValue;
    defaultOid: number | null;
}

export interface UserIndex {
    oid: number;
    name: string;
    relid: number;
    unique: boolean;
    primary: boolean;
    indkey: number[];
    constraintOid: number | null;
}

export interface UserConstraint {
    oid: number;
    name: string;
    relid: number;
    contype: 'p' | 'u';
    indexOid: number;
    conkey: number[];
}

export interface CatalogDoc {
    version: number;
    nextOid: number;
    /** Highest row id handed out per relation oid. */
    nextRowId: Record<string, number>;
    relations: UserRelation[];
    columns: UserColumn[];
    indexes: UserIndex[];
    constraints: UserConstraint[];
}

export function emptyCatalog(): CatalogDoc {
    return { version: CATALOG_VERSION, nextOid: FIRST_USER_OID, nextRowId: {}, relations: [], columns: [], indexes: [], constraints: [] };
}

export interface ColumnMeta {
    name: string;
    type: DataType;
}

export interface TableData {
    columns: ColumnMeta[];
    rows: SqlValue[][];
}

interface SystemRelation {
    name: string;
    oid: number;
    columns: ColumnMeta[];
}

const oid = typeOf('oid');
const name = typeOf('name');
const int2 = typeOf('int2');
const int4 = typeOf('int4');
const text = typeOf('text');
const bool = typeOf('bool');
const char = typeOf('char');

function columns(...pairs: [string, DataType][]): ColumnMeta[] {
    return pairs.map(([columnName, type]) => ({ name: columnName, type }));
}

const SYSTEM_RELATIONS: SystemRelation[] = [
    {
        name: 'pg_class',
        oid: 1259,
        columns: columns(
            ['oid', oid],
            ['relname', name],
            ['relnamespace', oid],
            ['reltype', oid],
            ['reloftype', oid],
            ['relowner', oid],
            ['relam', oid],
            ['relfilenode', oid],
            ['reltablespace', oid],
            ['relpages', int4],
            ['reltuples', typeOf('float4')],
            ['relallvisible', int4],
            ['reltoastrelid', oid],
            ['relhasindex', bool],
            ['relisshared', bool],
            ['relpersistence', char],
            ['relkind', char],
            ['relnatts', int2],
            ['relchecks', int2],
            ['relhasrules', bool],
            ['relhastriggers', bool],
            ['relhassubclass', bool],
            ['relrowsecurity', bool],
            ['relforcerowsecurity', bool],
            ['relispopulated', bool],
            ['relreplident', char],
            ['relispartition', bool],
            ['relrewrite', oid],
            ['relfrozenxid', oid],
            ['relminmxid', oid],
            ['relacl', typeOf('text_array')],
            ['reloptions', typeOf('text_array')],
            ['relpartbound', typeOf('pg_node_tree')],
        ),
    },
    {
        name: 'pg_namespace',
        oid: 2615,
        columns: columns(['oid', oid], ['nspname', name], ['nspowner', oid], ['nspacl', typeOf('text_array')]),
    },
    {
        name: 'pg_attribute',
        oid: 1249,
        columns: columns(
            ['attrelid', oid],
            ['attname', name],
            ['atttypid', oid],
            ['attstattarget', int4],
            ['attlen', int2],
            ['attnum', int2],
            ['attndims', int4],
            ['attcacheoff', int4],
            ['atttypmod', int4],
            ['attbyval', bool],
            ['attalign', char],
            ['attstorage', char],
            ['attnotnull', bool],
            ['atthasdef', bool],
            ['atthasmissing', bool],
            ['attidentity', char],
            ['attgenerated', char],
            ['attisdropped', bool],
            ['attislocal', bool],
            ['attinhcount', int2],
            ['attcollation', oid],
            ['attacl', typeOf('text_array')],
            ['attoptions', typeOf('text_array')],
            ['attfdwoptions', typeOf('text_array')],
        ),
    },
    {
        name: 'pg_type',
        oid: 1247,
        columns: columns(
            ['oid', oid],
            ['typname', name],
            ['typnamespace', oid],
            ['typowner', oid],
            ['typlen', int2],
            ['typbyval', bool],
            ['typtype', char],
            ['typcategory', char],
            ['typispreferred', bool],
            ['typisdefined', bool],
            ['typdelim', char],
            ['typrelid', oid],
            ['typsubscript', oid],
            ['typelem', oid],
            ['typarray', oid],
            ['typinput', oid],
            ['typoutput', oid],
            ['typreceive', oid],
            ['typsend', oid],
            ['typmodin', oid],
            ['typmodout', oid],
            ['typanalyze', oid],
            ['typalign', char],
            ['typstorage', char],
            ['typnotnull', bool],
            ['typbasetype', oid],
            ['typtypmod', int4],
            ['typndims', int4],
            ['typcollation', oid],
            ['typdefaultbin', typeOf('pg_node_tree')],
            ['typdefault', text],
            ['typacl', typeOf('text_array')],
        ),
    },
    { name: 'pg_am', oid: 2601, columns: columns(['oid', oid], ['amname', name], ['amhandler', oid], ['amtype', char]) },
    {
        name: 'pg_index',
        oid: 2610,
        columns: columns(
            ['indexrelid', oid],
            ['indrelid', oid],
            ['indnatts', int2],
            ['indnkeyatts', int2],
            ['indisunique', bool],
            ['indnullsnotdistinct', bool],
            ['indisprimary', bool],
            ['indisexclusion', bool],
            ['indimmediate', bool],
            ['indisclustered', bool],
            ['indisvalid', bool],
            ['indcheckxmin', bool],
            ['indisready', bool],
            ['indislive', bool],
            ['indisreplident', bool],
            ['indkey', typeOf('int2vector')],
            ['indcollation', typeOf('oidvector')],
            ['indclass', typeOf('oidvector')],
            ['indoption', typeOf('int2vector')],
            ['indexprs', typeOf('pg_node_tree')],
            ['indpred', typeOf('pg_node_tree')],
        ),
    },
    {
        name: 'pg_constraint',
        oid: 2606,
        columns: columns(
            ['oid', oid],
            ['conname', name],
            ['connamespace', oid],
            ['contype', char],
            ['condeferrable', bool],
            ['condeferred', bool],
            ['convalidated', bool],
            ['conrelid', oid],
            ['contypid', oid],
            ['conindid', oid],
            ['conparentid', oid],
            ['confrelid', oid],
            ['confupdtype', char],
            ['confdeltype', char],
            ['confmatchtype', char],
            ['conislocal', bool],
            ['coninhcount', int2],
            ['connoinherit', bool],
            ['conkey', typeOf('int2_array')],
            ['confkey', typeOf('int2_array')],
            ['conpfeqop', typeOf('oid_array')],
            ['conppeqop', typeOf('oid_array')],
            ['conffeqop', typeOf('oid_array')],
            ['confdelsetcols', typeOf('int2_array')],
            ['conexclop', typeOf('oid_array')],
            ['conbin', typeOf('pg_node_tree')],
        ),
    },
    {
        name: 'pg_attrdef',
        oid: 2604,
        columns: columns(['oid', oid], ['adrelid', oid], ['adnum', int2], ['adbin', typeOf('pg_node_tree')]),
    },
    {
        name: 'pg_collation',
        oid: 3456,
        columns: columns(
            ['oid', oid],
            ['collname', name],
            ['collnamespace', oid],
            ['collowner', oid],
            ['collprovider', char],
            ['collisdeterministic', bool],
            ['collencoding', int4],
            ['collcollate', text],
            ['collctype', text],
            ['colliculocale', text],
            ['collrules', text],
            ['collicurules', text],
        ),
    },
    {
        name: 'pg_policy',
        oid: 3256,
        columns: columns(
            ['oid', oid],
            ['polname', name],
            ['polrelid', oid],
            ['polcmd', char],
            ['polpermissive', bool],
            ['polroles', typeOf('oid_array')],
            ['polqual', typeOf('pg_node_tree')],
            ['polwithcheck', typeOf('pg_node_tree')],
        ),
    },
    {
        name: 'pg_statistic_ext',
        oid: 3381,
        columns: columns(
            ['oid', oid],
            ['stxrelid', oid],
            ['stxname', name],
            ['stxnamespace', oid],
            ['stxowner', oid],
            ['stxkeys', typeOf('int2vector')],
            ['stxkind', typeOf('char_array')],
            ['stxstattarget', int2],
            ['stxexprs', typeOf('pg_node_tree')],
        ),
    },
    {
        name: 'pg_publication',
        oid: 6104,
        columns: columns(
            ['oid', oid],
            ['pubname', name],
            ['pubowner', oid],
            ['puballtables', bool],
            ['pubinsert', bool],
            ['pubupdate', bool],
            ['pubdelete', bool],
            ['pubtruncate', bool],
            ['pubviaroot', bool],
        ),
    },
    {
        name: 'pg_publication_namespace',
        oid: 6237,
        columns: columns(['oid', oid], ['pnpubid', oid], ['pnnspid', oid]),
    },
    {
        name: 'pg_publication_rel',
        oid: 6106,
        columns: columns(['oid', oid], ['prpubid', oid], ['prrelid', oid], ['prqual', typeOf('pg_node_tree')], ['prattrs', typeOf('int2vector')]),
    },
    {
        name: 'pg_inherits',
        oid: 2611,
        columns: columns(['inhrelid', oid], ['inhparent', oid], ['inhseqno', int4], ['inhdetachpending', bool]),
    },
    {
        name: 'pg_roles',
        oid: 1260,
        columns: columns(
            ['oid', oid],
            ['rolname', name],
            ['rolsuper', bool],
            ['rolinherit', bool],
            ['rolcreaterole', bool],
            ['rolcreatedb', bool],
            ['rolcanlogin', bool],
            ['rolreplication', bool],
            ['rolbypassrls', bool],
            ['rolconnlimit', int4],
            ['rolpassword', text],
            ['rolvaliduntil', typeOf('timestamptz')],
            ['rolconfig', typeOf('text_array')],
        ),
    },
    {
        name: 'pg_tablespace',
        oid: 1213,
        columns: columns(['oid', oid], ['spcname', name], ['spcowner', oid], ['spcacl', typeOf('text_array')], ['spcoptions', typeOf('text_array')]),
    },
    { name: 'pg_depend', oid: 2608, columns: columns(['classid', oid], ['objid', oid], ['objsubid', int4], ['refclassid', oid], ['refobjid', oid], ['refobjsubid', int4], ['deptype', char]) },
];

const SYSTEM_BY_NAME = new Map(SYSTEM_RELATIONS.map((relation) => [relation.name, relation]));
const SYSTEM_BY_OID = new Map(SYSTEM_RELATIONS.map((relation) => [relation.oid, relation]));

/** Every projection column keyed by relation name, so `SELECT` can resolve them. */
export function systemColumns(relation: string): ColumnMeta[] | undefined {
    return SYSTEM_BY_NAME.get(relation)?.columns;
}

const AMS = [
    { oid: 2, name: 'heap', handler: 5, type: 't' },
    { oid: 403, name: 'btree', handler: 330, type: 'i' },
    { oid: 405, name: 'hash', handler: 331, type: 'i' },
    { oid: 783, name: 'gist', handler: 332, type: 'i' },
    { oid: 2742, name: 'gin', handler: 333, type: 'i' },
    { oid: 3580, name: 'brin', handler: 4600, type: 'i' },
    { oid: 4000, name: 'spgist', handler: 4001, type: 'i' },
];

const BUILTIN_TYPES: { oid: number; name: string; len: number; byval: boolean; category: string; arrayOid: number | null; collation: number }[] = [
    { oid: 16, name: 'bool', len: 1, byval: true, category: 'B', arrayOid: 1000, collation: 0 },
    { oid: 18, name: 'char', len: 1, byval: true, category: 'S', arrayOid: 1002, collation: 0 },
    { oid: 19, name: 'name', len: 64, byval: false, category: 'S', arrayOid: 1003, collation: 100 },
    { oid: 20, name: 'int8', len: 8, byval: true, category: 'N', arrayOid: 1016, collation: 0 },
    { oid: 21, name: 'int2', len: 2, byval: true, category: 'N', arrayOid: 1005, collation: 0 },
    { oid: 23, name: 'int4', len: 4, byval: true, category: 'N', arrayOid: 1007, collation: 0 },
    { oid: 25, name: 'text', len: -1, byval: false, category: 'S', arrayOid: 1009, collation: 100 },
    { oid: 26, name: 'oid', len: 4, byval: true, category: 'N', arrayOid: 1028, collation: 0 },
    { oid: 700, name: 'float4', len: 4, byval: true, category: 'N', arrayOid: 1021, collation: 0 },
    { oid: 701, name: 'float8', len: 8, byval: true, category: 'N', arrayOid: 1022, collation: 0 },
    { oid: 1042, name: 'bpchar', len: -1, byval: false, category: 'S', arrayOid: 1014, collation: 100 },
    { oid: 1043, name: 'varchar', len: -1, byval: false, category: 'S', arrayOid: 1015, collation: 100 },
    { oid: 1082, name: 'date', len: 4, byval: true, category: 'D', arrayOid: 1182, collation: 0 },
    { oid: 1114, name: 'timestamp', len: 8, byval: true, category: 'D', arrayOid: 1115, collation: 0 },
    { oid: 1184, name: 'timestamptz', len: 8, byval: true, category: 'D', arrayOid: 1185, collation: 0 },
    { oid: 2950, name: 'uuid', len: 16, byval: false, category: 'U', arrayOid: 2951, collation: 0 },
    { oid: 194, name: 'pg_node_tree', len: -1, byval: false, category: 'S', arrayOid: 0, collation: 0 },
    { oid: 22, name: 'int2vector', len: -1, byval: false, category: 'A', arrayOid: 1006, collation: 0 },
    { oid: 30, name: 'oidvector', len: -1, byval: false, category: 'A', arrayOid: 1013, collation: 0 },
    { oid: 2205, name: 'regclass', len: 4, byval: true, category: 'N', arrayOid: 2210, collation: 0 },
    { oid: 2206, name: 'regtype', len: 4, byval: true, category: 'N', arrayOid: 2211, collation: 0 },
    { oid: 24, name: 'regproc', len: 4, byval: true, category: 'N', arrayOid: 1008, collation: 0 },
    { oid: 4089, name: 'regnamespace', len: 4, byval: true, category: 'N', arrayOid: 4090, collation: 0 },
];

const BUILTIN_BY_OID = new Map(BUILTIN_TYPES.map((type) => [type.oid, type]));

/** Maps a catalog `atttypid` back to a value type. */
export function typeByOid(typeOidValue: number, typmod: number): DataType {
    switch (typeOidValue) {
        case 16:
            return typeOf('bool');
        case 18:
            return typeOf('char');
        case 19:
            return typeOf('name');
        case 20:
            return typeOf('int8');
        case 21:
            return typeOf('int2');
        case 23:
            return typeOf('int4');
        case 25:
            return typeOf('text');
        case 26:
            return typeOf('oid');
        case 700:
            return typeOf('float4');
        case 701:
            return typeOf('float8');
        case 1042:
            return typeOf('bpchar', typmod);
        case 1043:
            return typeOf('varchar', typmod);
        case 1082:
            return typeOf('date');
        case 1114:
            return typeOf('timestamp');
        case 1184:
            return typeOf('timestamptz');
        case 2950:
            return typeOf('uuid');
        case 194:
            return typeOf('pg_node_tree');
        case 22:
            return typeOf('int2vector');
        case 30:
            return typeOf('oidvector');
        case 2205:
            return typeOf('regclass');
        case 2206:
            return typeOf('regtype');
        case 24:
            return typeOf('regproc');
        case 4089:
            return typeOf('regnamespace');
        default:
            return typeOf('text');
    }
}

export function relationByOid(doc: CatalogDoc, oidValue: number): UserRelation | undefined {
    return doc.relations.find((relation) => relation.oid === oidValue);
}

export function relationByName(doc: CatalogDoc, relationName: string): UserRelation | undefined {
    return doc.relations.find((relation) => relation.name === relationName);
}

export function relationDisplayName(doc: CatalogDoc, oidValue: number): string | null {
    const relation = relationByOid(doc, oidValue);
    if (relation) return relation.name;
    const system = SYSTEM_BY_OID.get(oidValue);
    return system ? system.name : null;
}

/** Projects the whole `pg_catalog` surface from the single catalog document. */
export function catalogTables(doc: CatalogDoc): Map<string, TableData> {
    const tables = new Map<string, TableData>();
    const push = (relation: string, row: Record<string, SqlValue>): void => {
        const columns = SYSTEM_BY_NAME.get(relation)?.columns;
        if (!columns) return;
        const table = tables.get(relation) ?? { columns, rows: [] };
        table.rows.push(columns.map((column) => row[column.name] ?? null));
        tables.set(relation, table);
    };

    for (const relation of SYSTEM_RELATIONS) {
        if (!tables.has(relation.name)) tables.set(relation.name, { columns: relation.columns, rows: [] });
    }

    for (const namespace of SYSTEM_NAMESPACES) {
        push('pg_namespace', { oid: namespace.oid, nspname: namespace.name, nspowner: POSTGRES_ROLE });
    }

    const systemClassRow = (relation: SystemRelation): Record<string, SqlValue> => ({
        oid: relation.oid,
        relname: relation.name,
        relnamespace: PG_CATALOG_NAMESPACE,
        reltype: 0,
        reloftype: 0,
        relowner: POSTGRES_ROLE,
        relam: 2,
        relfilenode: relation.oid,
        reltablespace: 0,
        relpages: 0,
        reltuples: 0,
        relallvisible: 0,
        reltoastrelid: 0,
        relhasindex: false,
        relisshared: false,
        relpersistence: 'p',
        relkind: 'r',
        relnatts: relation.columns.length,
        relchecks: 0,
        relhasrules: false,
        relhastriggers: false,
        relhassubclass: false,
        relrowsecurity: false,
        relforcerowsecurity: false,
        relispopulated: true,
        relreplident: 'n',
        relispartition: false,
        relrewrite: 0,
        relfrozenxid: 0,
        relminmxid: 0,
    });

    const classRow = (relation: UserRelation): Record<string, SqlValue> => {
        const attributeCount = doc.columns.filter((column) => column.relid === relation.oid).length;
        return {
            oid: relation.oid,
            relname: relation.name,
            relnamespace: relation.namespace,
            reltype: 0,
            reloftype: 0,
            relowner: relation.owner,
            relam: relation.relam,
            relfilenode: relation.oid,
            reltablespace: 0,
            relpages: 0,
            reltuples: 0,
            relallvisible: 0,
            reltoastrelid: 0,
            relhasindex: relation.relhasindex,
            relisshared: false,
            relpersistence: 'p',
            relkind: relation.relkind,
            relnatts: attributeCount,
            relchecks: 0,
            relhasrules: false,
            relhastriggers: false,
            relhassubclass: false,
            relrowsecurity: false,
            relforcerowsecurity: false,
            relispopulated: true,
            relreplident: relation.relkind === 'i' ? 'n' : 'd',
            relispartition: false,
            relrewrite: 0,
            relfrozenxid: 0,
            relminmxid: 0,
        };
    };

    for (const relation of SYSTEM_RELATIONS) push('pg_class', systemClassRow(relation));
    for (const relation of doc.relations) push('pg_class', classRow(relation));

    for (const relation of SYSTEM_RELATIONS) {
        relation.columns.forEach((column, index) => {
            push('pg_attribute', {
                attrelid: relation.oid,
                attname: column.name,
                atttypid: typeOidOf(column.type),
                attstattarget: -1,
                attlen: column.type.key === 'varchar' || column.type.key === 'bpchar' ? -1 : typeLengthOf(column.type),
                attnum: index + 1,
                attndims: 0,
                attcacheoff: -1,
                atttypmod: column.type.typmod,
                attbyval: false,
                attalign: 'i',
                attstorage: 'x',
                attnotnull: false,
                atthasdef: false,
                atthasmissing: false,
                attidentity: '',
                attgenerated: '',
                attisdropped: false,
                attislocal: true,
                attinhcount: 0,
                attcollation: 0,
            });
        });
    }

    for (const column of doc.columns) {
        const type = typeByOid(column.typeOid, column.typmod);
        push('pg_attribute', {
            attrelid: column.relid,
            attname: column.name,
            atttypid: column.typeOid,
            attstattarget: -1,
            attlen: type.key === 'varchar' || type.key === 'bpchar' ? -1 : typeLengthOf(type),
            attnum: column.attnum,
            attndims: 0,
            attcacheoff: -1,
            atttypmod: column.typmod,
            attbyval: isByValue(column.typeOid),
            attalign: 'i',
            attstorage: 'p',
            attnotnull: column.notNull,
            atthasdef: column.defaultText !== null,
            atthasmissing: false,
            attidentity: '',
            attgenerated: '',
            attisdropped: false,
            attislocal: true,
            attinhcount: 0,
            attcollation: 0,
        });
    }

    for (const am of AMS) push('pg_am', { oid: am.oid, amname: am.name, amhandler: am.handler, amtype: am.type });

    for (const type of BUILTIN_TYPES) {
        push('pg_type', {
            oid: type.oid,
            typname: type.name,
            typnamespace: PG_CATALOG_NAMESPACE,
            typowner: POSTGRES_ROLE,
            typlen: type.len,
            typbyval: type.byval,
            typtype: 'b',
            typcategory: type.category,
            typispreferred: false,
            typisdefined: true,
            typdelim: ',',
            typrelid: 0,
            typsubscript: 0,
            typelem: 0,
            typarray: type.arrayOid ?? 0,
            typinput: 0,
            typoutput: 0,
            typreceive: 0,
            typsend: 0,
            typmodin: 0,
            typmodout: 0,
            typanalyze: 0,
            typalign: 'i',
            typstorage: 'p',
            typnotnull: false,
            typbasetype: 0,
            typtypmod: -1,
            typndims: 0,
            typcollation: type.collation,
            typdefault: null,
        });
    }

    for (const collation of [
        { oid: 100, name: 'default', encoding: -1 },
        { oid: 950, name: 'C', encoding: -1 },
        { oid: 951, name: 'POSIX', encoding: -1 },
    ]) {
        push('pg_collation', {
            oid: collation.oid,
            collname: collation.name,
            collnamespace: PG_CATALOG_NAMESPACE,
            collowner: POSTGRES_ROLE,
            collprovider: 'd',
            collisdeterministic: true,
            collencoding: collation.encoding,
            collcollate: collation.name === 'default' ? null : collation.name,
            collctype: collation.name === 'default' ? null : collation.name,
        });
    }

    for (const index of doc.indexes) {
        push('pg_index', {
            indexrelid: index.oid,
            indrelid: index.relid,
            indnatts: index.indkey.length,
            indnkeyatts: index.indkey.length,
            indisunique: index.unique,
            indnullsnotdistinct: false,
            indisprimary: index.primary,
            indisexclusion: false,
            indimmediate: true,
            indisclustered: false,
            indisvalid: true,
            indcheckxmin: false,
            indisready: true,
            indislive: true,
            indisreplident: false,
            indkey: index.indkey.join(' '),
            indcollation: '0 0 0',
            indclass: '0 0 0',
            indoption: '0 0 0',
        });
    }

    for (const constraint of doc.constraints) {
        push('pg_constraint', {
            oid: constraint.oid,
            conname: constraint.name,
            connamespace: PUBLIC_NAMESPACE,
            contype: constraint.contype,
            condeferrable: false,
            condeferred: false,
            convalidated: true,
            conrelid: constraint.relid,
            contypid: 0,
            conindid: constraint.indexOid,
            conparentid: 0,
            confrelid: 0,
            confupdtype: ' ',
            confdeltype: ' ',
            confmatchtype: ' ',
            conislocal: true,
            coninhcount: 0,
            connoinherit: true,
            conkey: constraint.conkey.map(String).join(' '),
        });
    }

    doc.columns.forEach((column) => {
        if (column.defaultText === null) return;
        push('pg_attrdef', {
            oid: column.defaultOid ?? 0,
            adrelid: column.relid,
            adnum: column.attnum,
            adbin: column.defaultText,
        });
    });

    push('pg_roles', {
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
    });

    push('pg_tablespace', { oid: 1663, spcname: 'pg_default', spcowner: POSTGRES_ROLE });
    push('pg_tablespace', { oid: 1664, spcname: 'pg_global', spcowner: POSTGRES_ROLE });

    return tables;
}

/** `pg_get_userbyid`. */
export function pgGetUserById(oidValue: SqlValue): SqlValue {
    return oidValue === POSTGRES_ROLE ? 'postgres' : null;
}

/** `pg_table_is_visible`: every relation this server exposes lives in a visible schema. */
export function pgTableIsVisible(oidValue: SqlValue, doc: CatalogDoc): SqlValue {
    const relation = typeof oidValue === 'number' ? relationByOid(doc, oidValue) : undefined;
    if (relation) return relation.namespace === PUBLIC_NAMESPACE;
    return typeof oidValue === 'number' && SYSTEM_BY_OID.has(oidValue) ? true : null;
}

/** `pg_relation_is_publishable`. */
export function pgRelationIsPublishable(): SqlValue {
    return false;
}

/** `pg_get_expr`: the default text is already stored in rendered form. */
export function pgGetExpr(bin: SqlValue): SqlValue {
    return bin;
}

/** `pg_get_indexdef(indexrelid, 0, true)`. */
export function pgGetIndexDef(doc: CatalogDoc, indexOid: SqlValue): SqlValue {
    if (typeof indexOid !== 'number') return null;
    const index = doc.indexes.find((candidate) => candidate.oid === indexOid);
    const relation = index ? relationByOid(doc, index.relid) : undefined;
    if (!index || !relation) return null;
    const names = index.indkey.map((attnum) => doc.columns.find((column) => column.relid === index.relid && column.attnum === attnum)?.name ?? `attnum${attnum}`);
    const unique = index.unique ? 'UNIQUE ' : '';
    return `CREATE ${unique}INDEX ${index.name} ON ${relation.name} USING btree (${names.join(', ')})`;
}

/** `pg_get_constraintdef(oid, true)`. */
export function pgGetConstraintDef(doc: CatalogDoc, constraintOid: SqlValue): SqlValue {
    if (typeof constraintOid !== 'number') return null;
    const constraint = doc.constraints.find((candidate) => candidate.oid === constraintOid);
    if (!constraint) return null;
    const names = constraint.conkey.map((attnum) => doc.columns.find((column) => column.relid === constraint.relid && column.attnum === attnum)?.name ?? `attnum${attnum}`);
    return `${constraint.contype === 'p' ? 'PRIMARY KEY' : 'UNIQUE'} (${names.join(', ')})`;
}

/** `format_type(oid, typmod)`. */
export function formatTypeByOid(typeOidValue: SqlValue, typmod: SqlValue): SqlValue {
    if (typeof typeOidValue !== 'number') return null;
    const type = typeByOid(typeOidValue, typeof typmod === 'number' ? typmod : -1);
    return formatType(type);
}

function typeOidOf(type: DataType): number {
    const entry = [...BUILTIN_TYPES].find((candidate) => candidate.name === type.key);
    switch (type.key) {
        case 'bpchar':
            return 1042;
        case 'varchar':
            return 1043;
        default:
            return entry?.oid ?? 25;
    }
}

function typeLengthOf(type: DataType): number {
    switch (type.key) {
        case 'bool':
        case 'char':
            return 1;
        case 'int2':
            return 2;
        case 'int4':
        case 'float4':
        case 'oid':
        case 'regclass':
        case 'regtype':
        case 'regproc':
        case 'regnamespace':
            return 4;
        case 'int8':
        case 'float8':
        case 'timestamp':
        case 'timestamptz':
            return 8;
        case 'date':
            return 4;
        case 'uuid':
            return 16;
        case 'name':
            return 64;
        default:
            return -1;
    }
}

function isByValue(typeOidValue: number): boolean {
    return BUILTIN_BY_OID.get(typeOidValue)?.byval ?? false;
}

/** Rejects writes to the system catalog surface. */
export function isSystemRelation(relationName: string): boolean {
    return SYSTEM_BY_NAME.has(relationName);
}

/** Throws when the catalog document has an unexpected shape. */
export function assertCatalog(value: unknown): CatalogDoc {
    if (!value || typeof value !== 'object') throw new ServerError('XX000', 'catalog document is missing');
    const doc = value as CatalogDoc;
    if (doc.version !== CATALOG_VERSION) throw new ServerError('XX000', `unsupported catalog version ${String(doc.version)}`);
    return doc;
}
