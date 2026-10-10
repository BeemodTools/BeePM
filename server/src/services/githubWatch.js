import { formatName, parseName } from "@beepm/core"
import { ApiError } from "../lib/errors.js"
import { withTemp } from "../lib/tmp.js"
import { checkRepoAccess, createGithubApi } from "./github.js"
import { publishFile } from "./publish.js"

/** Which release, and which upload of its .bee_pack, a watch has dealt with. */
export const releaseKey = (release, asset) => `${release.tag_name} ${asset?.id ?? ""}`.trim()

/** A release's .bee_pack: the one with the watched name, or else the only one there is. */
function watchedAsset(release, name) {
    const packs = (release.assets ?? []).filter((a) => a.name.toLowerCase().endsWith(".bee_pack"))
    return packs.find((a) => a.name === name) ?? (packs.length === 1 ? packs[0] : null)
}

/**
 * Turns publishing new releases automatically on for a package (watch: { repo, asset, userId,
 * handled }) or off (watch: null). Set up when a package is published from GitHub.
 */
export async function setGithubWatch(db, fullName, watch) {
    const { scope, name } = parseName(fullName)
    if (!watch) {
        await db.query(
            `DELETE FROM github_watches
              WHERE package_id = (SELECT id FROM packages WHERE scope = $1 AND name = $2)`,
            [scope, name],
        )
        return
    }
    await db.query(
        `INSERT INTO github_watches (package_id, repo, asset, user_id, handled, checked_at)
         SELECT id, $3, $4, $5, $6, now() FROM packages WHERE scope = $1 AND name = $2
         ON CONFLICT (package_id) DO UPDATE
            SET repo = excluded.repo, asset = excluded.asset, user_id = excluded.user_id,
                handled = excluded.handled, checked_at = now(), error = NULL`,
        [scope, name, watch.repo, watch.asset, watch.userId, watch.handled],
    )
}

/**
 * Publishes new GitHub releases of watched packages, as the owner who turned it on and with
 * every normal check: their GitHub account must still own the repo, the version must be new,
 * and the release must be for the same package. A release that can't be published is recorded
 * for the owners to see, and isn't tried again until its .bee_pack is replaced; trouble
 * reaching GitHub is simply retried next time.
 * Returns [{ package, status: "published" | "failed" | "unchanged" | "skipped", version?, error? }].
 */
export async function checkGithubWatches(deps, { limit } = {}) {
    const { db, config } = deps
    // Without a token GitHub allows 60 requests an hour, shared with imports
    const batch = limit ?? (config.githubApiToken ? 200 : 12)
    const gh = createGithubApi(deps.fetch, config.githubApiToken)
    const { rows } = await db.query(
        `SELECT w.*, p.scope, p.name AS package_name, p.removed_at
           FROM github_watches w JOIN packages p ON p.id = w.package_id
          ORDER BY w.checked_at NULLS FIRST LIMIT $1`,
        [batch],
    )
    const results = []
    for (const watch of rows) {
        // Claim it first, so two servers (e.g. during a deploy) never handle the same one
        const { rowCount } = await db.query(
            `UPDATE github_watches SET checked_at = now(), checks = checks + 1
              WHERE package_id = $1 AND checks = $2`,
            [watch.package_id, watch.checks],
        )
        if (rowCount) results.push(await checkWatch(deps, gh, watch))
    }
    return results
}

async function checkWatch(deps, gh, watch) {
    const { db, config } = deps
    const fullName = formatName(watch.scope, watch.package_name)
    if (watch.removed_at) return { package: fullName, status: "skipped" }

    let release
    try {
        release = await gh.json(`/repos/${watch.repo}/releases/latest`)
    } catch (err) {
        return { package: fullName, status: "skipped", error: err.message }
    }
    if (!release) return { package: fullName, status: "unchanged" }
    const asset = watchedAsset(release, watch.asset)
    const key = releaseKey(release, asset)
    if (key === watch.handled) return { package: fullName, status: "unchanged" }

    const record = (error) =>
        db.query("UPDATE github_watches SET handled = $2, error = $3 WHERE package_id = $1", [
            watch.package_id,
            key,
            error,
        ])
    try {
        if (!asset)
            throw new ApiError(400, "no_asset", `it has no .bee_pack called ${watch.asset}.`)
        const {
            rows: [user],
        } = await db.query("SELECT * FROM users WHERE id = $1", [watch.user_id])
        if (!user || user.banned_at) {
            throw new ApiError(403, "cant_publish", "the account that set this up can't publish.")
        }
        const [owner, repo] = watch.repo.split("/")
        await checkRepoAccess({ db, gh }, user, owner, repo)
        if (asset.size > config.maxUploadBytes) {
            const megabytes = Math.round(config.maxUploadBytes / 1048576)
            throw new ApiError(400, "too_large", `its .bee_pack is larger than ${megabytes} MB.`)
        }
        const result = await withTemp(async (tmp) => {
            const file = await tmp.file(".bee_pack")
            await gh.download(asset.browser_download_url, file, config.maxUploadBytes, asset.size)
            return publishFile(
                { ...deps, tmp },
                {
                    user,
                    filePath: file,
                    strip: true,
                    expectName: fullName,
                    source: {
                        type: "github",
                        repo: watch.repo,
                        tag: release.tag_name,
                        asset: asset.name,
                        url: asset.browser_download_url,
                        automatic: true,
                    },
                },
            )
        })
        await record(null)
        deps.log?.info?.(`Published ${fullName}@${result.version} from ${watch.repo}`)
        return { package: fullName, status: "published", version: result.version }
    } catch (err) {
        // Not a refusal (a download or GitHub hiccup): try again next time
        if (!(err instanceof ApiError)) {
            return { package: fullName, status: "skipped", error: err.message }
        }
        const error = `Release ${release.tag_name} wasn't published: ${err.message}`
        await record(error)
        deps.activity?.releaseFailed({
            fullName,
            repo: watch.repo,
            tag: release.tag_name,
            error: err.message,
        })
        return { package: fullName, status: "failed", error }
    }
}

/** Checks the watched repositories every `minutes` (0 turns it off). Returns a stop function. */
export function startGithubWatcher(deps, minutes) {
    if (!minutes) return () => {}
    let running = false
    async function run() {
        if (running) return
        running = true
        try {
            for (const result of await checkGithubWatches(deps)) {
                if (result.status === "failed") deps.log.warn(`${result.package}: ${result.error}`)
            }
        } catch (err) {
            deps.log.warn({ err }, "checking GitHub releases failed")
        } finally {
            running = false
        }
    }
    const timer = setInterval(run, minutes * 60 * 1000)
    timer.unref()
    const first = setTimeout(run, 60 * 1000)
    first.unref()
    return () => {
        clearInterval(timer)
        clearTimeout(first)
    }
}
