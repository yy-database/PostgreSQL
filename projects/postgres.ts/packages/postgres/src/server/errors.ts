/** A statement-level failure that turns into an `ErrorResponse`. */
export class ServerError extends Error {
    readonly code: string;
    readonly detail: string | undefined;
    /** Zero-based byte offset into the statement, surfaced as `P` on the wire. */
    position: number | undefined;

    constructor(code: string, message: string, detail?: string, position?: number) {
        super(message);
        this.code = code;
        this.detail = detail;
        this.position = position;
    }
}
