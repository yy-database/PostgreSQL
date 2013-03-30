/** A statement-level failure that turns into an `ErrorResponse`. */

/** Extra structured fields carried on the wire as `s`/`t`/`c`/`d` and `F`/`L`/`R`. */
export interface ServerErrorFields {
    /** `s`, the schema name that owns the failing relation. */
    schema?: string;
    /** `t`, the relation name a constraint or column belongs to. */
    table?: string;
    /** `c`, the column a violation is reported against. */
    column?: string;
    /** `d`, the data type an input or overflow error is reported against. */
    dataType?: string;
    /** `F`, the source file, filled from the construction site when omitted. */
    sourceFile?: string;
    /** `L`, the source line, filled from the construction site when omitted. */
    sourceLine?: string;
    /** `R`, the source routine, filled from the construction site when omitted. */
    sourceRoutine?: string;
}

/** Reads the first stack frame outside this file, like PostgreSQL's `F`/`L`/`R`. */
function captureSource(target: ServerError): void {
    Error.captureStackTrace(target, ServerError);
    const frames = (target.stack ?? '').split('\n').slice(1);
    for (const frame of frames) {
        const text = frame.trim().replace(/^at\s+/, '');
        const named = /^(.*?)\s+\((.+):(\d+):(\d+)\)$/.exec(text);
        const bare = /^(.+):(\d+):(\d+)$/.exec(text);
        const file = named?.[2] ?? bare?.[1];
        if (file === undefined) continue;
        if (/errors\.(?:ts|js)$/.test(file)) continue;
        const routine = (named?.[1] ?? '<anonymous>').replace(/^async\s+/, '');
        target.sourceFile = file.split(/[/\\]/).pop() ?? file;
        target.sourceLine = named?.[3] ?? bare?.[2] ?? '0';
        target.sourceRoutine = routine;
        return;
    }
}

/** A statement-level failure that turns into an `ErrorResponse`. */
export class ServerError extends Error {
    readonly code: string;
    readonly detail: string | undefined;
    /** `HINT` text, rendered by psql as a separate `HINT:` line. */
    readonly hint: string | undefined;
    /** `CONTEXT` text, rendered by psql as `CONTEXT:  ...`. */
    context: string | undefined;
    /** Zero-based byte offset into the statement, surfaced as `P` on the wire. */
    position: number | undefined;
    /** Constraint name, surfaced as `n` on the wire and read by drivers. */
    constraint: string | undefined;
    /** `s`, surfaced as `schema_name` on driver error objects. */
    readonly schema: string | undefined;
    /** `t`, surfaced as `table_name` on driver error objects. */
    readonly table: string | undefined;
    /** `c`, surfaced as `column_name` on driver error objects. */
    readonly column: string | undefined;
    /** `d`, surfaced as `datatype_name` on driver error objects. */
    readonly dataType: string | undefined;
    /** `F`, surfaced as `message_file` on driver error objects. */
    sourceFile: string | undefined;
    /** `L`, surfaced as `message_line` on driver error objects. */
    sourceLine: string | undefined;
    /** `R`, surfaced as `message_routine` on driver error objects. */
    sourceRoutine: string | undefined;

    constructor(
        code: string,
        message: string,
        detail?: string,
        position?: number,
        hint?: string,
        context?: string,
        constraint?: string,
        fields?: ServerErrorFields,
    ) {
        super(message);
        this.code = code;
        this.detail = detail;
        this.position = position;
        this.hint = hint;
        this.context = context;
        this.constraint = constraint;
        this.schema = fields?.schema;
        this.table = fields?.table;
        this.column = fields?.column;
        this.dataType = fields?.dataType;
        this.sourceFile = fields?.sourceFile;
        this.sourceLine = fields?.sourceLine;
        this.sourceRoutine = fields?.sourceRoutine;
        if (this.sourceFile === undefined || this.sourceLine === undefined || this.sourceRoutine === undefined) {
            captureSource(this);
        }
    }
}
