/**
 * OAuth "web flow" for Discord and GitHub. The server holds the client secrets; the
 * provider's access token is only used to read the profile once and is then revoked.
 * A profile is { provider, providerId, username, displayName, avatarUrl, accountCreatedAt }.
 */

const DISCORD_EPOCH = 1420070400000n

/** Discord IDs are snowflakes: the top bits are the creation time. */
export function discordCreatedAt(id) {
    return new Date(Number((BigInt(id) >> 22n) + DISCORD_EPOCH))
}

async function readJson(res, what) {
    const text = await res.text()
    let body
    try {
        body = JSON.parse(text)
    } catch {
        throw new Error(`${what} returned HTTP ${res.status}`)
    }
    if (!res.ok || body.error) {
        throw new Error(`${what} failed: ${body.error_description || body.error || res.status}`)
    }
    return body
}

function github({ clientId, clientSecret }, fetchImpl) {
    return {
        id: "github",
        label: "GitHub",
        authorizeUrl({ state, redirectUri }) {
            const url = new URL("https://github.com/login/oauth/authorize")
            url.searchParams.set("client_id", clientId)
            url.searchParams.set("redirect_uri", redirectUri)
            url.searchParams.set("state", state)
            url.searchParams.set("allow_signup", "true")
            return url.toString()
        },
        async fetchProfile({ code, redirectUri }) {
            const tokenRes = await fetchImpl("https://github.com/login/oauth/access_token", {
                method: "POST",
                headers: { Accept: "application/json", "Content-Type": "application/json" },
                body: JSON.stringify({
                    client_id: clientId,
                    client_secret: clientSecret,
                    code,
                    redirect_uri: redirectUri,
                }),
            })
            const { access_token: accessToken } = await readJson(tokenRes, "GitHub login")

            try {
                const userRes = await fetchImpl("https://api.github.com/user", {
                    headers: {
                        Authorization: `Bearer ${accessToken}`,
                        Accept: "application/vnd.github+json",
                        "User-Agent": "BeePM",
                    },
                })
                const user = await readJson(userRes, "GitHub profile")
                return {
                    provider: "github",
                    providerId: String(user.id),
                    username: user.login,
                    displayName: user.name || user.login,
                    avatarUrl: user.avatar_url || null,
                    accountCreatedAt: user.created_at ? new Date(user.created_at) : null,
                }
            } finally {
                // Don't leave a usable GitHub token lying around
                fetchImpl(`https://api.github.com/applications/${clientId}/token`, {
                    method: "DELETE",
                    headers: {
                        Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`,
                        Accept: "application/vnd.github+json",
                        "User-Agent": "BeePM",
                    },
                    body: JSON.stringify({ access_token: accessToken }),
                }).catch(() => {})
            }
        },
    }
}

function discord({ clientId, clientSecret }, fetchImpl) {
    return {
        id: "discord",
        label: "Discord",
        authorizeUrl({ state, redirectUri }) {
            const url = new URL("https://discord.com/oauth2/authorize")
            url.searchParams.set("client_id", clientId)
            url.searchParams.set("redirect_uri", redirectUri)
            url.searchParams.set("response_type", "code")
            url.searchParams.set("scope", "identify")
            url.searchParams.set("state", state)
            return url.toString()
        },
        async fetchProfile({ code, redirectUri }) {
            const form = new URLSearchParams({
                client_id: clientId,
                client_secret: clientSecret,
                grant_type: "authorization_code",
                code,
                redirect_uri: redirectUri,
            })
            const tokenRes = await fetchImpl("https://discord.com/api/oauth2/token", {
                method: "POST",
                headers: { "Content-Type": "application/x-www-form-urlencoded" },
                body: form,
            })
            const { access_token: accessToken } = await readJson(tokenRes, "Discord login")

            try {
                const userRes = await fetchImpl("https://discord.com/api/users/@me", {
                    headers: { Authorization: `Bearer ${accessToken}` },
                })
                const user = await readJson(userRes, "Discord profile")
                return {
                    provider: "discord",
                    providerId: String(user.id),
                    username: user.username,
                    displayName: user.global_name || user.username,
                    avatarUrl: user.avatar
                        ? `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png`
                        : null,
                    accountCreatedAt: discordCreatedAt(user.id),
                }
            } finally {
                fetchImpl("https://discord.com/api/oauth2/token/revoke", {
                    method: "POST",
                    headers: { "Content-Type": "application/x-www-form-urlencoded" },
                    body: new URLSearchParams({
                        client_id: clientId,
                        client_secret: clientSecret,
                        token: accessToken,
                    }),
                }).catch(() => {})
            }
        },
    }
}

/**
 * Local development only: log in as any username, no Discord/GitHub app needed.
 * The "provider" page is served by this server (see devLoginRoutes).
 */
function dev(publicUrl) {
    return {
        id: "dev",
        label: "Test account",
        authorizeUrl: ({ state }) => `${publicUrl}/dev-login?state=${encodeURIComponent(state)}`,
        async fetchProfile({ code }) {
            const username = String(code || "")
                .trim()
                .slice(0, 39)
            if (!username) throw new Error("Enter a username")
            return {
                provider: "dev",
                providerId: username.toLowerCase(),
                username,
                displayName: username,
                avatarUrl: null,
                accountCreatedAt: new Date(Date.now() - 365 * 24 * 3600 * 1000),
            }
        },
    }
}

/** Returns { discord?, github?, dev? } for the providers that are configured. */
export function createProviders(
    providerConfig,
    fetchImpl = fetch,
    { devLogin = false, publicUrl = "" } = {},
) {
    const providers = {}
    if (providerConfig.discord) providers.discord = discord(providerConfig.discord, fetchImpl)
    if (providerConfig.github) providers.github = github(providerConfig.github, fetchImpl)
    if (devLogin) providers.dev = dev(publicUrl)
    return providers
}
