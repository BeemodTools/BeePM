import { formatName } from "@beepm/core"
import semver from "semver"
import { requireUser } from "../auth/guard.js"
import { audit } from "../lib/audit.js"
import { badRequest, conflict, forbidden, notFound } from "../lib/errors.js"
import { listOwners, requireOwner, requirePackage } from "../services/packages.js"
import { findUserByHandle } from "../services/users.js"

const message = (value, max) => {
    if (value === undefined || value === null || value === "") return null
    if (typeof value !== "string") throw badRequest("The message must be text.")
    return value.trim().slice(0, max)
}

/** Owner actions: yank, deprecate, unpublish, managing owners, and automatic GitHub releases. */
export default async function manageRoutes(app) {
    const { db, config, storage } = app.deps

    async function ownedPackage(request) {
        const user = await requireUser(request)
        const pkg = await requirePackage(db, request.params.scope, request.params.name)
        await requireOwner(db, pkg, user)
        return { user, pkg }
    }

    // Publishing new releases of a GitHub repo automatically (turned on when publishing from it)
    app.get("/v1/packages/:scope/:name/github-watch", async (request) => {
        const { pkg } = await ownedPackage(request)
        const { rows } = await db.query(
            `SELECT w.repo, w.asset, w.handled, w.checked_at, w.error, u.handle
               FROM github_watches w JOIN users u ON u.id = w.user_id WHERE w.package_id = $1`,
            [pkg.id],
        )
        const watch = rows[0]
        return {
            watch: watch
                ? {
                      repo: watch.repo,
                      asset: watch.asset,
                      release: watch.handled?.split(" ")[0] ?? null,
                      checkedAt: watch.checked_at,
                      error: watch.error,
                      by: watch.handle,
                  }
                : null,
        }
    })

    app.delete("/v1/packages/:scope/:name/github-watch", async (request) => {
        const { user, pkg } = await ownedPackage(request)
        await db.query("DELETE FROM github_watches WHERE package_id = $1", [pkg.id])
        await audit(db, user.id, "package.github_watch.stop", formatName(pkg.scope, pkg.name))
        return { ok: true }
    })

    async function ownedVersion(request) {
        const user = await requireUser(request)
        const { scope, name, version } = request.params
        const pkg = await requirePackage(db, scope, name)
        await requireOwner(db, pkg, user)
        const { rows } = await db.query(
            "SELECT * FROM versions WHERE package_id = $1 AND version = $2 AND unpublished_at IS NULL",
            [pkg.id, version],
        )
        if (!rows.length)
            throw notFound(`${formatName(pkg.scope, pkg.name)}@${version} doesn't exist.`)
        return {
            user,
            pkg,
            version: rows[0],
            target: `${formatName(pkg.scope, pkg.name)}@${version}`,
        }
    }

    app.post("/v1/packages/:scope/:name/versions/:version/yank", async (request) => {
        const { user, version, target } = await ownedVersion(request)
        const reason = message(request.body?.reason, 500)
        await db.query("UPDATE versions SET yanked_at = now(), yank_reason = $2 WHERE id = $1", [
            version.id,
            reason,
        ])
        await audit(db, user.id, "version.yank", target, { reason })
        return { ok: true }
    })

    app.delete("/v1/packages/:scope/:name/versions/:version/yank", async (request) => {
        const { user, version, target } = await ownedVersion(request)
        await db.query("UPDATE versions SET yanked_at = NULL, yank_reason = NULL WHERE id = $1", [
            version.id,
        ])
        await audit(db, user.id, "version.unyank", target)
        return { ok: true }
    })

    // { message: "text" | null, version?: "1.2.0" } deprecates a version or the whole package
    app.put("/v1/packages/:scope/:name/deprecation", async (request) => {
        const user = await requireUser(request)
        const pkg = await requirePackage(db, request.params.scope, request.params.name)
        await requireOwner(db, pkg, user)
        const text = message(request.body?.message, 500)
        const version = request.body?.version
        const name = formatName(pkg.scope, pkg.name)
        if (version) {
            const { rowCount } = await db.query(
                "UPDATE versions SET deprecated = $3 WHERE package_id = $1 AND version = $2 AND unpublished_at IS NULL",
                [pkg.id, version, text],
            )
            if (!rowCount) throw notFound(`${name}@${version} doesn't exist.`)
        } else {
            await db.query("UPDATE packages SET deprecated = $2 WHERE id = $1", [pkg.id, text])
        }
        await audit(
            db,
            user.id,
            text ? "deprecate" : "undeprecate",
            version ? `${name}@${version}` : name,
            {
                message: text,
            },
        )
        return { ok: true }
    })

    // Unpublish: only shortly after publishing, and only if nothing depends on it
    app.delete("/v1/packages/:scope/:name/versions/:version", async (request) => {
        const { user, pkg, version, target } = await ownedVersion(request)
        const ageHours = (Date.now() - new Date(version.published_at).getTime()) / 3600000
        if (ageHours > config.unpublishHours && user.role !== "admin") {
            throw forbidden(
                `Versions can only be unpublished within ${config.unpublishHours} hours. Yank or deprecate it instead.`,
                "unpublish_window",
            )
        }

        const fullName = formatName(pkg.scope, pkg.name)
        const { rows: dependents } = await db.query(
            `SELECT p.scope, p.name, v.version, v.dependencies ->> $1 AS range
               FROM versions v JOIN packages p ON p.id = v.package_id
              WHERE v.unpublished_at IS NULL AND p.removed_at IS NULL AND p.id <> $2
                AND v.dependencies ? $1`,
            [fullName, pkg.id],
        )
        const blocking = dependents.filter((d) =>
            semver.satisfies(version.version, d.range, { includePrerelease: true }),
        )
        if (blocking.length && user.role !== "admin") {
            throw conflict(
                `${target} can't be unpublished because ${blocking
                    .map((d) => `${formatName(d.scope, d.name)}@${d.version}`)
                    .join(", ")} depends on it. Yank or deprecate it instead.`,
                "has_dependents",
            )
        }

        await db.query("UPDATE versions SET unpublished_at = now() WHERE id = $1", [version.id])
        await storage.remove(version.storage_key).catch(() => {})
        await audit(db, user.id, "version.unpublish", target)
        return { ok: true }
    })

    app.get("/v1/packages/:scope/:name/owners", async (request) => {
        const pkg = await requirePackage(db, request.params.scope, request.params.name)
        return { owners: await listOwners(db, pkg.id) }
    })

    app.put("/v1/packages/:scope/:name/owners/:handle", async (request) => {
        const user = await requireUser(request, { session: true })
        const pkg = await requirePackage(db, request.params.scope, request.params.name)
        await requireOwner(db, pkg, user)
        const target = await findUserByHandle(db, String(request.params.handle).replace(/^@/, ""))
        if (!target) throw notFound(`@${request.params.handle} doesn't exist.`)
        if (target.banned_at) throw badRequest(`@${target.handle} is banned.`)
        await db.query(
            `INSERT INTO package_owners (package_id, user_id, added_by) VALUES ($1, $2, $3)
             ON CONFLICT DO NOTHING`,
            [pkg.id, target.id, user.id],
        )
        await audit(db, user.id, "owner.add", formatName(pkg.scope, pkg.name), {
            handle: target.handle,
        })
        return { owners: await listOwners(db, pkg.id) }
    })

    app.delete("/v1/packages/:scope/:name/owners/:handle", async (request) => {
        const user = await requireUser(request, { session: true })
        const pkg = await requirePackage(db, request.params.scope, request.params.name)
        await requireOwner(db, pkg, user)
        const target = await findUserByHandle(db, String(request.params.handle).replace(/^@/, ""))
        const owners = await listOwners(db, pkg.id)
        if (!target || !owners.includes(target.handle)) {
            throw notFound(`@${request.params.handle} isn't an owner.`)
        }
        if (owners.length === 1) throw conflict("A package needs at least one owner.", "last_owner")
        await db.query("DELETE FROM package_owners WHERE package_id = $1 AND user_id = $2", [
            pkg.id,
            target.id,
        ])
        await audit(db, user.id, "owner.remove", formatName(pkg.scope, pkg.name), {
            handle: target.handle,
        })
        return { owners: await listOwners(db, pkg.id) }
    })
}
