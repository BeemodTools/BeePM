import { formatName, isContentKind, isValidHandle, normalizeBeeId } from "@beepm/core"
import { currentUser } from "../auth/guard.js"
import { badRequest, notFound } from "../lib/errors.js"
import { contentIcon, versionContents } from "../services/contents.js"
import { packument, requirePackage, searchPackages } from "../services/packages.js"
import { findUserByHandle, publicUser } from "../services/users.js"

const MAX_LOOKUP_IDS = 1000
// A package can be installed: not removed, and with a version that isn't unpublished
const PUBLISHED =
    "removed_at IS NULL AND EXISTS (SELECT 1 FROM versions v WHERE v.package_id = packages.id AND v.unpublished_at IS NULL)"

const intParam = (value, fallback, max) => {
    const n = Number.parseInt(value, 10)
    if (!Number.isFinite(n) || n < 0) return fallback
    return Math.min(n, max)
}

/** Public, read-only registry endpoints. */
export default async function packageRoutes(app) {
    const { db, storage, config } = app.deps

    // Admins also find removed packages (to restore them). kind: what's in them (core's kinds.js)
    app.get("/v1/packages", async (request) => {
        const { q = "", kind, limit, offset, scope } = request.query || {}
        if (kind && !isContentKind(kind)) throw badRequest(`"${kind}" isn't a kind of content.`)
        const viewer = await currentUser(request).catch(() => null)
        return searchPackages(db, {
            q: String(q).slice(0, 100),
            kind: kind || null,
            limit: intParam(limit, 50, 200),
            offset: intParam(offset, 0, 100000),
            scope: scope ? String(scope).replace(/^@/, "").toLowerCase() : null,
            includeRemoved: viewer?.role === "admin",
        })
    })

    app.get("/v1/packages/:scope/:name", async (request) => {
        const { scope, name } = request.params
        const viewer = await currentUser(request).catch(() => null)
        const pkg = await requirePackage(db, scope, name, {
            includeRemoved: viewer?.role === "admin",
        })
        return packument(db, pkg)
    })

    /** A published version from the URL: { pkg, row }. Admins also see removed packages'. */
    async function findVersion(request) {
        const { scope, name, version } = request.params
        const viewer = await currentUser(request).catch(() => null)
        const pkg = await requirePackage(db, scope, name, {
            includeRemoved: viewer?.role === "admin",
        })
        const { rows } = await db.query(
            `SELECT id, version, contents_read_at, contents_error FROM versions
              WHERE package_id = $1 AND version = $2 AND unpublished_at IS NULL`,
            [pkg.id, version],
        )
        if (!rows.length) {
            throw notFound(`${formatName(pkg.scope, pkg.name)}@${version} doesn't exist.`)
        }
        return { pkg, row: rows[0] }
    }

    // What a version contains: { version, read (false until the registry has read it), error
    // (why it couldn't be read), contents: [{ kind, id, name, aliases, description, authors,
    // icon (a URL, or null) }] in info.txt's order }
    app.get("/v1/packages/:scope/:name/versions/:version/contents", async (request) => {
        const { pkg, row } = await findVersion(request)
        const base = `${config.publicUrl}/v1/packages/${pkg.scope}/${encodeURIComponent(pkg.name)}/versions/${encodeURIComponent(row.version)}/icons`
        return {
            version: row.version,
            read: Boolean(row.contents_read_at),
            error: row.contents_error ?? null,
            contents: await versionContents(db, row.id, (position) => `${base}/${position}`),
        }
    })

    // A thing's icon (PNG or JPEG from the package), by its place in the version's contents.
    // Versions never change, so it can be kept for good.
    app.get(
        "/v1/packages/:scope/:name/versions/:version/icons/:position",
        async (request, reply) => {
            const { row } = await findVersion(request)
            const position = Number.parseInt(request.params.position, 10)
            const icon = Number.isInteger(position) ? await contentIcon(db, row.id, position) : null
            if (!icon) throw notFound("There's no such icon.")
            return reply
                .type(icon.type)
                .header("Cache-Control", "public, max-age=31536000, immutable")
                .header("X-Content-Type-Options", "nosniff")
                .header("Content-Security-Policy", "default-src 'none'")
                .send(icon.data)
        },
    )

    app.get("/v1/packages/:scope/:name/versions/:version/download", async (request, reply) => {
        const { scope, name, version } = request.params
        const pkg = await requirePackage(db, scope, name)
        const { rows } = await db.query(
            `SELECT id, storage_key FROM versions
              WHERE package_id = $1 AND version = $2 AND unpublished_at IS NULL`,
            [pkg.id, version],
        )
        if (!rows.length)
            throw notFound(`${formatName(pkg.scope, pkg.name)}@${version} doesn't exist.`)
        db.query("UPDATE versions SET downloads = downloads + 1 WHERE id = $1", [rows[0].id]).catch(
            () => {},
        )
        const url = await storage.downloadUrl(rows[0].storage_key, {
            filename: `${pkg.scope}@${pkg.name}@${version}.bee_pack`,
        })
        return reply.redirect(url, 302)
    })

    // Finds packages by bare name (for `beepm install name`) or by BEE2 ID
    app.get("/v1/lookup", async (request) => {
        const { name, beeId } = request.query || {}
        let rows
        if (typeof name === "string" && name) {
            ;({ rows } = await db.query(
                `SELECT scope, name FROM packages WHERE name = $1 AND ${PUBLISHED} ORDER BY scope`,
                [name.toLowerCase()],
            ))
        } else if (typeof beeId === "string" && normalizeBeeId(beeId)) {
            ;({ rows } = await db.query(
                `SELECT scope, name FROM packages WHERE upper(bee_id) = $1 AND ${PUBLISHED}`,
                [normalizeBeeId(beeId)],
            ))
        } else {
            throw badRequest("Pass ?name=<package name> or ?beeId=<BEE2 ID>.")
        }
        return { packages: rows.map((r) => formatName(r.scope, r.name)) }
    })

    // Many BEE2 IDs at once (the app's BEE2 check): { packages: { <BEE2 ID>: [names] } }, only
    // the IDs that are on BeePM
    app.post("/v1/lookup", async (request) => {
        const { beeIds } = request.body || {}
        if (!Array.isArray(beeIds) || beeIds.length > MAX_LOOKUP_IDS) {
            throw badRequest(`Send { "beeIds": [...] } with up to ${MAX_LOOKUP_IDS} BEE2 IDs.`)
        }
        const ids = [...new Set(beeIds.map(normalizeBeeId).filter(Boolean))]
        const packages = {}
        if (!ids.length) return { packages }
        const { rows } = await db.query(
            `SELECT upper(bee_id) AS bee_id, scope, name FROM packages
              WHERE upper(bee_id) = ANY($1) AND ${PUBLISHED} ORDER BY scope, name`,
            [ids],
        )
        for (const row of rows) (packages[row.bee_id] ??= []).push(formatName(row.scope, row.name))
        return { packages }
    })

    app.get("/v1/users/:handle", async (request) => {
        const handle = String(request.params.handle).replace(/^@/, "").toLowerCase()
        const user = isValidHandle(handle) ? await findUserByHandle(db, handle) : null
        if (!user) throw notFound(`@${handle} doesn't exist.`)
        const { packages } = await searchPackages(db, { scope: handle, limit: 200 })
        const { role, ...profile } = publicUser(user)
        return { ...profile, admin: role === "admin", packages }
    })
}
