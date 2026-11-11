/** The single catalog document and its pure `pg_catalog` projections. */

import { ServerError } from '../errors.ts';
import type { ClusterDatabase, ClusterRole } from './cluster.ts';
import { defaultNamespaceAcl } from './acl.ts';
import { type DataType, type SqlValue, formatType, typeOf } from './types.ts';

export const CATALOG_VERSION = 2;
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
/** Role that owns the `public` schema in PostgreSQL 15 and newer. */
export const PG_DATABASE_OWNER_ROLE = 6171;

export interface UserRelation {
    oid: number;
    name: string;
    namespace: number;
    /** `r` for a table, `i` for an index, `S` for a serial sequence, `v` for a view. */
    relkind: 'r' | 'i' | 'S' | 'v';
    relam: number;
    owner: number;
    relhasindex: boolean;
    /** `relacl` kept as the text-array literal; `null` means the implicit owner-only ACL. */
    relacl?: string | null;
    /** `pg_class.relpersistence`: `p` permanent, `t` temporary, `u` unlogged. */
    persistence?: 'p' | 't' | 'u';
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
    /** `sequence` defaults are evaluated through `nextval` at insert time. */
    defaultKind: 'value' | 'sequence' | null;
    /** Sequence oid when `defaultKind` is `sequence`. */
    sequenceOid: number | null;
    defaultOid: number | null;
    /** `pg_attribute.attidentity`: `a` always, `d` by default, empty otherwise. */
    identity: string;
}

export interface UserIndexKey {
    /** `pg_index.indkey` entry, `0` for an expression key. */
    attnum: number;
    /** Parsed expression spelling used to evaluate a unique key. */
    expression?: string;
    /** Rendered key text when `pg_get_indexdef` is called with `pretty`. */
    pretty?: string;
    /** Rendered key text when `pg_get_indexdef` is called without `pretty`. */
    raw?: string;
    desc?: boolean;
    nullsFirst?: boolean;
}

export interface UserIndex {
    oid: number;
    name: string;
    relid: number;
    unique: boolean;
    primary: boolean;
    method: string;
    /** Key entries followed by `INCLUDE` columns. */
    indkey: number[];
    /** Structured keys for expression indexes, absent on constraint indexes. */
    keys?: UserIndexKey[];
    /** Pretty predicate text of a partial index, or `null`. */
    predicate: string | null;
    constraintOid: number | null;
    /**
     * `true` when this index has durable entries under `pg_index.<oid>`.
     * Indexes created before the access-path work lack the flag and are
     * re-read as full table scans rather than trusted blindly.
     */
    materialized?: boolean;
}

export interface UserConstraint {
    oid: number;
    name: string;
    relid: number;
    contype: 'p' | 'u' | 'c' | 'f';
    indexOid: number | null;
    conkey: number[];
    confrelid: number;
    confkey: number[];
    /** `a` no action, `r` restrict, `c` cascade, `n` set null, `d` set default. */
    confupdtype: string;
    confdeltype: string;
    /** `s` simple, `f` full, `p` partial. */
    confmatchtype?: string;
    condeferrable?: boolean;
    condeferred?: boolean;
    convalidated: boolean;
    /** Pretty expression text for `CHECK`, or `null`. */
    checkSource: string | null;
}

export interface UserSequence {
    oid: number;
    name: string;
    /** Relation whose `serial` column owns this sequence. */
    relid: number;
    lastValue: number;
}

export interface UserView {
    /** `pg_class` oid of the view relation this definition belongs to. */
    oid: number;
    /** Source spelling of the stored `SELECT`, rendered by `pg_views`. */
    definition: string;
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
    sequences: UserSequence[];
    /** Definitions of the `relkind = 'v'` relations, keyed by view oid. */
    views: UserView[];
    /** `nspacl` literals keyed by namespace oid; a missing key means the seeded default. */
    namespaceAcls?: Record<string, string>;
}

