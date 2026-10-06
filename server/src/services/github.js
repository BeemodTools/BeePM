import { createWriteStream } from "node:fs"
import { Readable, Transform } from "node:stream"
import { pipeline } from "node:stream/promises"
import { forbidden, notFound } from "../lib/errors.js"

/** Minimal GitHub REST client used for release imports and the old-registry import. */
export function createGithubApi(fetchImpl, token = null) {
    const headers = {
        Accept: "application/vnd.github+json",
        "User-Agent": "BeePM-Registry",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
    }

    return {
        /** Parsed JSON, or null on 404. */
        async json(pathname) {
            const res = await fetchImpl(`https://api.github.com${pathname}`, { headers })
            if (res.status === 404) return null
            if (!res.ok) throw new Error(`GitHub returned HTTP ${res.status} for ${pathname}`)
            return res.json()
        },

        async status(pathname) {
            const res = await fetchImpl(`https://api.github.com${pathname}`, { headers })
            await res.body?.cancel?.()
            return res.status
        },

        /** Downloads a URL (following redirects) to a file, refusing anything over maxBytes. */
        async download(url, destination, maxBytes) {
            const res = await fetchImpl(url, {
                headers: { "User-Agent": "BeePM-Registry", Accept: "application/octet-stream" },
                redirect: "follow",
            })
            if (!res.ok || !res.body) throw new Error(`Download failed with HTTP ${res.status}`)
            let received = 0
            const limit = new Transform({
                transform(chunk, _encoding, callback) {
                    received += chunk.length
                    if (received > maxBytes)
                        callback(new Error("The file is larger than the size limit"))
                    else callback(null, chunk)
                },
            })
            await pipeline(Readable.fromWeb(res.body), limit, createWriteStream(destination))
            return received
        },
    }
}

/**
 * Whether `user` may publish from GitHub repository owner/repo: their linked GitHub account owns
 * it, or is a public member of the organization that does (admins may use any public repo).
 * Returns the repo's info from GitHub; throws an ApiError otherwise.
 */
export async function checkRepoAccess({ db, gh }, user, owner, repo) {
    const { rows: identities } = await db.query(
        "SELECT provider_id FROM identities WHERE user_id = $1 AND provider = 'github'",
        [user.id],
    )
    if (!identities.length && user.role !== "admin") {
        throw forbidden(
            "Link a GitHub account to publish from GitHub releases.",
            "github_not_linked",
        )
    }
    const repoInfo = await gh.json(`/repos/${owner}/${repo}`)
    if (!repoInfo)
        throw notFound(`GitHub repository ${owner}/${repo} doesn't exist or isn't public.`)

    const githubId = identities[0]?.provider_id
    let allowed = user.role === "admin" || String(repoInfo.owner.id) === githubId
    if (!allowed && githubId && repoInfo.owner.type === "Organization") {
        const me = await gh.json(`/user/${githubId}`)
        if (me) {
            const status = await gh.status(
                `/orgs/${repoInfo.owner.login}/public_members/${me.login}`,
            )
            allowed = status === 204
        }
    }
    if (!allowed) {
        throw forbidden(
            `Your linked GitHub account doesn't own ${repoInfo.full_name}. For an organization's repository, make your membership of the organization public.`,
            "not_repo_owner",
        )
    }
    return repoInfo
}
