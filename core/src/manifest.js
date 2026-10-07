import semver from "semver"
import { normalizeCompat } from "./compat.js"
import {
    BUILTIN_SCOPE,
    canonicalName,
    formatName,
    isValidHandle,
    isValidPackageName,
    parseName,
} from "./names.js"

export const MANIFEST_FILE = "bee-package.json"
// Real ones are far smaller; checking ranges takes time that grows with their length
const MAX_DEPENDENCIES = 100
const MAX_RANGE_LENGTH = 200

/** Thrown when bee-package.json has problems; `problems` lists every one of them. */
export class ManifestError extends Error {
    constructor(problems) {
        super(`bee-package.json has problems:\n- ${problems.join("\n- ")}`)
        this.problems = problems
    }
}

/** Parses bee-package.json text (a UTF-8 BOM is fine). */
export function parseManifestText(text) {
    try {
        return JSON.parse(String(text).replace(/^﻿/, ""))
    } catch (err) {
        throw new ManifestError([`it isn't valid JSON (${err.message})`])
    }
}

/**
 * Validates a bee-package.json object and returns the normalized fields:
 *   { scope, name, fullName, version, displayName, description, compatibleWith,
 *     dependencies: { "@scope/name": range }, legacyDependencyIds: { "@scope/name": "BEE2_ID" } }
 * The scope comes from a scoped "name", else "author", else options.defaultScope.
 * legacyDependencyIds remembers keys written the old way (@author/BEE2_ID) so the
 * server can map them to the package with that ID.
 */
export function validateManifest(raw, { defaultScope = null } = {}) {
    const problems = []
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
        throw new ManifestError(["it must be a JSON object"])
    }

    let scope = null
    let name = null
    if (typeof raw.name !== "string" || !raw.name.trim()) {
        problems.push('"name" is required')
    } else if (raw.name.trim().startsWith("@")) {
        const parsed = parseName(raw.name)
        if (parsed) ({ scope, name } = parsed)
        else problems.push(`"name" "${raw.name}" isn't a valid @scope/name`)
    } else {
        const lower = raw.name.trim().toLowerCase()
        if (isValidPackageName(lower)) name = lower
        else {
            problems.push(
                `"name" "${raw.name}" may only use letters, digits, "-", "_" and "." (up to 64 characters)`,
            )
        }
    }

    if (raw.author !== undefined && raw.author !== null && raw.author !== "") {
        const author = typeof raw.author === "string" ? raw.author.trim().toLowerCase() : null
        if (!author || !isValidHandle(author))
            problems.push(`"author" "${raw.author}" isn't a valid handle`)
        else if (scope && scope !== author) {
            problems.push(`"author" (${raw.author}) doesn't match the scope in "name" (@${scope})`)
        } else scope = author
    }
    if (!scope) scope = defaultScope
    if (scope === BUILTIN_SCOPE) problems.push("@beemod is reserved for BEE2's built-in packages")

    const version = typeof raw.version === "string" ? raw.version.trim() : null
    if (!version) problems.push('"version" is required')
    else if (semver.valid(version) !== version) {
        problems.push(`"version" "${raw.version}" isn't a valid semantic version like 1.2.0`)
    }

    const text = (field, max) => {
        const value = raw[field]
        if (value === undefined || value === null || value === "") return null
        if (typeof value !== "string") {
            problems.push(`"${field}" must be text`)
            return null
        }
        if (value.length > max) problems.push(`"${field}" is longer than ${max} characters`)
        return value.trim()
    }
    const displayName = text("display_name", 100)
    const description = text("description", 2000)

    let compatibleWith = null
    try {
        compatibleWith = normalizeCompat(raw.compatibleWith)
    } catch (err) {
        problems.push(err.message)
    }

    const dependencies = {}
    const legacyDependencyIds = {}
    const deps = raw.dependencies
    if (deps !== undefined && deps !== null) {
        if (typeof deps !== "object" || Array.isArray(deps)) {
            problems.push('"dependencies" must be an object like {"@scope/name": "^1.0.0"}')
        } else if (Object.keys(deps).length > MAX_DEPENDENCIES) {
            problems.push(`"dependencies" lists more than ${MAX_DEPENDENCIES} packages`)
        } else {
            for (const [key, value] of Object.entries(deps)) {
                const parsed = parseName(key)
                if (!parsed) {
                    problems.push(`dependency "${key}" isn't a valid @scope/name`)
                    continue
                }
                const range = value === "" || value === null || value === undefined ? "*" : value
                if (
                    typeof range !== "string" ||
                    range.length > MAX_RANGE_LENGTH ||
                    semver.validRange(range) === null
                ) {
                    problems.push(`dependency "${key}" has an invalid version range "${value}"`)
                    continue
                }
                const full = formatName(parsed.scope, parsed.name)
                if (full === formatName(scope, name)) {
                    problems.push("a package can't depend on itself")
                    continue
                }
                dependencies[full] = range
                const original = key.slice(key.indexOf("/") + 1)
                if (parsed.scope !== BUILTIN_SCOPE && /^[A-Z0-9_]+$/.test(original)) {
                    legacyDependencyIds[full] = original
                }
            }
        }
    }

    if (problems.length) throw new ManifestError(problems)
    return {
        scope,
        name: canonicalName(scope, name),
        fullName: scope ? formatName(scope, name) : null,
        version,
        displayName,
        description,
        compatibleWith,
        dependencies,
        legacyDependencyIds,
    }
}