export function emptyCatalog(): CatalogDoc {
    return {
        version: CATALOG_VERSION,
        nextOid: FIRST_USER_OID,
        nextRowId: {},
        relations: [],
        columns: [],
        indexes: [],
        constraints: [],
        sequences: [],
        views: [],
        namespaceAcls: {},
    };
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
    /** `pg_cursors` is a view, so its `pg_class` row differs from a real table. */
    view?: boolean;
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
        // Foreign keys are modelled as constraints only, so this catalog stays
        // empty; psql still probes it whenever `relhastriggers` is set.
        name: 'pg_trigger',
        oid: 1269,
        columns: columns(
            ['oid', oid],
            ['tgrelid', oid],
            ['tgparentid', oid],
            ['tgname', name],
            ['tgfoid', oid],
            ['tgtype', int2],
            ['tgenabled', char],
            ['tgisinternal', bool],
            ['tgconstrrelid', oid],
            ['tgconstrindid', oid],
            ['tgconstraint', oid],
            ['tgdeferrable', bool],
            ['tginitdeferred', bool],
            ['tgnargs', int2],
            ['tgattr', typeOf('int2_array')],
            ['tgargs', typeOf('text')],
        ),
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
            ['attcompression', char],
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
    { name: 'pg_am', oid: 2601, columns: columns(['oid', oid], ['amname', name], ['amhandler', typeOf('regproc')], ['amtype', char]) },
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
        // Only the shape psql's `\df`/`\ddf` reads; user-defined functions are not stored.
        name: 'pg_proc',
        oid: 1255,
        columns: columns(
            ['oid', oid],
            ['proname', name],
            ['pronamespace', oid],
            ['proowner', oid],
            ['prolang', oid],
            ['prokind', char],
            ['provolatile', char],
            ['proparallel', char],
            ['prosecdef', bool],
            ['proacl', typeOf('text_array')],
            ['prosrc', text],
        ),
    },
    {
        name: 'pg_database',
        oid: 1262,
        columns: columns(
            ['oid', oid],
            ['datname', name],
            ['datdba', oid],
            ['encoding', int4],
            ['datlocprovider', char],
            ['datistemplate', typeOf('bool')],
            ['datallowconn', typeOf('bool')],
            ['datconnlimit', int4],
            ['datfrozenxid', int4],
            ['datminmxid', int4],
            ['dattablespace', oid],
            ['datcollate', text],
            ['datctype', text],
            ['daticulocale', text],
            ['daticurules', text],
            ['datcollversion', text],
            ['datacl', typeOf('text_array')],
        ),
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
        name: 'pg_indexes',
        oid: 12043,
        view: true,
        columns: columns(
            ['schemaname', name],
            ['tablename', name],
            ['indexname', name],
            ['tablespace', name],
            ['indexdef', text],
        ),
    },
    {
        name: 'pg_tablespace',
        oid: 1213,
        columns: columns(['oid', oid], ['spcname', name], ['spcowner', oid], ['spcacl', typeOf('text_array')], ['spcoptions', typeOf('text_array')]),
    },
    { name: 'pg_depend', oid: 2608, columns: columns(['classid', oid], ['objid', oid], ['objsubid', int4], ['refclassid', oid], ['refobjid', oid], ['refobjsubid', int4], ['deptype', char]) },
    {
        // The engine has no user-defined languages, so only the seeded `plpgsql`
        // row lives here. It is what `\dL` and `\df+` join against.
        name: 'pg_language',
        oid: 2612,
        columns: columns(
            ['oid', oid],
            ['lanname', name],
            ['lanowner', oid],
            ['lanispl', bool],
            ['lanpltrusted', bool],
            ['lanplcallfoid', oid],
            ['laninline', oid],
            ['lanvalidator', oid],
            ['lanacl', typeOf('text_array')],
        ),
    },
    {
        // `plpgsql` is the only extension this server ships.
        name: 'pg_extension',
        oid: 3079,
        columns: columns(
            ['oid', oid],
            ['extname', name],
            ['extowner', oid],
            ['extnamespace', oid],
            ['extrelocatable', bool],
            ['extversion', text],
            ['extconfig', typeOf('oid_array')],
            ['extcondition', typeOf('text_array')],
        ),
    },
    {
        // Object comments, keyed by the class oid they belong to. Only the
        // seeded namespaces, access methods, `plpgsql` and its language are
        // annotated; user objects carry no comment because no `COMMENT ON`
        // syntax is implemented.
        name: 'pg_description',
        oid: 2609,
        columns: columns(['objoid', oid], ['classoid', oid], ['objsubid', int4], ['description', text]),
    },
    {
        // Large objects are not implemented; `\dl` still needs the relation.
        name: 'pg_largeobject_metadata',
        oid: 2995,
        columns: columns(['oid', oid], ['lomowner', oid], ['lomacl', typeOf('text_array')]),
    },
    {
        name: 'pg_conversion',
        oid: 2607,
        columns: columns(
            ['oid', oid],
            ['conname', name],
            ['connamespace', oid],
            ['conowner', oid],
            ['conforencoding', int4],
            ['contoencoding', int4],
            ['conproc', oid],
            ['condefault', bool],
        ),
    },
    {
        name: 'pg_operator',
        oid: 2617,
        columns: columns(
            ['oid', oid],
            ['oprname', name],
            ['oprnamespace', oid],
            ['oprower', oid],
            ['oprkind', char],
            ['oprcanmerge', bool],
            ['oprcanhash', bool],
            ['oprleft', oid],
            ['oprright', oid],
            ['oprresult', oid],
            ['oprcom', oid],
            ['oprnegate', oid],
            ['oprcode', oid],
            ['oprrest', oid],
            ['oprjoin', oid],
        ),
    },
    {
        name: 'pg_opclass',
        oid: 2616,
        columns: columns(
            ['oid', oid],
            ['opcmethod', oid],
            ['opcname', name],
            ['opcnamespace', oid],
            ['opcowner', oid],
            ['opcfamily', oid],
            ['opcintype', oid],
            ['opcdefault', bool],
            ['opckeytype', oid],
        ),
    },
    {
        name: 'pg_opfamily',
        oid: 2753,
        columns: columns(['oid', oid], ['opfmethod', oid], ['opfname', name], ['opfnamespace', oid], ['opfowner', oid]),
    },
    {
        name: 'pg_amop',
        oid: 2602,
        columns: columns(
            ['oid', oid],
            ['amopfamily', oid],
            ['amoplefttype', oid],
            ['amoprighttype', oid],
            ['amopstrategy', int2],
            ['amoppurpose', char],
            ['amopopr', oid],
            ['amopmethod', oid],
            ['amopsortfamily', oid],
        ),
    },
    {
        name: 'pg_amproc',
        oid: 2603,
        columns: columns(
            ['oid', oid],
            ['amprocfamily', oid],
            ['amproclefttype', oid],
            ['amprocrighttype', oid],
            ['amprocnum', int2],
            ['amproc', oid],
        ),
    },
    {
        name: 'pg_rewrite',
        oid: 2618,
        columns: columns(
            ['oid', oid],
            ['rulename', name],
            ['ev_class', oid],
            ['ev_type', char],
            ['ev_enabled', char],
            ['is_instead', bool],
            ['ev_qual', typeOf('pg_node_tree')],
            ['ev_action', typeOf('pg_node_tree')],
        ),
    },
    {
        name: 'pg_foreign_server',
        oid: 1417,
        columns: columns(
            ['oid', oid],
            ['srvname', name],
            ['srvowner', oid],
            ['srvfdw', oid],
            ['srvtype', text],
            ['srvversion', text],
            ['srvacl', typeOf('text_array')],
            ['srvoptions', typeOf('text_array')],
        ),
    },
    {
        name: 'pg_foreign_data_wrapper',
        oid: 2328,
        columns: columns(
            ['oid', oid],
            ['fdwname', name],
            ['fdwowner', oid],
            ['fdwhandler', oid],
            ['fdwvalidator', oid],
            ['fdwacl', typeOf('text_array')],
            ['fdwoptions', typeOf('text_array')],
        ),
    },
    {
        name: 'pg_foreign_table',
        oid: 3118,
        columns: columns(['ftrelid', oid], ['ftserver', oid], ['ftoptions', typeOf('text_array')]),
    },
    {
        // `pg_user_mappings` is a view over `pg_user_mapping`; psql only reads
        // the exposed column shape.
        name: 'pg_user_mappings',
        oid: 1418,
        view: true,
        columns: columns(
            ['umid', oid],
            ['srvid', oid],
            ['srvname', name],
            ['umuser', oid],
            ['usename', name],
            ['umoptions', typeOf('text_array')],
        ),
    },
    {
        name: 'pg_db_role_setting',
        oid: 2964,
        columns: columns(['oid', oid], ['setrole', oid], ['setdatabase', oid], ['setconfig', typeOf('text_array')]),
    },
    {
        name: 'pg_event_trigger',
        oid: 3466,
        columns: columns(
            ['oid', oid],
            ['evtname', name],
            ['evtevent', name],
            ['evtowner', oid],
            ['evtfoid', oid],
            ['evtenabled', char],
            ['evttags', typeOf('text_array')],
        ),
    },
    {
        name: 'pg_default_acl',
        oid: 1034,
        columns: columns(['oid', oid], ['defaclrole', oid], ['defaclnamespace', oid], ['defaclobjtype', char], ['defaclacl', typeOf('text_array')]),
    },
    {
        name: 'pg_auth_members',
        oid: 1261,
        columns: columns(
            ['oid', oid],
            ['roleid', oid],
            ['member', oid],
            ['grantor', oid],
            ['admin_option', bool],
            ['inherit_option', bool],
            ['set_option', bool],
        ),
    },
    {
        name: 'pg_subscription',
        oid: 6100,
        columns: columns(
            ['oid', oid],
            ['subdbid', oid],
            ['subname', name],
            ['subowner', oid],
            ['subenabled', bool],
            ['subconninfo', text],
            ['subslotname', name],
            ['subsynccommit', text],
            ['subpublications', typeOf('text_array')],
        ),
    },
    {
        name: 'pg_ts_parser',
        oid: 3601,
        columns: columns(
            ['oid', oid],
            ['prsname', name],
            ['prsnamespace', oid],
            ['prsstart', oid],
            ['prstoken', oid],
            ['prsend', oid],
            ['prsheadline', oid],
            ['prslextype', oid],
        ),
    },
    {
        name: 'pg_ts_dict',
        oid: 3600,
        columns: columns(
            ['oid', oid],
            ['dictname', name],
            ['dictnamespace', oid],
            ['dictowner', oid],
            ['dicttemplate', oid],
            ['dictinitoption', text],
        ),
    },
    {
        name: 'pg_ts_template',
        oid: 3764,
        columns: columns(
            ['oid', oid],
            ['tmplname', name],
            ['tmplnamespace', oid],
            ['tmplinit', oid],
            ['tmpllexize', oid],
        ),
    },
    {
        name: 'pg_ts_config',
        oid: 3602,
        columns: columns(['oid', oid], ['cfgname', name], ['cfgnamespace', oid], ['cfgowner', oid], ['cfgparser', oid]),
    },
    {
        name: 'pg_ts_config_map',
        oid: 3603,
        columns: columns(['mapcfg', oid], ['maptokentype', int4], ['mapseqno', int4], ['mapdict', oid]),
    },
    {
        name: 'pg_cast',
        oid: 2605,
        columns: columns(
            ['oid', oid],
            ['castsource', oid],
            ['casttarget', oid],
            ['castfunc', oid],
            ['castcontext', char],
            ['castmethod', char],
        ),
    },
    {
        // A view over session portals, so its rows come from the live session
        // rather than from the catalog document.
        name: 'pg_cursors',
        oid: 12077,
        view: true,
        columns: columns(
            ['name', text],
            ['statement', text],
            ['is_holdable', bool],
            ['is_binary', bool],
            ['is_scrollable', bool],
            ['creation_time', typeOf('timestamptz')],
        ),
    },
    {
        // A view over the user relations with `relkind = 'v'`.
        name: 'pg_views',
        oid: 12028,
        view: true,
        columns: columns(['schemaname', name], ['viewname', name], ['viewowner', name], ['definition', text]),
    },
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

