/** A statement-level failure that turns into an `ErrorResponse`. */
export class ServerError extends Error {
    readonly code: string;
    readonly detail: string | undefined;

    constructor(code: string, message: string, detail?: string) {
        super(message);
        this.code = code;
        this.detail = detail;
    }
}
