import { isCompatible } from "@beepm/core/compat"
import semver from "semver"

export { isCompatible }

export function formatBytes(bytes) {
    if (!bytes) return "0 B"
    const units = ["B", "KB", "MB", "GB"]
    const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)))
    return `${(bytes / 1024 ** i).toFixed(i ? 1 : 0)} ${units[i]}`
}

export const formatDate = (value) =>
    value
        ? new Date(value).toLocaleDateString(undefined, {
              year: "numeric",
              month: "short",
              day: "numeric",
          })
        : "unknown"

export const formatNumber = (value) => Number(value || 0).toLocaleString()

export const providerLabel = (provider) =>
    ({ discord: "Discord", github: "GitHub" })[provider] ?? provider

/** True if version a is newer than b (both semver). */
export const isNewer = (a, b) => Boolean(semver.valid(a) && semver.valid(b) && semver.gt(a, b))

/** A packument's versions, newest first (by semver, not by key order). */
export const versionsNewestFirst = (doc) =>
    Object.values(doc?.versions ?? {}).sort((a, b) => semver.rcompare(a.version, b.version))

/**
 * The newest version that isn't yanked and works with this BEE2 version, picked like the
 * range "*" does (stable releases only). Null if there's none.
 */
export function bestVersion(doc, bee2Version) {
    const usable = Object.values(doc?.versions ?? {})
        .filter((v) => !v.yanked && isCompatible(v.compatibleWith, bee2Version))
        .map((v) => v.version)
    return semver.maxSatisfying(usable, "*")
}

/** True if a version is allowed by an installed package's range (missing range = any). */
export const allowedByRange = (version, range) =>
    Boolean(semver.valid(version) && semver.satisfies(version, range || "*"))
