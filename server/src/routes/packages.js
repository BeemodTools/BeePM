import { formatName, isValidHandle, normalizeBeeId } from "@beepm/core"
import { currentUser } from "../auth/guard.js"
import { badRequest, notFound } from "../lib/errors.js"
import { packument, requirePackage, searchPackages } from "../services/packages.js"
import { findUserByHandle, publicUser } from "../services/users.js"

const intParam = (value, fallback, max) => {
    const n = Number.parseInt(value, 10)
    if (!Number.isFinite(n) || n < 0) return fallback
    return Math.min(n, max)
}

/** Public, read-only registry endpoints. */
export default async function packageRoutes(app) {
    const { db, storage } = app.deps

    app.get("/v1/packages", async (request) => {
        const { q = "", limit, offset, scope } = request.query || {}
        return searchPackages(db, {
            q: String(q).slice(0, 100),
            limit: intParam(limit, 50, 200),
            offset: intParam(offset, 0, 100000),
            scope: scope ? String(scope).replace(/^@/, "").toLowerCase() : null,
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
        const published =
            "removed_at IS NULL AND EXISTS (SELECT 1 FROM versions v WHERE v.package_id = packages.id AND v.unpublished_at IS NULL)"
        let rows
        if (typeof name === "string" && name) {
            ;({ rows } = await db.query(
                `SELECT scope, name FROM packages WHERE name = $1 AND ${published} ORDER BY scope`,
                [name.toLowerCase()],
            ))
        } else if (typeof beeId === "string" && normalizeBeeId(beeId)) {
            ;({ rows } = await db.query(
                `SELECT scope, name FROM packages WHERE upper(bee_id) = $1 AND ${published}`,
                [normalizeBeeId(beeId)],
            ))
        } else {
            throw badRequest("Pass ?name=<package name> or ?beeId=<BEE2 ID>.")
        }
        return { packages: rows.map((r) => formatName(r.scope, r.name)) }
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