/** Oids for the seeded `plpgsql` language and extension, matching a fresh 16 cluster. */
const PLPGSQL_LANGUAGE_OID = 13699;
const PLPGSQL_EXTENSION_OID = 15096;
const PLPGSQL_HANDLERS = {
    call: 'plpgsql_call_handler()',
    inline: 'plpgsql_inline_handler(internal)',
    validator: 'plpgsql_validator(oid)',
};

const AM_DESCRIPTIONS: Record<number, string> = {
    2: 'heap table access method',
    403: 'b-tree index access method',
    405: 'hash index access method',
    783: 'GiST index access method',
    2742: 'GIN index access method',
    3580: 'block range index (BRIN) access method',
    4000: 'SP-GiST index access method',
};

const AM_HANDLER_NAMES: Record<number, string> = {
    5: 'heap_tableam_handler',
    330: 'bthandler',
    331: 'hashhandler',
    332: 'gisthandler',
    333: 'ginhandler',
    4600: 'brinhandler',
    4001: 'spghandler',
};

/** `regproc`/`regprocedure` name for the built-in handlers this projection seeds. */
export function functionNameFor(oidValue: number): string | null {
    return AM_HANDLER_NAMES[oidValue] ?? null;
}

/** `obj_description` rows the projection seeds; user objects carry no comment. */
const OBJECT_DESCRIPTIONS: [number, number, string][] = [
    [2615, 2200, 'standard public schema'],
    [3079, PLPGSQL_EXTENSION_OID, 'PL/pgSQL procedural language'],
    [2612, PLPGSQL_LANGUAGE_OID, 'PL/pgSQL procedural language'],
    ...AMS.map((am): [number, number, string] => [2601, am.oid, AM_DESCRIPTIONS[am.oid]!]),
];

