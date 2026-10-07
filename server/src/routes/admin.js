import { formatName } from "@beepm/core"
import { requireUser } from "../auth/guard.js"
import { audit } from "../lib/audit.js"
import { badRequest, conflict, notFound } from "../lib/errors.js"
import { importLegacy } from "../services/legacy.js"
import { requirePackage } from "../services/packages.js"
import { findUserByHandle, handleProblem, publicUser } from "../services/users.js"

/** Admin-only moderation and maintenance. */
export default async function adminRoutes(app) {
    const { db } = app.deps
    const admin = (request) => requireUser(request, { session: true, admin: true })

    // Hides a package from the registry (its files are kept so it can be restored)
    app.delete("/v1/admin/packages/:scope/:name", async (request) => {
        const user = await admin(request)
        const pkg = await requirePackage(db, request.params.scope, request.params.name)
        const reason =
            String(request.body?.reason || "")
                .trim()
                .slice(0, 500) || null
        await db.query(
            "UPDATE packages SET removed_at = now(), removed_reason = $2 WHERE id = $1",
            [pkg.id, reason],
        )
        await audit(db, user.id, "admin.package.remove", formatName(pkg.scope, pkg.name), {
            reason,
        })
        return { ok: true }
    })

    // Refused while another package uses its BEE2 ID (removing a package frees the ID)
    app.post("/v1/admin/packages/:scope/:name/restore", async (request) => {
        const user = await admin(request)
        const pkg = await requirePackage(db, request.params.scope, request.params.name, {
            includeRemoved: true,
        })
        const fullName = formatName(pkg.scope, pkg.name)
        try {
            await db.query(
                "UPDATE packages SET removed_at = NULL, removed_reason = NULL WHERE id = $1",
                [pkg.id],
            )
        } catch (err) {
            if (err.code !== "23505") throw err
            const { rows } = await db.query(
                "SELECT scope, name FROM packages WHERE upper(bee_id) = upper($1) AND removed_at IS NULL",
                [pkg.bee_id],
            )
            const holder = rows[0] ? formatName(rows[0].scope, rows[0].name) : "Another package"
            throw conflict(
                `${holder} uses the BEE2 ID ${pkg.bee_id} now, so ${fullName} can't be restored.`,
                "bee_id_taken",
            )
        }
        await audit(db, user.id, "admin.package.restore", fullName)
        return { ok: true }
    })

    // { role?: "user" | "admin", banned?: boolean, banReason?: string, handle?: "new-handle" }
    app.patch("/v1/admin/users/:handle", async (request) => {
        const actor = await admin(request)
        const target = await findUserByHandle(db, String(request.params.handle).replace(/^@/, ""))
        if (!target) throw notFound(`@${request.params.handle} doesn't exist.`)
        const { role, banned, banReason, handle } = request.body || {}

        await db.tx(async (tx) => {
            if (role !== undefined) {
                if (!["user", "admin"].includes(role))
                    throw badRequest('role must be "user" or "admin".')
                await tx.query("UPDATE users SET role = $2 WHERE id = $1", [target.id, role])
            }
            if (banned !== undefined) {
                await tx.query("UPDATE users SET banned_at = $2, ban_reason = $3 WHERE id = $1", [
                    target.id,
                    banned ? new Date() : null,
                    banned ? String(banReason || "").slice(0, 500) || null : null,
                ])
                if (banned) {
                    await tx.query(
                        "UPDATE tokens SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL",
                        [target.id],
                    )
                }
            }
            if (handle !== undefined && handle !== target.handle) {
                const next = String(handle).toLowerCase()
                const problem = await handleProblem(tx, next)
                if (problem) throw badRequest(problem, "invalid_handle")
                // Existing files keep their storage keys; only names change
                await tx.query("UPDATE users SET handle = $2 WHERE id = $1", [target.id, next])
                await tx.query("UPDATE packages SET scope = $2 WHERE scope = $1", [
                    target.handle,
                    next,
                ])
            }
        })
        await audit(db, actor.id, "admin.user.update", `@${target.handle}`, {
            role,
            banned,
            banReason,
            handle,
        })
        const updated = await findUserByHandle(db, handle ?? target.handle)
        return { user: { ...publicUser(updated), banned: Boolean(updated.banned_at) } }
    })

    app.get("/v1/admin/audit", async (request) => {
        await admin(request)
        const limit = Math.min(Number.parseInt(request.query?.limit, 10) || 100, 1000)
        const { rows } = await db.query(
            `SELECT a.at, a.action, a.target, a.details, u.handle AS actor
               FROM audit_log a LEFT JOIN users u ON u.id = a.actor_id
              ORDER BY a.id DESC LIMIT $1`,
            [limit],
        )
        return { entries: rows }
    })

    // Copies the packages from the old R2 registry into this registry (safe to run again)
    app.post("/v1/admin/import-legacy", async (request) => {
        const user = await admin(request)
        const result = await importLegacy(app.deps, {
            registryUrl: request.body?.registryUrl || app.deps.config.legacyRegistryUrl,
            actor: user,
        })
        await audit(db, user.id, "admin.import-legacy", null, {
            packages: result.packages,
            versions: result.versions,
            problems: result.problems.length,
        })
        return result
    })
}
