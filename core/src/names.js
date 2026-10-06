import semver from "semver"

/**
 * Package names look like npm scoped names: @scope/name, where the scope is the
 * owner's BeePM handle. @beemod is reserved for BEE2's own built-in packages
 * (e.g. @beemod/BEE2_CLEAN_STYLE), which BeePM never downloads.
 */

export const BUILTIN_SCOPE = "beemod"

// Like GitHub usernames: letters, digits and single hyphens, 1-39 characters
export const HANDLE_RE = /^[a-z0-9](?:[a-z0-9]|-(?=[a-z0-9])){0,38}$/

// Lowercase letters, digits, "-", "_" and "."; 1-64 characters; starts and ends alphanumeric
export const PACKAGE_NAME_RE = /^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/

// BEE2 package IDs from info.txt, e.g. BEE2_CLEAN_STYLE or ARENGS_PACKAGES (stored uppercase)
export const BEE_ID_RE = /^[A-Z0-9_]{1,128}$/

/** Uppercases a BEE2 ID and returns it, or null if it isn't a valid ID. */
export function normalizeBeeId(id) {
    const upper = String(id || "")
        .trim()
        .toUpperCase()
    return BEE_ID_RE.test(upper) ? upper : null
}

export const RESERVED_HANDLES = new Set([
    "admin",
    "administrator",
    "anonymous",
    "api",
    "beemod",
    "beepm",
    "bee",
    "bee2",
    "help",
    "login",
    "logout",
    "me",
    "mod",
    "moderator",
    "null",
    "official",
    "package",
    "packages",
    "registry",
    "root",
    "settings",
    "staff",
    "support",
    "system",
    "team",
    "undefined",
    "www",
])

export const isValidHandle = (handle) => typeof handle === "string" && HANDLE_RE.test(handle)

export function isValidPackageName(name, scope) {
    if (typeof name !== "string") return false
    if (scope === BUILTIN_SCOPE) return BEE_ID_RE.test(name)
    return PACKAGE_NAME_RE.test(name)
}

export const formatName = (scope, name) => `@${scope}/${name}`

/** Canonical case: names are lowercase, except built-in BEE2 IDs, which are uppercase. */
export const canonicalName = (scope, name) =>
    scope === BUILTIN_SCOPE ? String(name).toUpperCase() : String(name).toLowerCase()

/**
 * Splits "@scope/name" into { scope, name } in canonical case.
 * Returns null if it isn't a valid scoped name.
 */
export function parseName(fullName) {
    const match = /^@([^/@\s]+)\/([^/@\s]+)$/.exec(String(fullName || "").trim())
    if (!match) return null
    const scope = match[1].toLowerCase()
    const name = canonicalName(scope, match[2])
    if (!isValidHandle(scope) || !isValidPackageName(name, scope)) return null
    return { scope, name }
}

function isRange(text) {
    return text === "latest" || semver.validRange(text) !== null
}

/**
 * Parses what a user types after `beepm install`:
 *   @areng14/arengitems          { scope, name, range: null }
 *   @areng14/arengitems@^1.2.0   { scope, name, range: "^1.2.0" }
 *   arengitems / arengitems@1.0  { scope: null, name, range }   (resolved by name lookup)
 *   Areng14@arengitems[@1.0.0]   the old author@name form, same as @areng14/arengitems
 * "latest" means no range. Throws on anything else.
 */
export function parseSpec(input) {
    const spec = String(input || "").trim()
    if (!spec) throw new Error("Empty package name")

    let scope = null
    let rest = spec
    if (spec.startsWith("@")) {
        const slash = spec.indexOf("/")
        if (slash < 0) throw new Error(`"${spec}" is missing the /name part (expected @scope/name)`)
        scope = spec.slice(1, slash).toLowerCase()
        rest = spec.slice(slash + 1)
    }

    const parts = rest.split("@")
    let name = parts[0]
    let range = null

    if (scope) {
        if (parts.length > 2) throw new Error(`Invalid package name "${spec}"`)
        range = parts[1] ?? null
    } else if (parts.length === 2 && !isRange(parts[1])) {
        // Old author@name form
        scope = parts[0].toLowerCase()
        name = parts[1]
    } else if (parts.length === 2) {
        range = parts[1]
    } else if (parts.length === 3) {
        scope = parts[0].toLowerCase()
        name = parts[1]
        range = parts[2]
    } else if (parts.length > 3) {
        throw new Error(`Invalid package name "${spec}"`)
    }

    name = canonicalName(scope, name)
    if (scope && !isValidHandle(scope)) throw new Error(`Invalid scope "@${scope}"`)
    if (!isValidPackageName(name, scope)) throw new Error(`Invalid package name "${name}"`)
    if (range === "latest" || range === "") range = null
    if (range !== null && semver.validRange(range) === null) {
        throw new Error(`Invalid version range "${range}"`)
    }
    return { scope, name, range }
}

/**
 * Turns a provider username into a handle suggestion: "Areng14" -> "areng14",
 * "cool.user_99" -> "cool-user-99". Returns "" if nothing usable is left.
 */
export function suggestHandle(username) {
    return String(username || "")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 39)
        .replace(/-+$/, "")
}
