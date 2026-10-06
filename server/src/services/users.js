import { BUILTIN_SCOPE, isValidHandle, RESERVED_HANDLES, suggestHandle } from "@beepm/core"

/** Why a handle can't be used, or null if it's available. */
export async function handleProblem(db, handle) {
    if (!isValidHandle(handle)) {
        return "Handles use lowercase letters, digits and single hyphens, up to 39 characters."
    }
    if (RESERVED_HANDLES.has(handle) || handle === BUILTIN_SCOPE) return `@${handle} is reserved.`
    const { rows } = await db.query("SELECT 1 FROM users WHERE handle = $1", [handle])
    if (rows.length) return `@${handle} is already taken.`
    return null
}

/** The first free handle based on a provider username: areng14, areng142, ... */
export async function freeHandleFor(db, username) {
    let base = suggestHandle(username)
    if (!base) base = "user"
    for (let n = 1; n < 1000; n++) {
        const suffix = n === 1 ? "" : String(n)
        const candidate = base.slice(0, 39 - suffix.length).replace(/-+$/, "") + suffix
        if (!(await handleProblem(db, candidate))) return candidate
    }
    return ""
}

export async function findUserByHandle(db, handle) {
    const { rows } = await db.query("SELECT * FROM users WHERE handle = $1", [
        String(handle || "").toLowerCase(),
    ])
    return rows[0] || null
}

/** The user a provider account is linked to, or null. */
export async function findUserByIdentity(db, provider, providerId) {
    const { rows } = await db.query(
        `SELECT u.* FROM identities i JOIN users u ON u.id = i.user_id
          WHERE i.provider = $1 AND i.provider_id = $2`,
        [provider, providerId],
    )
    return rows[0] || null
}

/** Creates a user and its first identity in one transaction. */
export async function createUser(db, { handle, profile, role = "user", claimed = true }) {
    return db.tx(async (tx) => {
        const { rows } = await tx.query(
            `INSERT INTO users (handle, display_name, avatar_url, avatar_source, role, claimed_at)
             VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
            [
                handle,
                profile?.displayName || null,
                profile?.avatarUrl || null,
                profile?.avatarUrl ? profile.provider : null,
                role,
                claimed ? new Date() : null,
            ],
        )
        const user = rows[0]
        if (profile) await addIdentity(tx, user.id, profile, { login: claimed })
        return user
    })
}

export async function addIdentity(db, userId, profile, { login = false } = {}) {
    await db.query(
        `INSERT INTO identities (provider, provider_id, user_id, username, account_created_at, last_login_at, avatar_url)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
            profile.provider,
            profile.providerId,
            userId,
            profile.username,
            profile.accountCreatedAt,
            login ? new Date() : null,
            profile.avatarUrl ?? null,
        ],
    )
}

export async function listIdentities(db, userId) {
    const { rows } = await db.query(
        `SELECT provider, username, avatar_url, linked_at, last_login_at FROM identities
          WHERE user_id = $1 ORDER BY linked_at`,
        [userId],
    )
    return rows.map((r) => ({
        provider: r.provider,
        username: r.username,
        avatarUrl: r.avatar_url,
        linkedAt: r.linked_at,
        lastLoginAt: r.last_login_at,
    }))
}

/**
 * Whether a user may publish: admins always; others need a linked Discord/GitHub
 * account at least MIN_ACCOUNT_AGE_DAYS old.
 */
export async function publishEligibility(db, config, user) {
    if (user.role === "admin") return { ok: true, reason: null }
    const { rows } = await db.query(
        "SELECT min(account_created_at) AS oldest FROM identities WHERE user_id = $1",
        [user.id],
    )
    const oldest = rows[0]?.oldest
    const minAge = config.minAccountAgeDays * 24 * 3600 * 1000
    if (!oldest || Date.now() - new Date(oldest).getTime() < minAge) {
        return {
            ok: false,
            reason: `To publish, your linked Discord or GitHub account must be at least ${config.minAccountAgeDays} days old.`,
        }
    }
    return { ok: true, reason: null }
}

/** Makes the handles in BOOTSTRAP_ADMINS admins (run at startup). */
export async function applyBootstrapAdmins(db, handles) {
    if (!handles.length) return 0
    const { rowCount } = await db.query(
        "UPDATE users SET role = 'admin' WHERE handle = ANY($1::text[]) AND role <> 'admin'",
        [handles],
    )
    return rowCount
}

export const publicUser = (user) => ({
    handle: user.handle,
    displayName: user.display_name ?? user.displayName ?? null,
    avatarUrl: user.avatar_url ?? user.avatarUrl ?? null,
    role: user.role,
    createdAt: user.created_at ?? user.createdAt,
})
