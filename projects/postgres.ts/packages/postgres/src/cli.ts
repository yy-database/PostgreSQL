import { query } from './client.ts';
import { loadNative, type ClientOptions, type StatementResult } from './native.ts';

/** Effective `psql` command line options. */
export interface PsqlOptions extends ClientOptions {
    sql: string;
    headers: boolean;
    separator: string;
    nullValue: string;
}

/** Parses the supported `psql` flags, rejecting anything else. */
export function argumentsFor(args: string[]): PsqlOptions {
    return loadNative().parsePsqlArguments(args);
}

/** Turns result sets into the lines `psql` prints. */
export function formatResults(results: StatementResult[], options: PsqlOptions): string[] {
    return loadNative().formatPsqlResults(results, options);
}

export function usage(): string {
    return 'Usage: psql [-h HOST] [-p PORT] [-U USER] [-d DATABASE] [-t] [-F SEP] [-P null=TEXT] -c SQL';
}

/** Runs the command line. Returns the process exit code. */
export async function main(args: string[]): Promise<number> {
    const [first] = args;
    if (args.length === 1 && first !== undefined && ['-V', '--version'].includes(first)) {
        console.log(`psql (postgres ${loadNative().version()})`);
        return 0;
    }
    if (args.length === 1 && first === '--help') {
        console.log(usage());
        return 0;
    }
    const options = argumentsFor(args);
    const lines = formatResults(query(options), options);
    for (const line of lines) console.log(line);
    return 0;
}
