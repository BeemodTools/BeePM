import { suggestHandle } from "@beepm/core"
import { withTemp } from "../lib/tmp.js"
import { createGithubApi } from "./github.js"
import { publishFile } from "./publish.js"
import { findUserByHandle, findUserByIdentity, handleProblem, createUser } from "./users.js"

async function fetchJson(fetchImpl, url) {
    const res = await fetchImpl(url, { headers: { "User-Agent": "BeePM-Registry" } })
    if (!res.ok) throw new Error(`${url} returned HTTP ${res.status}`)
    return res.json()
}

/**
 * Copies every package from the old public R2 registry (registry.json and
 * github_packages.json) into this registry. Safe to run again: existing versions are skipped.
 *
 * Each old author (a GitHub username) becomes an unclaimed BeePM account with that GitHub
 * identity, so the owner gets their packages when they first log in with GitHub.
 */
export async function importLegacy(deps, { registryUrl }) {
    const { db, config } = deps
    const fetchImpl = deps.fetch
    const gh = createGithubApi(fetchImpl, config.githubApiToken)
    const problems = []
    const imported = []
    const skipped = []

    const base = registryUrl.replace(/registry\.json$/, "").replace(/\/+$/, "")
    const registry = await fetchJson(fetchImpl, registryUrl)
    let githubPackages = { packages: {} }
    try {
        githubPackages = await fetchJson(fetchImpl, `${base}/github_packages.json`)
    } catch (err) {
        problems.push(`github_packages.json couldn't be read: ${err.message}`)
    }

    // One list of { beeId, author, version, url, source, publishedAt }
    const entries = []
    for (const [beeId, pkg] of Object.entries(registry.packages?.by_id ?? {})) {
        for (const [version, info] of Object.entries(pkg.versions ?? {})) {
            if (!info.path) continue
            const url = `${base}${info.path.startsWith("/") ? "" : "/"}${info.path}package.bee_pack`
            entries.push({
                beeId,
                author: pkg.author,
                version,
                url,
                yanked: info.yanked ? info.yank_reason || "Yanked in the old registry" : null,
                source: { type: "legacy", url },
                publishedAt: registry.lastUpdated ?? null,
            })
        }
    }
    for (const [beeId, pkg] of Object.entries(githubPackages.packages ?? {})) {
        for (const [version, info] of Object.entries(pkg.versions ?? {})) {
            if (!info.downloadUrl) continue
            entries.push({
                beeId,
                author: pkg.author,
                version,
                url: info.downloadUrl,
                source: {
                    type: "github",
                    repo: info.github ? `${info.github.owner}/${info.github.repo}` : null,
                    tag: info.github?.tag ?? null,
                    asset: decodeURIComponent(info.downloadUrl.split("/").pop()),
                    legacy: true,
                },
                publishedAt: info.publishedAt ?? null,
            })
        }
    }

    const users = new Map()
    async function legacyUser(author) {
        if (users.has(author)) return users.get(author)
        let user = null
        const ghUser = await gh.json(`/users/${encodeURIComponent(author)}`).catch(() => null)
        if (ghUser) user = await findUserByIdentity(db, "github", String(ghUser.id))
        if (!user) {
            const handle = suggestHandle(author)
            const existing = await findUserByHandle(db, handle)
            if (existing) {
                problems.push(
                    `@${handle} already belongs to a different account, so ${author}'s packages were skipped.`,
                )
            } else if (await handleProblem(db, handle)) {
                problems.push(
                    `"${author}" can't be used as a handle, so their packages were skipped.`,
                )
            } else {
                user = await createUser(db, {
                    handle,
                    claimed: false,
                    profile: ghUser
                        ? {
                              provider: "github",
                              providerId: String(ghUser.id),
                              username: ghUser.login,
                              displayName: ghUser.name || ghUser.login,
                              avatarUrl: ghUser.avatar_url,
                              accountCreatedAt: ghUser.created_at,
                          }
                        : null,
                })
                if (!ghUser) {
                    problems.push(
                        `GitHub user ${author} wasn't found; @${handle} was created without a login, so an admin has to add an owner.`,
                    )
                }
            }
        }
        users.set(author, user)
        return user
    }

    for (const entry of entries) {
        const label = `${entry.author}/${entry.beeId}@${entry.version}`
        const { rows } = await db.query(
            `SELECT 1 FROM versions v JOIN packages p ON p.id = v.package_id
              WHERE upper(p.bee_id) = $1 AND v.version = $2`,
            [entry.beeId.toUpperCase(), entry.version],
        )
        if (rows.length) {
            skipped.push(label)
            continue
        }
        const user = await legacyUser(entry.author)
        if (!user) continue

        try {
            const result = await withTemp(async (tmp) => {
                const file = await tmp.file(".bee_pack")
                await gh.download(entry.url, file, 4 * 1024 * 1024 * 1024)
                return publishFile(
                    { ...deps, tmp },
                    {
                        user,
                        filePath: file,
                        strip: true,
                        source: entry.source,
                        publishedAt: entry.publishedAt,
                        skipDependencyCheck: true,
                        allowLegacy: true,
                        forceScope: user.handle,
                    },
                )
            })
            if (entry.yanked) {
                await db.query(
                    `UPDATE versions SET yanked_at = now(), yank_reason = $3
                      WHERE version = $2 AND package_id = (SELECT id FROM packages WHERE scope || '/' || name = $1)`,
                    [result.name.slice(1), result.version, entry.yanked],
                )
            }
            imported.push(
                `${result.name}@${result.version}${result.strippedFiles.length ? ` (removed ${result.strippedFiles.length} disallowed files)` : ""}`,
            )
        } catch (err) {
            const details = err.details?.problems ? `: ${err.details.problems.join("; ")}` : ""
            problems.push(`${label}: ${err.message}${details}`)
        }
    }

    return {
        packages: new Set(imported.map((i) => i.split("@").slice(0, 2).join("@"))).size,
        versions: imported.length,
        imported,
        skipped,
        problems,
    }
}