/** `pg_describe_object` entries for the members of the seeded `plpgsql` extension. */
const DEPENDENCY_DESCRIPTIONS: [number, number, string][] = [
    [1255, 13693, 'function plpgsql_call_handler()'],
    [1255, 13694, 'function plpgsql_inline_handler(internal)'],
    [1255, 13695, 'function plpgsql_validator(oid)'],
    [2612, PLPGSQL_LANGUAGE_OID, 'language plpgsql'],
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
    { oid: 1700, name: 'numeric', len: -1, byval: false, category: 'N', arrayOid: 1231, collation: 0 },
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
        case 1700:
            return typeOf('numeric', typmod);
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
        case 17:
            return typeOf('bytea');
        case 1000:
            return typeOf('bool_array');
        case 1002:
            return typeOf('char_array');
        case 1005:
            return typeOf('int2_array');
        case 1007:
            return typeOf('int4_array');
        case 1009:
            return typeOf('text_array');
        case 1016:
            return typeOf('int8_array');
        case 1021:
            return typeOf('float4_array');
        case 1022:
            return typeOf('float8_array');
        case 1028:
            return typeOf('oid_array');
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

/** Resolves a `regclass` input written as a name or a numeric oid. */
export function relationOidForName(doc: CatalogDoc, text: string): number | null {
    if (/^\d+$/.test(text)) return Number(text);
    const parts = text.split('.').map((part) => part.replace(/"/g, ''));
    const name = parts[parts.length - 1]!;
    const system = SYSTEM_BY_NAME.get(name);
    if (system && (parts.length === 1 || parts[parts.length - 2] === 'pg_catalog')) return system.oid;
    for (const relation of doc.relations) if (relation.name === name) return relation.oid;
    for (const index of doc.indexes) if (index.name === name) return index.oid;
    for (const constraint of doc.constraints) {
        if (!constraint.indexOid) continue;
        const index = doc.indexes.find((candidate) => candidate.oid === constraint.indexOid);
        if (index && index.name === name) return index.oid;
    }
    return null;
}

/** The oid of a system relation named in a catalog argument. */
export function systemRelationOidForName(text: string): number | null {
    const bare = text.includes('.') ? text.slice(text.lastIndexOf('.') + 1) : text;
    return SYSTEM_BY_NAME.get(bare)?.oid ?? null;
}

/** `obj_description` over the seeded comment projection. */
export function objectDescription(classOid: number, objectOid: number): SqlValue {
    const entry = OBJECT_DESCRIPTIONS.find(([classoid, objoid]) => classoid === classOid && objoid === objectOid);
    return entry ? entry[2] : null;
}

/** `pg_describe_object` over the seeded `plpgsql` extension members. */
export function describeObject(classid: SqlValue, objid: SqlValue): SqlValue {
    const entry = DEPENDENCY_DESCRIPTIONS.find(([classOid, objectOid]) => classOid === Number(classid) && objectOid === Number(objid));
    return entry ? entry[2] : null;
}

const NAMESPACE_NAMES = new Map<number, string>([
    [11, 'pg_catalog'],
    [99, 'pg_toast'],
    [2200, 'public'],
    [13207, 'information_schema'],
]);

/** `regnamespace` output for the namespaces this cluster publishes. */
export function namespaceNameFor(oidValue: SqlValue): SqlValue {
    return typeof oidValue === 'number' ? NAMESPACE_NAMES.get(oidValue) ?? null : oidValue;
}

/** One row of `pg_cursors`, supplied by the live session for its open portals. */
export interface CursorViewRow {
    name: string;
    statement: string;
    isHoldable: boolean;
    isBinary: boolean;
    isScrollable: boolean;
    creationTime: string;
}

/** Projects the whole `pg_catalog` surface from the single catalog document. */
export function catalogTables(
    doc: CatalogDoc,
    databases: ClusterDatabase[],
    roles: ClusterRole[],
    cursors: CursorViewRow[] = [],
): Map<string, TableData> {
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

    for (const cursor of cursors) {
        push('pg_cursors', {
            name: cursor.name,
            statement: cursor.statement,
            is_holdable: cursor.isHoldable,
            is_binary: cursor.isBinary,
            is_scrollable: cursor.isScrollable,
            creation_time: cursor.creationTime,
        });
    }

    for (const namespace of SYSTEM_NAMESPACES) {
        push('pg_namespace', {
            oid: namespace.oid,
            nspname: namespace.name,
            nspowner: namespace.name === 'public' ? PG_DATABASE_OWNER_ROLE : POSTGRES_ROLE,
            nspacl: doc.namespaceAcls?.[String(namespace.oid)] ?? defaultNamespaceAcl(namespace.name),
        });
    }

    const systemClassRow = (relation: SystemRelation): Record<string, SqlValue> => ({
        oid: relation.oid,
        relname: relation.name,
        relnamespace: PG_CATALOG_NAMESPACE,
        reltype: 0,
        reloftype: 0,
        relowner: POSTGRES_ROLE,
        relam: relation.view ? 0 : 2,
        relfilenode: relation.view ? 0 : relation.oid,
        reltablespace: 0,
        relpages: 0,
        reltuples: 0,
        relallvisible: 0,
        reltoastrelid: 0,
        relhasindex: false,
        relisshared: false,
        relpersistence: 'p',
        relkind: relation.view ? 'v' : 'r',
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
        const attributeCount = relation.relkind === 'S'
            ? 0
            : doc.columns.filter((column) => column.relid === relation.oid).length;
        const checkCount = doc.constraints.filter((constraint) => constraint.relid === relation.oid && constraint.contype === 'c').length;
        // Foreign keys install internal triggers on both relations, so psql
        // only asks for FK (and trigger) details when this flag is set.
        const hasTriggers = doc.constraints.some(
            (constraint) => constraint.contype === 'f' && (constraint.relid === relation.oid || constraint.confrelid === relation.oid),
        );
        return {
            oid: relation.oid,
            relname: relation.name,
            relnamespace: relation.namespace,
            reltype: 0,
            reloftype: 0,
            relowner: relation.owner,
            relam: relation.relam,
            relfilenode: relation.oid,
            relacl: relation.relacl ?? null,
            reltablespace: 0,
            relpages: 0,
            reltuples: 0,
            relallvisible: 0,
            reltoastrelid: 0,
            relhasindex: relation.relkind === 'r' ? doc.indexes.some((index) => index.relid === relation.oid) : false,
            relisshared: false,
            relpersistence: relation.persistence ?? 'p',
            relkind: relation.relkind,
            relnatts: attributeCount,
            relchecks: checkCount,
            relhasrules: false,
            relhastriggers: hasTriggers,
            relhassubclass: false,
            relrowsecurity: false,
            relforcerowsecurity: false,
            relispopulated: true,
            relreplident: relation.relkind === 'r' ? 'd' : 'n',
            relispartition: false,
            relrewrite: 0,
            relfrozenxid: 0,
            relminmxid: 0,
        };
    };

    for (const relation of SYSTEM_RELATIONS) push('pg_class', systemClassRow(relation));
    for (const relation of doc.relations) push('pg_class', classRow(relation));

    for (const relation of doc.relations) {
        if (relation.relkind !== 'v') continue;
        const stored = doc.views.find((view) => view.oid === relation.oid);
        push('pg_views', {
            schemaname: SYSTEM_NAMESPACES.find((namespace) => namespace.oid === relation.namespace)?.name ?? 'public',
            viewname: relation.name,
            viewowner: pgGetUserById(relation.owner, roles),
            definition: stored?.definition ?? null,
        });
    }

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
                attcompression: '',
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
            attstorage: storageForType(column.typeOid),
            attcompression: '',
            attnotnull: column.notNull,
            atthasdef: column.defaultText !== null,
            atthasmissing: false,
            attidentity: column.identity ?? '',
            attgenerated: '',
            attisdropped: false,
            attislocal: true,
            attinhcount: 0,
            attcollation: 0,
        });
    }

    for (const am of AMS) push('pg_am', { oid: am.oid, amname: am.name, amhandler: AM_HANDLER_NAMES[am.handler] ?? am.handler, amtype: am.type });

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
        const keyCount = index.keys?.length ?? index.indkey.length;
        // `indoption` only carries the key columns, not `INCLUDE` columns.
        const options: string[] = [];
        for (let position = 0; position < keyCount; position++) {
            const key = index.keys?.[position];
            options.push(key === undefined ? '0' : String((key.desc === true ? 1 : 0) | (key.nullsFirst === true ? 2 : 0)));
        }
        const zeros = index.indkey.map(() => '0').join(' ');
        push('pg_index', {
            indexrelid: index.oid,
            indrelid: index.relid,
            indnatts: index.indkey.length,
            indnkeyatts: keyCount,
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
            indcollation: zeros,
            indclass: zeros,
            indoption: options.join(' '),
        });
        push('pg_indexes', {
            schemaname: 'public',
            tablename: relationByOid(doc, index.relid)?.name ?? null,
            indexname: index.name,
            tablespace: null,
            indexdef: pgGetIndexDef(doc, index.oid, false),
        });
    }

    for (const constraint of doc.constraints) {
        push('pg_constraint', {
            oid: constraint.oid,
            conname: constraint.name,
            connamespace: PUBLIC_NAMESPACE,
            contype: constraint.contype,
            condeferrable: constraint.condeferrable ?? false,
            condeferred: constraint.condeferred ?? false,
            convalidated: constraint.convalidated,
            conrelid: constraint.relid,
            contypid: 0,
            conindid: constraint.indexOid ?? 0,
            conparentid: 0,
            confrelid: constraint.confrelid,
            confupdtype: constraint.confupdtype,
            confdeltype: constraint.confdeltype,
            confmatchtype: constraint.confmatchtype ?? 's',
            conislocal: true,
            coninhcount: 0,
            connoinherit: true,
            conkey: constraint.conkey.map(String).join(' '),
            confkey: constraint.confkey.map(String).join(' '),
            conbin: constraint.checkSource === null ? null : `(${constraint.checkSource})`,
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

    for (const role of roles) {
        push('pg_roles', {
            oid: role.oid,
            rolname: role.rolname,
            rolsuper: role.rolsuper,
            rolinherit: role.rolinherit,
            rolcreaterole: role.rolcreaterole,
            rolcreatedb: role.rolcreatedb,
            rolcanlogin: role.rolcanlogin,
            rolreplication: role.rolreplication,
            rolbypassrls: role.rolbypassrls,
            rolconnlimit: role.rolconnlimit,
            rolpassword: role.rolpassword === undefined ? null : '********',
            rolvaliduntil: null,
            rolconfig: null,
        });
    }

    for (const database of databases) {
        push('pg_database', {
            oid: database.oid,
            datname: database.datname,
            datdba: database.datdba,
            encoding: database.encoding,
            datlocprovider: database.datlocprovider,
            datistemplate: database.datistemplate,
            datallowconn: database.datallowconn,
            datconnlimit: database.datconnlimit,
            datfrozenxid: database.datfrozenxid,
            datminmxid: database.datminmxid,
            dattablespace: database.dattablespace,
            datcollate: database.datcollate,
            datctype: database.datctype,
            daticulocale: database.daticulocale,
            daticurules: database.daticurules,
            datcollversion: database.datcollversion,
            datacl: database.datacl,
        });
    }

    push('pg_tablespace', { oid: 1663, spcname: 'pg_default', spcowner: POSTGRES_ROLE });
    push('pg_tablespace', { oid: 1664, spcname: 'pg_global', spcowner: POSTGRES_ROLE });

    push('pg_language', {
        oid: PLPGSQL_LANGUAGE_OID,
        lanname: 'plpgsql',
        lanowner: POSTGRES_ROLE,
        lanispl: true,
        lanpltrusted: true,
        lanplcallfoid: PLPGSQL_HANDLERS.call,
        laninline: PLPGSQL_HANDLERS.inline,
        lanvalidator: PLPGSQL_HANDLERS.validator,
        lanacl: null,
    });
    push('pg_extension', {
        oid: PLPGSQL_EXTENSION_OID,
        extname: 'plpgsql',
        extowner: POSTGRES_ROLE,
        extnamespace: 11,
        extrelocatable: false,
        extversion: '1.0',
        extconfig: null,
        extcondition: null,
    });
    for (const [classoid, objoid, description] of OBJECT_DESCRIPTIONS) {
        push('pg_description', { objoid, classoid, objsubid: 0, description });
    }
    for (const [classid, objid] of DEPENDENCY_DESCRIPTIONS) {
        push('pg_depend', {
            classid,
            objid,
            objsubid: 0,
            refclassid: 3079,
            refobjid: PLPGSQL_EXTENSION_OID,
            refobjsubid: 0,
            deptype: 'e',
        });
    }

    return tables;
}

/** `pg_get_userbyid`. */
export function pgGetUserById(oidValue: SqlValue, roles: ClusterRole[] = []): SqlValue {
    if (oidValue === POSTGRES_ROLE) return 'postgres';
    if (oidValue === PG_DATABASE_OWNER_ROLE) return 'pg_database_owner';
    for (const role of roles) {
        if (role.oid === oidValue) return role.rolname;
    }
    return null;
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

const REFERENCE_ACTIONS: Record<string, string> = {
    a: 'NO ACTION',
    r: 'RESTRICT',
    c: 'CASCADE',
    n: 'SET NULL',
    d: 'SET DEFAULT',
};

/** `pg_get_indexdef(indexrelid, 0, pretty)`. */
export function pgGetIndexDef(doc: CatalogDoc, indexOid: SqlValue, pretty = true): SqlValue {
    if (typeof indexOid !== 'number') return null;
    const index = doc.indexes.find((candidate) => candidate.oid === indexOid);
    const relation = index ? relationByOid(doc, index.relid) : undefined;
    if (!index || !relation) return null;
    const keyCount = index.keys?.length ?? index.indkey.length;
    const entries: string[] = [];
    for (let position = 0; position < keyCount; position++) {
        const key = index.keys?.[position];
        let entry: string;
        if (key?.expression !== undefined) {
            entry = pretty ? key.pretty ?? `(${key.expression})` : key.raw ?? `((${key.expression}))`;
        }
        else {
            const attnum = key?.attnum ?? index.indkey[position];
            entry = doc.columns.find((column) => column.relid === index.relid && column.attnum === attnum)?.name ?? `attnum${attnum}`;
        }
        if (key !== undefined) {
            const desc = key.desc === true;
            const nullsFirst = key.nullsFirst === true;
            if (desc) entry += ' DESC';
            if (desc !== nullsFirst) entry += nullsFirst ? ' NULLS FIRST' : ' NULLS LAST';
        }
        entries.push(entry);
    }
    const include = index.keys === undefined ? [] : index.indkey.slice(keyCount);
    const includeText = include.length === 0
        ? ''
        : ` INCLUDE (${columnNames(doc, index.relid, include).join(', ')})`;
    const unique = index.unique ? 'UNIQUE ' : '';
    const table = pretty ? relation.name : `public.${relation.name}`;
    const predicate = index.predicate === null ? '' : pretty ? ` WHERE ${index.predicate}` : ` WHERE (${index.predicate})`;
    return `CREATE ${unique}INDEX ${index.name} ON ${table} USING ${index.method} (${entries.join(', ')})${includeText}${predicate}`;
}

function columnNames(doc: CatalogDoc, relid: number, attnums: number[]): string[] {
    return attnums.map((attnum) => doc.columns.find((column) => column.relid === relid && column.attnum === attnum)?.name ?? `attnum${attnum}`);
}

/** `pg_get_constraintdef(oid, pretty)`. */
export function pgGetConstraintDef(doc: CatalogDoc, constraintOid: SqlValue, pretty = true): SqlValue {
    if (typeof constraintOid !== 'number') return null;
    const constraint = doc.constraints.find((candidate) => candidate.oid === constraintOid);
    if (!constraint) return null;
    const names = columnNames(doc, constraint.relid, constraint.conkey);
    switch (constraint.contype) {
        case 'p':
            return `PRIMARY KEY (${names.join(', ')})`;
        case 'u':
            return `UNIQUE (${names.join(', ')})`;
        case 'c': {
            const expression = constraint.checkSource ?? '';
            const check = pretty ? `CHECK (${expression})` : `CHECK ((${expression}))`;
            return constraint.convalidated ? check : `${check} NOT VALID`;
        }
        case 'f': {
            const referenced = relationByOid(doc, constraint.confrelid);
            const referencedNames = columnNames(doc, constraint.confrelid, constraint.confkey);
            const target = `${referenced?.name ?? `oid${constraint.confrelid}`}(${referencedNames.join(', ')})`;
            let definition = `FOREIGN KEY (${names.join(', ')}) REFERENCES ${target}`;
            if (constraint.confmatchtype === 'f') definition += ' MATCH FULL';
            if (constraint.confupdtype !== 'a') {
                definition += ` ON UPDATE ${REFERENCE_ACTIONS[constraint.confupdtype] ?? constraint.confupdtype}`;
            }
            if (constraint.confdeltype !== 'a') {
                definition += ` ON DELETE ${REFERENCE_ACTIONS[constraint.confdeltype] ?? constraint.confdeltype}`;
            }
            if (constraint.condeferrable) definition += constraint.condeferred ? ' DEFERRABLE INITIALLY DEFERRED' : ' DEFERRABLE';
            return definition;
        }
    }
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

/** PostgreSQL's default `typstorage` for the types this server stores. */
function storageForType(typeOidValue: number): string {
    if (typeOidValue === 1700) return 'm';
    if (typeOidValue === 25 || typeOidValue === 1042 || typeOidValue === 1043) return 'x';
    return 'p';
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
    // Catalogs written before views existed carry no `views` array.
    if (doc.views === undefined) doc.views = [];
    return doc;
}
