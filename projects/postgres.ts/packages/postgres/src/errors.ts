/** The family error envelope, specialized for PostgreSQL wire failures. */

import type { ErrorInfo, MessageFieldInfo } from './native.ts';

export type DatabasePhase = 'configuration' | 'open' | 'connect' | 'execute' | 'commit' | 'close';

/** Whether the request reached the server and whether its outcome is known. */
export type DatabaseExecution = 'not-sent' | 'unknown' | 'replied';

/** A hint for the caller, never an instruction to retry automatically. */
export type DatabaseRetry = 'never' | 'safe' | 'application-decision';

export interface PostgreSQLFailureInit {
    code: string;
    message: string;
    phase: DatabasePhase;
    execution: DatabaseExecution;
    retry: DatabaseRetry;
    detail?: string;
    constraint?: string;
    severity?: string;
    hint?: string;
    position?: number;
    cause?: unknown;
}

/** A PostgreSQL failure carrying `SQLSTATE`, wire detail fields and outcome certainty. */
export class PostgreSQLError extends Error {
    readonly product = 'postgresql' as const;
    /** `SQLSTATE` code, or a connection-class code for transport failures. */
    readonly code: string;
    readonly phase: DatabasePhase;
    readonly execution: DatabaseExecution;
    readonly retry: DatabaseRetry;
    /** `D` field from the server, when it sent one. */
    readonly detail: string | undefined;
    /** `n` field: the violated constraint's name, when it sent one. */
    readonly constraint: string | undefined;
    /** `S` field. */
    readonly severity: string | undefined;
    /** `H` field. */
    readonly hint: string | undefined;
    /** `P` field: zero-based byte offset into the statement. */
    readonly position: number | undefined;

    constructor(init: PostgreSQLFailureInit) {
        super(init.message);
        this.name = 'PostgreSQLError';
        this.code = init.code;
        this.phase = init.phase;
        this.execution = init.execution;
        this.retry = init.retry;
        this.detail = init.detail;
        this.constraint = init.constraint;
        this.severity = init.severity;
        this.hint = init.hint;
        this.position = init.position;
        if (init.cause !== undefined) this.cause = init.cause;
    }
}

/** Reads one wire field by its selector, such as `C` or `n`. */
function fieldOf(fields: readonly MessageFieldInfo[], kind: string): string | undefined {
    return fields.find((field) => field.kind === kind)?.value;
}

/** Builds the envelope for one decoded `ErrorResponse`. */
export function serverFailure(info: ErrorInfo, phase: DatabasePhase): PostgreSQLError {
    const position = fieldOf(info.fields, 'P');
    const detail = fieldOf(info.fields, 'D');
    const constraint = fieldOf(info.fields, 'n');
    const severity = fieldOf(info.fields, 'S');
    const hint = fieldOf(info.fields, 'H');
    return new PostgreSQLError({
        code: info.code,
        message: info.message,
        phase,
        execution: 'replied',
        retry: info.code.startsWith('08') ? 'application-decision' : 'never',
        ...(detail === undefined ? {} : { detail }),
        ...(constraint === undefined ? {} : { constraint }),
        ...(severity === undefined ? {} : { severity }),
        ...(hint === undefined ? {} : { hint }),
        ...(position === undefined ? {} : { position: Number(position) - 1 }),
    });
}

/**
 * Wraps a failure thrown by the native binding. The binding renders server
 * errors as `CODE: message`; everything else that reaches a throw is a
 * transport or protocol break, so the outcome of a running request is unknown.
 */
export function transportFailure(cause: unknown, phase: DatabasePhase): PostgreSQLError {
    const message = cause instanceof Error ? cause.message : String(cause);
    const coded = /^([0-9A-Z]{5}): (.*)$/s.exec(message);
    if (coded !== null) {
        return new PostgreSQLError({
            code: coded[1] as string,
            message: coded[2] as string,
            phase,
            execution: 'replied',
            retry: 'never',
            cause,
        });
    }
    if (/connection is closed|unusable after/.test(message)) {
        return new PostgreSQLError({ code: '08003', message, phase, execution: 'not-sent', retry: 'never', cause });
    }
    return new PostgreSQLError({
        code: '08006',
        message,
        phase,
        execution: 'unknown',
        retry: 'application-decision',
        cause,
    });
}

/** A failure decided before any request left the process. */
export function configurationFailure(message: string): PostgreSQLError {
    return new PostgreSQLError({ code: '22023', message, phase: 'configuration', execution: 'not-sent', retry: 'never' });
}

/** A business call against an object whose state forbids it. */
export function stateFailure(message: string): PostgreSQLError {
    return new PostgreSQLError({ code: '08003', message, phase: 'execute', execution: 'not-sent', retry: 'never' });
}
