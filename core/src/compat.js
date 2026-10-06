import semver from "semver"

/**
 * BEE2 versions have four parts (2.4.46.1) and release tags may start with "v".
 * Compatibility is checked against the first three: "v2.4.46.1" -> "2.4.46".
 * Returns null if the version doesn't have three numeric parts.
 */
export function bee2Semver(version) {
    const parts = String(version ?? "")
        .trim()
        .replace(/^v/i, "")
        .split(".")
    if (parts.length < 3 || !parts.slice(0, 3).every((p) => /^\d+$/.test(p))) return null
    return parts
        .slice(0, 3)
        .map((p) => Number(p))
        .join(".")
}

/**
 * Turns a compatibleWith value into a semver range string, or null for "any version".
 * Accepts semver ranges and the older forms earlier BeePM versions used:
 *   ">=2.4.40,<2.5"        -> ">=2.4.40 <2.5"
 *   "~=2.4.40"             -> "~2.4.40"
 *   "==2.4.*"              -> "=2.4.*"
 *   ["2.4.45", "2.4.46.0"] -> "2.4.45 || 2.4.46"
 * Throws if the value can't be understood.
 */
export function normalizeCompat(value) {
    if (value === undefined || value === null) return null

    if (Array.isArray(value)) {
        if (value.length === 0) return null
        const versions = value.map((v) => {
            const parsed = bee2Semver(v)
            if (!parsed) throw new Error(`"${v}" in compatibleWith isn't a BEE2 version`)
            return parsed
        })
        return [...new Set(versions)].join(" || ")
    }

    if (typeof value !== "string") {
        throw new Error("compatibleWith must be a version range or a list of versions")
    }
    let text = value.trim()
    if (text === "" || text === "*") return null

    text = text
        .replace(/~=\s*/g, "~")
        .replace(/===?\s*/g, "=")
        .replace(/\s*,\s*/g, " ")
        // Four-part versions inside a range keep their first three parts
        .replace(/(\d+\.\d+\.\d+)\.\d+/g, "$1")
        .replace(/\s+/g, " ")

    if (semver.validRange(text) === null) {
        throw new Error(`compatibleWith "${value}" isn't a valid version range`)
    }
    return text
}

/** True if a package version with this compatibleWith range works with the given BEE2 version. */
export function isCompatible(range, bee2Version) {
    if (!range) return true
    const version = bee2Semver(bee2Version)
    if (!version) return true // Unknown BEE2 version: don't block anything
    return semver.satisfies(version, range)
}
