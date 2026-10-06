import { forbidden, unauthorized } from "../lib/errors.js"
import { newApiToken, sha256Hex } from "../lib/ids.js"

/**
 * Creates a token for a user and returns the plain token. It is shown once and
 * only its hash is stored.
 *   kind "session": issued by a browser login; full access to the account
 *   kind "publish": created by the user for CI; can publish and manage packages only
 */
export async function createToken(db, { userId, name, kind = "session", days = null }) {
    const token = newApiToken()
    const expiresAt = days ? new Date(Date.now() + days * 24 * 3600 * 1000) : null
    const { rows } = await db.query(
        `INSERT INTO tokens (user_id, token_hash, hint, name, kind, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id, created_at, expires_at`,
        [userId, sha256Hex(token), token.slice(-4), name.slice(0, 100), kind, expiresAt],
    )
    return { token, id: rows[0].id, createdAt: rows[0].created_at, expiresAt: rows[0].expires_at }
}

/** Looks up the user behind "Authorization: Bearer bpm_..." (or null if there's no header). */
export async function authenticate(db, authorization) {
    if (!authorization) return null
    const match = /^Bearer\s+(bpm_[A-Za-z0-9_-]+)$/.exec(authorization.trim())
    if (!match) throw unauthorized("Malformed Authorization header.", "invalid_token")

    const { rows } = await db.query(
        `SELECT t.id AS token_id, t.kind, t.last_used_at, t.expires_at, t.revoked_at,
                u.id, u.handle, u.display_name, u.avatar_url, u.role, u.banned_at, u.ban_reason,
                u.created_at
           FROM tokens t JOIN users u ON u.id = t.user_id
          WHERE t.token_hash = $1`,
        [sha256Hex(match[1])],
    )
    const row = rows[0]
    if (!row || row.revoked_at || (row.expires_at && row.expires_at < new Date())) {
        throw unauthorized("Your login has expired or was revoked. Log in again.", "invalid_token")
    }
    if (row.banned_at) {
        throw forbidden(
            `This account is banned${row.ban_reason ? `: ${row.ban_reason}` : "."}`,
            "banned",
        )
    }

    // Cheap "last used" tracking: at most one write every 10 minutes per token
    if (!row.last_used_at || Date.now() - row.last_used_at.getTime() > 10 * 60 * 1000) {
        db.query("UPDATE tokens SET last_used_at = now() WHERE id = $1", [row.token_id]).catch(
            () => {},
        )
    }

    return {
        id: row.id,
        handle: row.handle,
        displayName: row.display_name,
        avatarUrl: row.avatar_url,
        role: row.role,
        createdAt: row.created_at,
        tokenId: row.token_id,
        tokenKind: row.kind,
    }
}
