/** PostgreSQL text-array ACLs: parsing, serialising, granting and revoking. */

export type AclObjectType = 'database' | 'schema' | 'table';

export interface AclEntry {
    /** Empty string is `PUBLIC`. */
    grantee: string;
    /** Privilege letters, with `*` marking a grant option. */
    privileges: string;
    grantor: string;
}

/** Privilege name to letter, per object type. */
const PRIVILEGE_LETTERS: Record<AclObjectType, Record<string, string>> = {
    database: { connect: 'c', create: 'C', temp: 'T', temporary: 'T' },
    schema: { usage: 'U', create: 'C' },
    table: { select: 'r', insert: 'a', update: 'w', delete: 'd', truncate: 'D', references: 'x', trigger: 't' },
};

/** Canonical letter order PostgreSQL prints inside one ACL entry. */
const LETTER_ORDER: Record<AclObjectType, string> = {
    database: 'CTc',
    schema: 'UC',
    table: 'arwdDxt',
};

export function privilegeLetter(objectType: AclObjectType, privilege: string): string | undefined {
    return PRIVILEGE_LETTERS[objectType][privilege.toLowerCase()];
}

/** Expands `ALL` to every letter this object type supports. */
export function privilegeLetters(objectType: AclObjectType, privileges: string[]): string[] {
    const letters = new Set<string>();
    for (const privilege of privileges) {
        if (privilege.toUpperCase() === 'ALL') {
            for (const letter of LETTER_ORDER[objectType]) letters.add(letter);
            continue;
        }
        const letter = privilegeLetter(objectType, privilege);
        if (letter === undefined) return [];
        letters.add(letter);
    }
    return [...letters];
}

function sortPrivileges(objectType: AclObjectType, privileges: string): string {
    const present = new Map<string, boolean>();
    for (const character of privileges) {
        if (character === '*') continue;
        present.set(character, privileges.includes(`${character}*`));
    }
    let ordered = '';
    for (const letter of LETTER_ORDER[objectType]) {
        if (!present.has(letter)) continue;
        ordered += letter;
        if (present.get(letter)) ordered += '*';
    }
    return ordered;
}

/** Quotes one role name when it is not a plain lower-case identifier. */
function quoteRole(name: string): string {
    if (name.length === 0) return '';
    if (/^[a-z_][a-z0-9_$]*$/.test(name)) return name;
    return `"${name.replaceAll('"', '""')}"`;
}

/** Renders entries as the `{...}` literal PostgreSQL stores in `datacl`/`nspacl`/`relacl`. */
export function formatAcl(entries: AclEntry[]): string {
    if (entries.length === 0) return '{}';
    return `{${entries
        .map((entry) => `${quoteRole(entry.grantee)}=${entry.privileges}/${quoteRole(entry.grantor)}`)
        .join(',')}}`;
}

/** Splits a text-array literal into ACL entries, unquoting role names. */
export function parseAcl(text: string): AclEntry[] {
    const body = text.trim().replace(/^\{/, '').replace(/\}$/, '');
    if (body.length === 0) return [];
    const entries: AclEntry[] = [];
    let current = '';
    let quoted = false;
    for (let index = 0; index < body.length; index += 1) {
        const character = body[index]!;
        if (quoted) {
            if (character === '\\') {
                current += body[index + 1] ?? '';
                index += 1;
            }
            else if (character === '"') {
                if (body[index + 1] === '"') {
                    current += '"';
                    index += 1;
                }
                else quoted = false;
            }
            else current += character;
            continue;
        }
        if (character === '"') {
            quoted = true;
            continue;
        }
        if (character === ',') {
            entries.push(parseEntry(current));
            current = '';
            continue;
        }
        current += character;
    }
    entries.push(parseEntry(current));
    return entries.filter((entry) => entry.privileges.length > 0 || entry.grantee.length > 0);
}

function parseEntry(text: string): AclEntry {
    const equals = text.indexOf('=');
    const slash = text.lastIndexOf('/');
    if (equals < 0 || slash <= equals) return { grantee: text, privileges: '', grantor: '' };
    return {
        grantee: text.slice(0, equals),
        privileges: text.slice(equals + 1, slash),
        grantor: slash < text.length - 1 ? text.slice(slash + 1) : '',
    };
}

/**
 * Adds privileges to `entries` the way `GRANT` does, materialising the object's
 * default ACL first when the column is still null.
 */
export function grantAcl(
    entries: AclEntry[],
    objectType: AclObjectType,
    grantees: string[],
    letters: string[],
    grantor: string,
    grantOption: boolean,
): AclEntry[] {
    for (const grantee of grantees) {
        let entry = entries.find((candidate) => candidate.grantee === grantee);
        if (!entry) {
            entry = { grantee, privileges: '', grantor };
            entries.push(entry);
        }
        for (const letter of letters) {
            entry.privileges = entry.privileges.replaceAll(`${letter}*`, '').replaceAll(letter, '');
            entry.privileges += grantOption ? `${letter}*` : letter;
        }
        entry.privileges = sortPrivileges(objectType, entry.privileges);
    }
    return entries;
}

/**
 * Removes privileges the way `REVOKE` does. Empty entries disappear, which is
 * why `REVOKE ALL` from an owner leaves `{}`.
 */
export function revokeAcl(
    entries: AclEntry[],
    objectType: AclObjectType,
    grantees: string[],
    letters: string[],
    grantOptionOnly: boolean,
): AclEntry[] {
    for (const grantee of grantees) {
        const entry = entries.find((candidate) => candidate.grantee === grantee);
        if (!entry) continue;
        for (const letter of letters) {
            if (grantOptionOnly) {
                entry.privileges = entry.privileges.replaceAll(`${letter}*`, letter);
            }
            else {
                entry.privileges = entry.privileges.replaceAll(`${letter}*`, '').replaceAll(letter, '');
            }
        }
        entry.privileges = sortPrivileges(objectType, entry.privileges);
    }
    return entries.filter((entry) => entry.privileges.length > 0);
}

/** `true` when one ACL entry grants `letter` to `user`, directly or via `PUBLIC`. */
export function aclGrants(entries: AclEntry[], user: string, letter: string): boolean {
    for (const entry of entries) {
        if (entry.grantee !== '' && entry.grantee !== user) continue;
        if (entry.privileges.includes(letter)) return true;
    }
    return false;
}

/** The implicit ACL PostgreSQL uses while a column is still null. */
export function defaultAcl(objectType: AclObjectType, owner: string): AclEntry[] {
    if (objectType === 'database') {
        return [
            { grantee: '', privileges: 'Tc', grantor: owner },
            { grantee: owner, privileges: 'CTc', grantor: owner },
        ];
    }
    if (objectType === 'schema') {
        return [
            { grantee: 'pg_database_owner', privileges: 'UC', grantor: 'pg_database_owner' },
            { grantee: '', privileges: 'U', grantor: 'pg_database_owner' },
        ];
    }
    return [{ grantee: owner, privileges: 'arwdDxt', grantor: owner }];
}

/** Default `nspacl` text for the four seeded namespaces. */
export function defaultNamespaceAcl(namespace: string): string | null {
    if (namespace === 'pg_catalog' || namespace === 'information_schema') return '{postgres=UC/postgres,=U/postgres}';
    if (namespace === 'public') return '{pg_database_owner=UC/pg_database_owner,=U/pg_database_owner}';
    return null;
}
