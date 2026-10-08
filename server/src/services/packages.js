import { formatName, parseName } from "@beepm/core"
import semver from "semver"
import { forbidden, notFound } from "../lib/errors.js"
import { contentCounts, contentMatches } from "./contents.js"

/** Loads a package row by URL params (scope may include the leading @). */
export async function findPackage(db, scopeParam, nameParam, { includeRemoved = false } = {}) {
    const parsed = parseName(`@${String(scopeParam).replace(/^@/, "")}/${nameParam}`)
    if (!parsed) return null
    const { rows } = await db.query("SELECT * FROM packages WHERE scope = $1 AND name = $2", [
        parsed.scope,
        parsed.name,
    ])
    const pkg = rows[0] || null
    if (pkg?.removed_at && !includeRemoved) return null
    return pkg
}

export async function requirePackage(db, scope, name, options) {
    const pkg = await findPackage(db, scope, name, options)
    if (!pkg) throw notFound(`Package @${String(scope).replace(/^@/, "")}/${name} doesn't exist.`)
    return pkg
}

export async function isOwner(db, packageId, userId) {
    const { rows } = await db.query(
        "SELECT 1 FROM package_owners WHERE package_id = $1 AND user_id = $2",
        [packageId, userId],
    )
    return rows.length > 0
}

/** Throws unless the user owns the package or is an admin. */
export async function requireOwner(db, pkg, user) {
    if (user.role === "admin" || (await isOwner(db, pkg.id, user.id))) return
    throw forbidden(`You're not an owner of ${formatName(pkg.scope, pkg.name)}.`, "not_owner")
}

export async function listOwners(db, packageId) {
    const { rows } = await db.query(
        `SELECT u.handle FROM package_owners o JOIN users u ON u.id = o.user_id
          WHERE o.package_id = $1 ORDER BY o.added_at`,
        [packageId],
    )
    return rows.map((r) => r.handle)
}

/** Published (not unpublished) versions of the given packages, grouped by package id. */
export async function versionsByPackage(db, packageIds) {
    const grouped = new Map(packageIds.map((id) => [id, []]))
    if (!packageIds.length) return grouped
    const { rows } = await db.query(
        `SELECT v.*, u.handle AS publisher FROM versions v
           LEFT JOIN users u ON u.id = v.published_by
          WHERE v.package_id = ANY($1::int[]) AND v.unpublished_at IS NULL`,
        [packageIds],
    )
    for (const row of rows) grouped.get(row.package_id).push(row)
    return grouped
}

/**
 * The version "latest" points to: the highest one that isn't yanked, preferring
 * stable releases over prereleases. Null if every version is yanked.
 */
export function latestVersion(versions) {
    const usable = versions.filter((v) => !v.yanked_at && !v.unpublished_at).map((v) => v.version)
    const stable = usable.filter((v) => !semver.prerelease(v))
    const pool = stable.length ? stable : usable
    return pool.length ? semver.rsort([...pool])[0] : null
}

export function versionInfo(v) {
    return {
        version: v.version,
        compatibleWith: v.compatible_with,
        dependencies: v.dependencies || {},
        sha256: v.sha256,
        size: v.size,
        publishedAt: v.published_at,
        publishedBy: v.publisher ?? null,
        yanked: Boolean(v.yanked_at),
        yankReason: v.yank_reason,
        deprecated: v.deprecated,
        downloads: v.downloads,
        source: v.source,
    }
}

/** The row of the version "latest" points to (see latestVersion), or undefined. */
const latestRow = (versions) => {
    const latest = latestVersion(versions)
    return versions.find((v) => v.version === latest)
}

/**
 * The short form used in lists and search results. counts: what the latest version contains,
 * by kind ({ item: 12, music: 2 }; empty if it hasn't been read yet).
 */
export function packageSummary(pkg, versions, counts = {}) {
    const latest = latestRow(versions)
    return {
        name: formatName(pkg.scope, pkg.name),
        scope: pkg.scope,
        displayName: pkg.display_name,
        description: pkg.description,
        beeId: pkg.bee_id,
        latest: latest?.version ?? null,
        compatibleWith: latest?.compatible_with ?? null,
        deprecated: pkg.deprecated,
        updatedAt: pkg.updated_at,
        downloads: versions.reduce((sum, v) => sum + Number(v.downloads || 0), 0),
        contents: counts,
        // Only admins are shown removed packages (beeIdReleased: another package may use its ID)
        removed: pkg.removed_at
            ? {
                  at: pkg.removed_at,
                  reason: pkg.removed_reason,
                  beeIdReleased: Boolean(pkg.bee_id_released),
              }
            : undefined,
    }
}

