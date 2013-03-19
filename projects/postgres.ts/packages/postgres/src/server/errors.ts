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

    constructor(code: string, message: string, detail?: string, position?: number, hint?: string, context?: string) {
        super(message);
        this.code = code;
        this.detail = detail;
        this.position = position;
        this.hint = hint;
        this.context = context;
    }
}
