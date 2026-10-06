import { requireUser } from "../auth/guard.js"
import { createToken } from "../auth/tokens.js"
import { audit } from "../lib/audit.js"
import { badRequest, conflict, notFound } from "../lib/errors.js"
import { listIdentities, publicUser, publishEligibility } from "../services/users.js"

// Nicknames: 1-50 characters, no control characters
const NICKNAME_MAX = 50
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/

/** The logged-in user's account: profile, linked logins, and tokens. */
export default async function meRoutes(app) {
    const { db, config } = app.deps

    async function describe(user) {
        const { rows } = await db.query(
            "SELECT display_name, avatar_url, avatar_source FROM users WHERE id = $1",
            [user.id],
        )
        const eligibility = await publishEligibility(db, config, user)
        return {
            user: {
                ...publicUser(user),
                displayName: rows[0].display_name,
                avatarUrl: rows[0].avatar_url,
            },
            avatarSource: rows[0].avatar_source,
            identities: await listIdentities(db, user.id),
            canPublish: eligibility.ok,
            publishBlockedReason: eligibility.reason,
            token: { id: user.tokenId, kind: user.tokenKind },
        }
    }

    app.get("/v1/me", async (request) => describe(await requireUser(request)))

    /**
     * Account settings:
     *   displayName  the nickname shown with the @handle (the handle itself can't change)
     *   avatar       "discord" | "github": use that linked account's picture; "none": no picture
     */
    app.patch("/v1/me", async (request) => {
        const user = await requireUser(request, { session: true })
        const { displayName, avatar } = request.body || {}
        if (displayName === undefined && avatar === undefined) {
            throw badRequest("Send displayName and/or avatar.")
        }

        if (displayName !== undefined) {
            const name = typeof displayName === "string" ? displayName.trim() : ""
            if (!name || name.length > NICKNAME_MAX || CONTROL_CHARS.test(name)) {
                throw badRequest(
                    `Your nickname must be 1 to ${NICKNAME_MAX} characters.`,
                    "invalid_nickname",
                )
            }
            await db.query("UPDATE users SET display_name = $2 WHERE id = $1", [user.id, name])
        }

        if (avatar !== undefined) {
            if (avatar === "none" || avatar === null) {
                await db.query(
                    "UPDATE users SET avatar_url = NULL, avatar_source = 'none' WHERE id = $1",
                    [user.id],
                )
            } else {
                const { rows } = await db.query(
                    "SELECT avatar_url FROM identities WHERE user_id = $1 AND provider = $2",
                    [user.id, String(avatar)],
                )
                if (!rows.length) throw badRequest(`No ${avatar} account is linked.`, "not_linked")
                if (!rows[0].avatar_url) {
                    throw badRequest(
                        `BeePM doesn't have a picture from your ${avatar} account yet. Log in with it once, then try again.`,
                        "no_avatar",
                    )
                }
                await db.query(
                    "UPDATE users SET avatar_url = $2, avatar_source = $3 WHERE id = $1",
                    [user.id, rows[0].avatar_url, String(avatar)],
                )
            }
        }

        await audit(db, user.id, "account.update", `@${user.handle}`, { displayName, avatar })
        return describe(user)
    })

    app.get("/v1/me/tokens", async (request) => {
        const user = await requireUser(request, { session: true })
        const { rows } = await db.query(
            `SELECT id, name, kind, hint, created_at, last_used_at, expires_at FROM tokens
              WHERE user_id = $1 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now())
              ORDER BY created_at DESC`,
            [user.id],
        )
        return {
            tokens: rows.map((t) => ({
                id: t.id,
                name: t.name,
                kind: t.kind,
                hint: `bpm_…${t.hint}`,
                createdAt: t.created_at,
                lastUsedAt: t.last_used_at,
                expiresAt: t.expires_at,
                current: t.id === user.tokenId,
            })),
        }
    })

    // A publish token for CI (e.g. a GitHub Action). Shown once.
    app.post("/v1/me/tokens", async (request) => {
        const user = await requireUser(request, { session: true })
        const name = String(request.body?.name || "").trim()
        const days = request.body?.days ?? 90
        if (!name) throw badRequest('Give the token a name, e.g. "GitHub Actions".')
        if (!Number.isInteger(days) || days < 1 || days > 365) {
            throw badRequest("days must be between 1 and 365.")
        }
        const token = await createToken(db, { userId: user.id, name, kind: "publish", days })
        await audit(db, user.id, "token.create", null, { id: token.id, name })
        return { ...token, name, kind: "publish" }
    })

    app.delete("/v1/me/tokens/:id", async (request) => {
        const user = await requireUser(request, { session: true })
        const { rowCount } = await db.query(
            "UPDATE tokens SET revoked_at = now() WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL",
            [Number.parseInt(request.params.id, 10) || 0, user.id],
        )
        if (!rowCount) throw notFound("That token doesn't exist.")
        return { ok: true }
    })

    app.delete("/v1/me/identities/:provider", async (request) => {
        const user = await requireUser(request, { session: true })
        const provider = request.params.provider
        const identities = await listIdentities(db, user.id)
        if (!identities.some((i) => i.provider === provider)) {
            throw notFound(`No ${provider} account is linked.`)
        }
        if (identities.length === 1) {
            throw conflict(
                "You can't unlink your only login. Link another account first.",
                "last_identity",
            )
        }
        await db.query("DELETE FROM identities WHERE user_id = $1 AND provider = $2", [
            user.id,
            provider,
        ])
        // If the profile picture came from that account, use the remaining one's
        await db.query(
            `UPDATE users SET (avatar_url, avatar_source) = (
                    SELECT avatar_url, provider FROM identities
                     WHERE user_id = $1 AND avatar_url IS NOT NULL ORDER BY linked_at LIMIT 1)
              WHERE id = $1 AND avatar_source = $2`,
            [user.id, provider],
        )
        await audit(db, user.id, "identity.unlink", `@${user.handle}`, { provider })
        return { identities: await listIdentities(db, user.id) }
    })
}
