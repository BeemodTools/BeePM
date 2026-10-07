import {
    getGithubAsset,
    getGithubJson,
    GithubError,
    listGithubReleases,
    listGithubRepos,
} from "@beepm/core/client"
import { requireUser } from "../auth/guard.js"
import { ApiError, badRequest, forbidden, notFound, tooMany } from "../lib/errors.js"

// GitHub's rules for account and repository names (they become part of GitHub API paths)
const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/
const REPO = /^[A-Za-z0-9._-]{1,100}$/
// Lookups per account, so nobody can use up the registry's GitHub allowance for everyone
const LOOKUPS_PER_WINDOW = 120
const WINDOW_MS = 10 * 60 * 1000

/** GitHub's refusals as registry errors. */
function githubFailure(err) {
    if (!(err instanceof GithubError)) return err
    if (err.limited) return tooMany(err.message, "github_limit")
    if (err.status === 404) return notFound(err.message, "github_not_found")
    return new ApiError(502, "github_error", err.message)
}

/**
 * GitHub lookups for publishing from a release, for the logged-in user: made here with the
 * registry's GITHUB_API_TOKEN (5,000 requests an hour) rather than by the app, which GitHub
 * allows 60 an hour per network. Answers are cached (getGithubJson in core).
 */
export default async function githubRoutes(app) {
    const { db, config } = app.deps
    // One function for the server's life, so the cache of GitHub's answers is shared
    const githubFetch = (url, init = {}) =>
        app.deps.fetch(url, {
            ...init,
            headers: {
                ...init.headers,
                ...(config.githubApiToken
                    ? { Authorization: `Bearer ${config.githubApiToken}` }
                    : {}),
            },
        })
    const recent = new Map() // user id -> when they looked things up, within WINDOW_MS

    async function lookupUser(request) {
        const user = await requireUser(request)
        const now = Date.now()
        const times = (recent.get(user.id) ?? []).filter((at) => now - at < WINDOW_MS)
        if (times.length >= LOOKUPS_PER_WINDOW) {
            throw tooMany("Too many GitHub lookups. Wait a few minutes and try again.")
        }
        times.push(now)
        recent.set(user.id, times)
        if (recent.size > 10000) {
            for (const [id, list] of recent) {
                if (!list.some((at) => now - at < WINDOW_MS)) recent.delete(id)
            }
        }
        return user
    }

    function repoParams({ owner, repo }) {
        if (!OWNER.test(owner) || !REPO.test(repo) || repo === "." || repo === "..") {
            throw badRequest("That isn't a GitHub repository.")
        }
        return { owner, repo }
    }

    /** Only public repositories are looked up, whatever the registry's token can see. */
    async function requirePublic(owner, repo) {
        const info = await getGithubJson(
            githubFetch,
            `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`,
            { maxAge: WINDOW_MS },
        )
        if (info.private) {
            throw notFound("GitHub doesn't know that account or repository.", "github_not_found")
        }
    }

    // The user's linked GitHub account's public repositories and its public organizations'
    app.get("/v1/github/repos", async (request) => {
        const user = await lookupUser(request)
        const { rows } = await db.query(
            "SELECT provider_id FROM identities WHERE user_id = $1 AND provider = 'github'",
            [user.id],
        )
        if (!rows.length) throw forbidden("Link a GitHub account first.", "github_not_linked")
        try {
            // By ID: GitHub accounts can be renamed
            const account = await getGithubJson(
                githubFetch,
                `https://api.github.com/user/${encodeURIComponent(rows[0].provider_id)}`,
                { maxAge: WINDOW_MS },
            )
            return { repos: await listGithubRepos({ fetch: githubFetch }, account.login) }
        } catch (err) {
            throw githubFailure(err)
        }
    })

    // A repository's releases that have a .bee_pack attached
    app.get("/v1/github/repos/:owner/:repo/releases", async (request) => {
        await lookupUser(request)
        const { owner, repo } = repoParams(request.params)
        try {
            await requirePublic(owner, repo)
            return { releases: await listGithubReleases({ fetch: githubFetch }, owner, repo) }
        } catch (err) {
            throw githubFailure(err)
        }
    })

    // ?tag=&name=: one .bee_pack of a release, { name, size, url }, as GitHub has it right now
    app.get("/v1/github/repos/:owner/:repo/asset", async (request) => {
        await lookupUser(request)
        const { owner, repo } = repoParams(request.params)
        const { tag, name } = request.query ?? {}
        if (typeof tag !== "string" || !tag || tag === "." || tag === "..") {
            throw badRequest("Say which release.")
        }
        if (typeof name !== "string" || !name) throw badRequest("Say which .bee_pack.")
        try {
            await requirePublic(owner, repo)
            return {
                asset: await getGithubAsset({ fetch: githubFetch }, owner, repo, tag, name),
            }
        } catch (err) {
            throw githubFailure(err)
        }
    })
}
