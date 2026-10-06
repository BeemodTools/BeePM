import { formatName, parseName } from "@beepm/core"
import semver from "semver"
import { forbidden, notFound } from "../lib/errors.js"

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

/** The short form used in lists and search results. */
export function packageSummary(pkg, versions) {
    const latest = latestVersion(versions)
    const latestRow = versions.find((v) => v.version === latest)
    return {
        name: formatName(pkg.scope, pkg.name),
        scope: pkg.scope,
        displayName: pkg.display_name,
        description: pkg.description,
        beeId: pkg.bee_id,
        latest,
        compatibleWith: latestRow?.compatible_with ?? null,
        deprecated: pkg.deprecated,
        updatedAt: pkg.updated_at,
        downloads: versions.reduce((sum, v) => sum + Number(v.downloads || 0), 0),
    }
}

/** The full document for one package: every version, like npm's packument. */
export async function packument(db, pkg) {
    const versions = (await versionsByPackage(db, [pkg.id])).get(pkg.id)
    versions.sort((a, b) => semver.compare(a.version, b.version))
    return {
        ...packageSummary(pkg, versions),
        owners: await listOwners(db, pkg.id),
        createdAt: pkg.created_at,
        removed: pkg.removed_at ? { at: pkg.removed_at, reason: pkg.removed_reason } : undefined,
        versions: Object.fromEntries(versions.map((v) => [v.version, versionInfo(v)])),
    }
}

const likePattern = (text) => `%${text.replace(/[\\%_]/g, (c) => `\\${c}`)}%`

/** Packages with at least one published version, searched by name, ID, title or description. */
export async function searchPackages(db, { q = "", limit = 50, offset = 0, scope = null } = {}) {
    const where = [
        "p.removed_at IS NULL",
        "EXISTS (SELECT 1 FROM versions v WHERE v.package_id = p.id AND v.unpublished_at IS NULL)",
    ]
    const params = []
    if (q.trim()) {
        params.push(likePattern(q.trim()))
        const n = `$${params.length}`
        where.push(
            `(p.name ILIKE ${n} OR p.scope ILIKE ${n} OR p.bee_id ILIKE ${n} OR p.display_name ILIKE ${n} OR p.description ILIKE ${n})`,
        )
    }
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
    return {
        total: countRows[0].n,
        packages: rows.map((pkg) => packageSummary(pkg, versions.get(pkg.id))),
    }
}
