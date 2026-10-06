const API = "https://api.github.com"
const MAX_ORGS = 10

export class GithubError extends Error {}

async function githubJson(fetch, path) {
    const res = await fetch(`${API}${path}`, {
        headers: { Accept: "application/vnd.github+json", "User-Agent": "BeePM" },
    })
    if (res.status === 403 || res.status === 429) {
        throw new GithubError("GitHub's rate limit was hit. Wait a few minutes and try again.")
    }
    if (res.status === 404) throw new GithubError("GitHub doesn't know that account or repository.")
    if (!res.ok) throw new GithubError(`GitHub returned HTTP ${res.status}.`)
    return res.json()
}

/**
 * The public repositories a GitHub account can publish from (the ones the registry accepts):
 * its own, and those of organizations it's a public member of. Most recently pushed first:
 * [{ owner, name, fullName, pushedAt }].
 */
export async function listGithubRepos({ fetch = globalThis.fetch } = {}, username) {
    const user = encodeURIComponent(username)
    const [own, orgs] = await Promise.all([
        githubJson(fetch, `/users/${user}/repos?type=owner&sort=pushed&per_page=100`),
        githubJson(fetch, `/users/${user}/orgs?per_page=100`),
    ])
    const orgRepos = await Promise.all(
        orgs
            .slice(0, MAX_ORGS)
            .map((org) =>
                githubJson(
                    fetch,
                    `/orgs/${encodeURIComponent(org.login)}/repos?type=public&sort=pushed&per_page=100`,
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
    const releases = await githubJson(
        fetch,
        `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/releases?per_page=30`,
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

/** One .bee_pack attached to a release: { name, size, url } (url is its download link). */
export async function getGithubAsset({ fetch = globalThis.fetch } = {}, owner, repo, tag, name) {
    const release = await githubJson(
        fetch,
        `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/releases/tags/${encodeURIComponent(tag)}`,
    )
    const asset = (release.assets ?? []).find((a) => a.name === name)
    if (!asset || !/\.bee_pack$/i.test(asset.name)) {
        throw new GithubError(`Release ${tag} has no .bee_pack called ${name}.`)
    }
    return { name: asset.name, size: asset.size, url: asset.browser_download_url }
}