/** The full document for one package: every version, like npm's packument. */
export async function packument(db, pkg) {
    const versions = (await versionsByPackage(db, [pkg.id])).get(pkg.id)
    versions.sort((a, b) => semver.compare(a.version, b.version))
    const latest = latestRow(versions)
    const counts = await contentCounts(db, latest ? [latest.id] : [])
    return {
        ...packageSummary(pkg, versions, counts.get(latest?.id)),
        owners: await listOwners(db, pkg.id),
        createdAt: pkg.created_at,
        versions: Object.fromEntries(versions.map((v) => [v.version, versionInfo(v)])),
    }
}

const likePattern = (text) => `%${text.replace(/[\\%_]/g, (c) => `\\${c}`)}%`

// The version whose contents search looks at: the newest usable one, stable before prereleases
// (what latestVersion picks, unless a lower version was published after a higher one)
const SEARCHED_VERSION = `(SELECT v.id FROM versions v
    WHERE v.package_id = p.id AND v.unpublished_at IS NULL AND v.yanked_at IS NULL
    ORDER BY position('-' in v.version) > 0, v.published_at DESC LIMIT 1)`

/**
 * Packages with at least one published version, searched by name, ID, title or description, and
 * by what their latest version contains (items, music...: core's kinds.js), its names, other
 * names and IDs. kind: only packages with that kind of thing in them, named like `q` if it's
 * given (or packages named like it that have that kind). Results found by what they contain have
 * `found: { matches: [{ kind, name }], count }`. includeRemoved (admins): removed packages too,
 * with `removed` set.
 */
export async function searchPackages(
    db,
    { q = "", kind = null, limit = 50, offset = 0, scope = null, includeRemoved = false } = {},
) {
    const where = [
        "EXISTS (SELECT 1 FROM versions v WHERE v.package_id = p.id AND v.unpublished_at IS NULL)",
    ]
    if (!includeRemoved) where.push("p.removed_at IS NULL")
    const params = []
    const term = q.trim()
    const pattern = term ? likePattern(term) : null
    if (pattern) params.push(pattern)
    const t = `$${params.length}`
    if (kind) params.push(kind)
    const k = `$${params.length}`
    const fields = `(p.name ILIKE ${t} OR p.scope ILIKE ${t} OR p.bee_id ILIKE ${t} OR p.display_name ILIKE ${t} OR p.description ILIKE ${t})`
    const contains = (named) =>
        `EXISTS (SELECT 1 FROM version_contents c WHERE c.version_id = ${SEARCHED_VERSION}${
            kind ? ` AND c.kind = ${k}` : ""
        }${named ? ` AND (c.name ILIKE ${t} OR c.aliases ILIKE ${t} OR c.object_id ILIKE ${t})` : ""})`
    if (pattern && kind) where.push(`(${contains(true)} OR (${fields} AND ${contains(false)}))`)
    else if (pattern) where.push(`(${fields} OR ${contains(true)})`)
    else if (kind) where.push(contains(false))
    if (scope) {
        params.push(scope)
        where.push(`p.scope = $${params.length}`)
    }
    const filter = where.join(" AND ")

    const { rows: countRows } = await db.query(
        `SELECT count(*)::int AS n FROM packages p WHERE ${filter}`,
        params,
    )
    params.push(limit, offset)
    const { rows } = await db.query(
        `SELECT p.*, (SELECT coalesce(sum(v.downloads), 0) FROM versions v WHERE v.package_id = p.id) AS total_downloads
           FROM packages p WHERE ${filter}
          ORDER BY total_downloads DESC, p.updated_at DESC, p.id
          LIMIT $${params.length - 1} OFFSET $${params.length}`,
        params,
    )
    const versions = await versionsByPackage(
        db,
        rows.map((r) => r.id),
    )
    // What each one's latest version contains, and what in it matches
    const latestIds = new Map(rows.map((pkg) => [pkg.id, latestRow(versions.get(pkg.id))?.id]))
    const ids = [...latestIds.values()].filter(Boolean)
    const counts = await contentCounts(db, ids)
    const found = await contentMatches(db, ids, { pattern, kind })
    return {
        total: countRows[0].n,
        packages: rows.map((pkg) => {
            const latestId = latestIds.get(pkg.id)
            const summary = packageSummary(pkg, versions.get(pkg.id), counts.get(latestId))
            return found.has(latestId) ? { ...summary, found: found.get(latestId) } : summary
        }),
    }
}
