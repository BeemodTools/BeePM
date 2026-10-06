import { parseName } from "../names.js"

/**
 * The public BeePM registry: the Railway service's domain (set when the server is deployed).
 * BEEPM_REGISTRY or config.json's "registry" override it.
 */
export const DEFAULT_REGISTRY = "https://beepm-registry-production.up.railway.app"

/** An error from the registry API: status 0 means the registry couldn't be reached. */
export class RegistryError extends Error {
    constructor(status, code, message, details) {
        super(message)
        this.status = status
        this.code = code
        this.details = details
    }
}

const encodeName = (fullName) => {
    const parsed = parseName(fullName)
    if (!parsed)
        throw new RegistryError(400, "bad_request", `"${fullName}" isn't a valid @scope/name.`)
    return `${parsed.scope}/${encodeURIComponent(parsed.name)}`
}

/**
 * A client for the registry API. Every method returns the parsed JSON response and
 * throws RegistryError on failure.
 */
export function createApi({
    registry = DEFAULT_REGISTRY,
    token = null,
    fetch = globalThis.fetch,
    userAgent = "BeePM",
} = {}) {
    const base = registry.replace(/\/+$/, "")

    async function request(method, pathname, body) {
        const headers = { Accept: "application/json", "User-Agent": userAgent }
        if (token) headers.Authorization = `Bearer ${token}`
        if (body !== undefined) headers["Content-Type"] = "application/json"
        let res
        try {
            res = await fetch(base + pathname, {
                method,
                headers,
                body: body === undefined ? undefined : JSON.stringify(body),
            })
        } catch (err) {
            const reason = err.cause?.code || err.cause?.message || err.message
            throw new RegistryError(
                0,
                "network",
                `Couldn't reach the BeePM registry at ${base} (${reason}).`,
            )
        }
        const text = await res.text()
        let data = null
        try {
            data = text ? JSON.parse(text) : null
        } catch {
            data = null
        }
        if (!res.ok) {
            const error = data?.error
            throw new RegistryError(
                res.status,
                error?.code || `http_${res.status}`,
                error?.message || `The registry returned HTTP ${res.status}.`,
                error?.details,
            )
        }
        return data
    }

    const pkg = (name) => `/v1/packages/${encodeName(name)}`
    const ver = (name, version) => `${pkg(name)}/versions/${encodeURIComponent(version)}`

    return {
        registry: base,
        get token() {
            return token
        },
        setToken(value) {
            token = value
        },

        info: () => request("GET", "/v1"),
        search: (q = "", { limit = 50, offset = 0, scope } = {}) =>
            request(
                "GET",
                `/v1/packages?q=${encodeURIComponent(q)}&limit=${limit}&offset=${offset}${scope ? `&scope=${encodeURIComponent(scope)}` : ""}`,
            ),
        packument: (name) => request("GET", pkg(name)),
        lookup: ({ name, beeId }) =>
            request(
                "GET",
                `/v1/lookup?${name ? `name=${encodeURIComponent(name)}` : `beeId=${encodeURIComponent(beeId)}`}`,
            ),
        user: (handle) =>
            request("GET", `/v1/users/${encodeURIComponent(handle.replace(/^@/, ""))}`),
        downloadUrl: (name, version) => `${base}${ver(name, version)}/download`,

        startLogin: ({ clientName, client }) =>
            request("POST", "/v1/auth/sessions", { clientName, client }),
        startLink: ({ clientName, client }) =>
            request("POST", "/v1/me/links", { clientName, client }),
        pollLogin: (id, secret) =>
            request("POST", `/v1/auth/sessions/${encodeURIComponent(id)}/poll`, { secret }),
        logout: () => request("DELETE", "/v1/auth/token"),
        me: () => request("GET", "/v1/me"),
        updateMe: (changes) => request("PATCH", "/v1/me", changes),
        tokens: () => request("GET", "/v1/me/tokens"),
        createToken: ({ name, days }) => request("POST", "/v1/me/tokens", { name, days }),
        revokeToken: (id) => request("DELETE", `/v1/me/tokens/${encodeURIComponent(id)}`),
        unlink: (provider) =>
            request("DELETE", `/v1/me/identities/${encodeURIComponent(provider)}`),

        createUpload: ({ size, sha256 }) => request("POST", "/v1/uploads", { size, sha256 }),
        finalizeUpload: (id) => request("POST", `/v1/uploads/${encodeURIComponent(id)}/finalize`),
        checkPublish: ({ manifest, beeId }) =>
            request("POST", "/v1/publish/check", { manifest, beeId }),
        // watch: true also publishes the repo's new releases automatically; false stops that
        importGithub: ({ owner, repo, tag, asset, watch }) =>
            request("POST", "/v1/imports/github", {
                owner,
                repo,
                tag: tag || undefined,
                asset: asset || undefined,
                watch,
            }),
        githubWatch: (name) => request("GET", `${pkg(name)}/github-watch`),
        stopGithubWatch: (name) => request("DELETE", `${pkg(name)}/github-watch`),

        yank: (name, version, reason) => request("POST", `${ver(name, version)}/yank`, { reason }),
        unyank: (name, version) => request("DELETE", `${ver(name, version)}/yank`),
        deprecate: (name, { message, version }) =>
            request("PUT", `${pkg(name)}/deprecation`, { message, version }),
        unpublish: (name, version) => request("DELETE", ver(name, version)),
        owners: (name) => request("GET", `${pkg(name)}/owners`),
        addOwner: (name, handle) =>
            request("PUT", `${pkg(name)}/owners/${encodeURIComponent(handle.replace(/^@/, ""))}`),
        removeOwner: (name, handle) =>
            request(
                "DELETE",
                `${pkg(name)}/owners/${encodeURIComponent(handle.replace(/^@/, ""))}`,
            ),

        admin: {
            removePackage: (name, reason) =>
                request("DELETE", `/v1/admin${pkg(name).slice(3)}`, { reason }),
            restorePackage: (name) => request("POST", `/v1/admin${pkg(name).slice(3)}/restore`),
            updateUser: (handle, changes) =>
                request(
                    "PATCH",
                    `/v1/admin/users/${encodeURIComponent(handle.replace(/^@/, ""))}`,
                    changes,
                ),
            audit: (limit = 100) => request("GET", `/v1/admin/audit?limit=${limit}`),
            importLegacy: (registryUrl) =>
                request("POST", "/v1/admin/import-legacy", { registryUrl }),
        },
    }
}
