const API = "https://api.github.com"
const MAX_ORGS = 10
const MINUTE = 60 * 1000
const MAX_CACHED = 200

/** GitHub refused: `status` is its HTTP status, `limited` says its hourly limit is used up. */
export class GithubError extends Error {}

/**
 * GitHub's answers by URL, per fetch function (one cache for the app, a fresh one per test).
 * Without a GitHub login GitHub allows 60 requests an hour per network, so answers are reused
 * for a while, and an older one stands in when that limit is used up.
 */
const caches = new WeakMap() // fetch -> Map(url -> { at, data })

/** GitHub's limit is used up: says when it resets ("Try again in 17 minutes."). */
function limitReached(res, ErrorType) {
    const retryAfter = Number(res.headers.get("retry-after"))
    const reset = Number(res.headers.get("x-ratelimit-reset"))
    const seconds = retryAfter > 0 ? retryAfter : reset > 0 ? reset - Date.now() / 1000 : 0
    const minutes = Math.max(1, Math.ceil(seconds / 60))
    const when =
        seconds > 0 ? `in ${minutes} minute${minutes === 1 ? "" : "s"}` : "in a few minutes"
    return new ErrorType(`GitHub's hourly limit for this network is used up. Try again ${when}.`)
}

/**
 * JSON from the GitHub API: the answer from the last maxAge ms, or a new one. Failures throw
 * `new ErrorType(message)`, except that the last answer is used while GitHub's limit is used up.
 */
export async function getGithubJson(fetch, url, { maxAge = 0, ErrorType = GithubError } = {}) {
    if (!caches.has(fetch)) caches.set(fetch, new Map())
    const cache = caches.get(fetch)
    const cached = cache.get(url)
    if (cached && Date.now() - cached.at < maxAge) return cached.data

    const res = await fetch(url, {
        headers: { Accept: "application/vnd.github+json", "User-Agent": "BeePM" },
    })
    // A 403 is also how GitHub refuses other things: only these headers mean the limit
    const limited =
        res.status === 429 ||
        (res.status === 403 &&
            (res.headers.get("x-ratelimit-remaining") === "0" || res.headers.has("retry-after")))
    if (limited) {
        if (cached) return cached.data
        throw Object.assign(limitReached(res, ErrorType), { status: res.status, limited: true })
    }
    if (res.status === 404) {
        const err = new ErrorType("GitHub doesn't know that account or repository.")
        throw Object.assign(err, { status: 404 })
    }
    if (!res.ok) {
        throw Object.assign(new ErrorType(`GitHub returned HTTP ${res.status}.`), {
            status: res.status,
        })
    }
    const data = await res.json()
    cache.delete(url)
    cache.set(url, { at: Date.now(), data })
    if (cache.size > MAX_CACHED) cache.delete(cache.keys().next().value)
    return data
}

const githubJson = (fetch, path, maxAge) => getGithubJson(fetch, `${API}${path}`, { maxAge })

/**
 * The public repositories a GitHub account can publish from (the ones the registry accepts):
 * its own, and those of organizations it's a public member of. Most recently pushed first:
 * [{ owner, name, fullName, pushedAt }].
 */
export async function listGithubRepos({ fetch = globalThis.fetch } = {}, username) {
    const user = encodeURIComponent(username)
    const [own, orgs] = await Promise.all([
        githubJson(fetch, `/users/${user}/repos?type=owner&sort=pushed&per_page=100`, 10 * MINUTE),
        githubJson(fetch, `/users/${user}/orgs?per_page=100`, 10 * MINUTE),
    ])
    const orgRepos = await Promise.all(
        orgs
            .slice(0, MAX_ORGS)
            .map((org) =>
                githubJson(
                    fetch,
                    `/orgs/${encodeURIComponent(org.login)}/repos?type=public&sort=pushed&per_page=100`,
                    10 * MINUTE,
                ).catch(() => []),
            ),
    )
    return [...own, ...orgRepos.flat()]
        .filter((repo) => !repo.private)
        .sort((a, b) => String(b.pushed_at ?? "").localeCompare(String(a.pushed_at ?? "")))
        .map((repo) => ({
            owner: repo.owner.login,
            name: repo.name,
            fullName: repo.full_name,
            pushedAt: repo.pushed_at ?? null,
        }))
}

/**
 * A repository's releases that have a .bee_pack attached, newest first:
 * [{ tag, name, publishedAt, prerelease, assets: [".bee_pack file names"] }].
 */
export async function listGithubReleases({ fetch = globalThis.fetch } = {}, owner, repo) {
    // A new release shows up within a minute
    const releases = await githubJson(
        fetch,
        `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/releases?per_page=30`,
        MINUTE,
    )
    return releases
        .filter((release) => !release.draft)
        .map((release) => ({
            tag: release.tag_name,
            name: release.name || release.tag_name,
            publishedAt: release.published_at ?? null,
            prerelease: Boolean(release.prerelease),
            assets: (release.assets ?? [])
                .map((asset) => asset.name)
                .filter((name) => /\.bee_pack$/i.test(name)),
        }))
        .filter((release) => release.assets.length)
}

/**
 * One .bee_pack attached to a release: { name, size, url } (url is its download link). Always
 * asked for fresh, since it's checked right before downloading.
 */
export async function getGithubAsset({ fetch = globalThis.fetch } = {}, owner, repo, tag, name) {
    const release = await githubJson(
        fetch,
        `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/releases/tags/${encodeURIComponent(tag)}`,
    )
    const asset = (release.assets ?? []).find((a) => a.name === name)
    if (!asset || !/\.bee_pack$/i.test(asset.name)) {
        throw Object.assign(new GithubError(`Release ${tag} has no .bee_pack called ${name}.`), {
            status: 404,
        })
    }
    return { name: asset.name, size: asset.size, url: asset.browser_download_url }
}
