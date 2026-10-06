import { badRequest, notFound } from "../lib/errors.js"
import { confirmCode, randomId, safeEqual, sha256Hex } from "../lib/ids.js"
import { publicUser } from "../services/users.js"
import { createToken } from "./tokens.js"

// An approved login can still be collected for a while after the session expires,
// in case the app was busy when the user clicked Allow
const COLLECT_GRACE_MS = 10 * 60 * 1000

/**
 * Starts a browser login (kind "login") or account link (kind "link", with userId).
 * Returns what the client needs: the secret to poll with and the URL to open.
 */
export async function createAuthSession(
    db,
    config,
    { kind, clientName, clientKind, userId = null },
) {
    const name = String(clientName || "")
        .trim()
        .slice(0, 80)
    if (!name) throw badRequest('clientName is required, e.g. "BeePM Desktop on MY-PC".')
    const kindOfClient = ["app", "cli"].includes(clientKind) ? clientKind : "other"

    const id = randomId(18)
    const secret = randomId(32)
    const code = confirmCode()
    const expiresAt = new Date(Date.now() + config.authSessionMinutes * 60 * 1000)
    await db.query(
        `INSERT INTO auth_sessions
            (id, kind, poll_hash, csrf, confirm_code, client_name, client_kind, user_id, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [id, kind, sha256Hex(secret), randomId(18), code, name, kindOfClient, userId, expiresAt],
    )
    return {
        id,
        secret,
        confirmCode: code,
        url: `${config.publicUrl}/${kind}/${id}`,
        interval: 2,
        expiresAt,
    }
}

export async function getAuthSession(db, id) {
    if (typeof id !== "string" || id.length > 64) return null
    const { rows } = await db.query("SELECT * FROM auth_sessions WHERE id = $1", [id])
    return rows[0] || null
}

export const isExpired = (session) => new Date(session.expires_at).getTime() < Date.now()

/**
 * What the app or CLI gets when it polls:
 *   pending | denied | expired, or done (once) with the token (login) or identity (link).
 */
export async function pollAuthSession(db, config, id, secret) {
    const session = await getAuthSession(db, id)
    if (
        !session ||
        typeof secret !== "string" ||
        !safeEqual(sha256Hex(secret), session.poll_hash)
    ) {
        throw notFound("Unknown login session.", "unknown_session")
    }

    if (session.status === "denied") return { status: "denied" }
    if (session.status === "done") return { status: "expired" }
    const age = Date.now() - new Date(session.expires_at).getTime()
    if (session.status === "pending") return { status: age > 0 ? "expired" : "pending" }
    if (age > COLLECT_GRACE_MS) return { status: "expired" }

    // status = approved: hand out the result exactly once
    const { rows } = await db.query(
        "UPDATE auth_sessions SET status = 'done' WHERE id = $1 AND status = 'approved' RETURNING *",
        [id],
    )
    if (!rows.length) return { status: "expired" }

    if (session.kind === "link") {
        return { status: "done", identity: session.result?.identity ?? null }
    }
    const { rows: users } = await db.query("SELECT * FROM users WHERE id = $1", [session.user_id])
    const token = await createToken(db, {
        userId: session.user_id,
        name: session.client_name,
        kind: "session",
        days: config.tokenDays,
    })
    return {
        status: "done",
        token: token.token,
        expiresAt: token.expiresAt,
        user: publicUser(users[0]),
    }
}
