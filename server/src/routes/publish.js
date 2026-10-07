import { MANIFEST_FILE, ManifestError, validateManifest } from "@beepm/core"
import { requireUser } from "../auth/guard.js"
import { badRequest, conflict, forbidden, notFound, tooMany } from "../lib/errors.js"
import { randomId } from "../lib/ids.js"
import { withTemp } from "../lib/tmp.js"
import { checkRepoAccess, createGithubApi } from "../services/github.js"
import { releaseKey, setGithubWatch } from "../services/githubWatch.js"
import { checkPublishable, publishFile } from "../services/publish.js"
import { publishEligibility } from "../services/users.js"
import { uploadKey } from "../storage/index.js"

// GitHub owner/repo names; "." and ".." would change the API path
const GITHUB_NAME = /^(?!\.{1,2}$)[A-Za-z0-9_.-]{1,100}$/

/** Publishing: upload + finalize, and imports from GitHub releases. */
export default async function publishRoutes(app) {
    const { db, config, storage } = app.deps
    const megabytes = Math.round(config.maxUploadBytes / 1048576)

    async function checkRateLimit(user) {
        if (user.role === "admin") return
        const { rows } = await db.query(
            `SELECT count(*) FILTER (WHERE created_at > now() - interval '1 hour')::int AS hour,
                    count(*)::int AS day
               FROM uploads WHERE user_id = $1 AND created_at > now() - interval '1 day'`,
            [user.id],
        )
        if (rows[0].hour >= config.publishesPerHour) {
            throw tooMany(
                `You can publish ${config.publishesPerHour} times per hour. Try again later.`,
            )
        }
        if (rows[0].day >= config.publishesPerDay) {
            throw tooMany(
                `You can publish ${config.publishesPerDay} times per day. Try again tomorrow.`,
            )
        }
    }

    async function requirePublisher(request) {
        const user = await requireUser(request)
        const eligibility = await publishEligibility(db, config, user)
        if (!eligibility.ok) throw forbidden(eligibility.reason, "account_too_new")
        await checkRateLimit(user)
        return user
    }

    // 1. Reserve an upload and get a presigned URL for it
    app.post("/v1/uploads", async (request) => {
        const user = await requirePublisher(request)
        const { size, sha256 } = request.body || {}
        if (!Number.isInteger(size) || size <= 0)
            throw badRequest("size must be the file size in bytes.")
        if (size > config.maxUploadBytes) {
            throw badRequest(`Packages can be at most ${megabytes} MB.`, "too_large")
        }
        if (typeof sha256 !== "string" || !/^[0-9a-f]{64}$/.test(sha256)) {
            throw badRequest("sha256 must be the file's SHA-256 as 64 lowercase hex characters.")
        }

        const id = randomId(16)
        const key = uploadKey(id)
        const expiresAt = new Date(Date.now() + 3600 * 1000)
        await db.query(
            `INSERT INTO uploads (id, user_id, storage_key, size, sha256, expires_at)
             VALUES ($1, $2, $3, $4, $5, $6)`,
            [id, user.id, key, size, sha256, expiresAt],
        )
        const upload = await storage.uploadTarget(key, { size, expiresIn: 3600 })
        return { id, upload, expiresAt, maxBytes: config.maxUploadBytes }
    })

    // 2. After the client has PUT the file: check it and publish it
    app.post("/v1/uploads/:id/finalize", async (request) => {
        const user = await requireUser(request)
        const { rows } = await db.query(
            `UPDATE uploads SET status = 'processing'
              WHERE id = $1 AND user_id = $2 AND status = 'pending' RETURNING *`,
            [request.params.id, user.id],
        )
        if (!rows.length) {
            const { rows: existing } = await db.query(
                "SELECT status, result, error FROM uploads WHERE id = $1 AND user_id = $2",
                [request.params.id, user.id],
            )
            if (!existing.length) throw notFound("Unknown upload.")
            if (existing[0].status === "done") return existing[0].result
            if (existing[0].status === "processing")
                throw conflict("This upload is already being published.")
            throw badRequest(
                existing[0].error || "This upload failed. Publish again.",
                "upload_failed",
            )
        }
        const upload = rows[0]

        const head = await storage.head(upload.storage_key)
        if (!head) {
            const expired = new Date(upload.expires_at) < new Date()
            await db.query("UPDATE uploads SET status = $2 WHERE id = $1", [
                upload.id,
                expired ? "failed" : "pending",
            ])
            throw badRequest(
                expired
                    ? "This upload expired. Publish again."
                    : "The file hasn't been uploaded yet.",
                "not_uploaded",
            )
        }

        try {
            if (head.size !== Number(upload.size)) {
                throw badRequest(
                    "The uploaded file doesn't have the size you declared.",
                    "size_mismatch",
                )
            }
            const result = await withTemp(async (tmp) => {
                const file = await tmp.file(".bee_pack")
                await storage.downloadTo(upload.storage_key, file)
                return publishFile(
                    { ...app.deps, tmp },
                    {
                        user,
                        filePath: file,
                        sha256: upload.sha256,
                        source: { type: "upload" },
                        stagingKey: upload.storage_key,
                    },
                )
            })
            await db.query("UPDATE uploads SET status = 'done', result = $2 WHERE id = $1", [
                upload.id,
                JSON.stringify(result),
            ])
            return result
        } catch (err) {
            await db.query("UPDATE uploads SET status = 'failed', error = $2 WHERE id = $1", [
                upload.id,
                String(err.message).slice(0, 2000),
            ])
            throw err
        } finally {
            await storage.remove(upload.storage_key).catch(() => {})
        }
    })

    // Before uploading: would this bee-package.json (and info.txt's BEE2 ID) be accepted?
    // Runs every check publishing runs except on the file itself.
    app.post("/v1/publish/check", async (request) => {
        const user = await requirePublisher(request)
        const { manifest, beeId } = request.body || {}
        if (typeof beeId !== "string" || !beeId.trim() || beeId.length > 200) {
            throw badRequest("beeId must be the ID from info.txt.")
        }
        let checked
        try {
            checked = validateManifest(manifest, { defaultScope: user.handle })
        } catch (err) {
            if (!(err instanceof ManifestError)) throw err
            throw badRequest(err.message, "invalid_package", {
                problems: err.problems.map((p) => `${MANIFEST_FILE}: ${p}`),
            })
        }
        return checkPublishable(db, user, checked, beeId.trim().toUpperCase())
    })

    // Publish a .bee_pack attached to a GitHub release the user owns. watch: true also publishes
    // the repo's new releases automatically from now on; false stops that.
    app.post("/v1/imports/github", async (request) => {
        const user = await requirePublisher(request)
        const { owner, repo, tag, asset, watch } = request.body || {}
        if (watch !== undefined && typeof watch !== "boolean") {
            throw badRequest("watch must be true or false.")
        }
        if (!GITHUB_NAME.test(owner || "") || !GITHUB_NAME.test(repo || "")) {
            throw badRequest(
                "Give the repository as owner and repo, e.g. Areng14 and ArengBeemodPackages.",
            )
        }
        if (
            tag !== undefined &&
            tag !== null &&
            (typeof tag !== "string" || !tag || tag.length > 200)
        ) {
            throw badRequest("tag must be a release tag.")
        }

        const gh = createGithubApi(app.deps.fetch, config.githubApiToken)
        const repoInfo = await checkRepoAccess({ db, gh }, user, owner, repo)

        const release = await gh.json(
            tag
                ? `/repos/${repoInfo.full_name}/releases/tags/${encodeURIComponent(tag)}`
                : `/repos/${repoInfo.full_name}/releases/latest`,
        )
        if (!release) {
            throw notFound(
                tag ? `Release ${tag} wasn't found.` : `${repoInfo.full_name} has no releases.`,
            )
        }
        const packs = (release.assets || []).filter((a) =>
            a.name.toLowerCase().endsWith(".bee_pack"),
        )
        const chosen = asset
            ? packs.find((a) => a.name === asset)
            : packs.length === 1
              ? packs[0]
              : null
        if (!chosen) {
            throw badRequest(
                packs.length
                    ? `Release ${release.tag_name} has ${packs.length} .bee_pack files. Pick one: ${packs.map((a) => a.name).join(", ")}`
                    : `Release ${release.tag_name} has no .bee_pack file.`,
                packs.length ? "choose_asset" : "no_asset",
                { assets: packs.map((a) => a.name) },
            )
        }
        if (chosen.size > config.maxUploadBytes) {
            throw badRequest(`Packages can be at most ${megabytes} MB.`, "too_large")
        }

        // Imports count towards the publish limits too
        const id = randomId(16)
        await db.query(
            `INSERT INTO uploads (id, user_id, storage_key, size, sha256, status, expires_at)
             VALUES ($1, $2, $3, $4, '', 'processing', now())`,
            [id, user.id, `github:${repoInfo.full_name}`, chosen.size],
        )
        try {
            const result = await withTemp(async (tmp) => {
                const file = await tmp.file(".bee_pack")
                await gh
                    .download(chosen.browser_download_url, file, config.maxUploadBytes, chosen.size)
                    .catch((err) => {
                        if (err.code !== "size_mismatch") throw err
                        throw conflict(
                            `GitHub sent a different ${chosen.name} than release ${release.tag_name} lists (it was probably just replaced). Try again in a few minutes.`,
                            "github_mismatch",
                        )
                    })
                return publishFile(
                    { ...app.deps, tmp },
                    {
                        user,
                        filePath: file,
                        strip: true,
                        source: {
                            type: "github",
                            repo: repoInfo.full_name,
                            tag: release.tag_name,
                            asset: chosen.name,
                        },
                    },
                )
            })
            await db.query("UPDATE uploads SET status = 'done', result = $2 WHERE id = $1", [
                id,
                JSON.stringify(result),
            ])
            if (watch === undefined) return result
            await setGithubWatch(
                db,
                result.name,
                watch && {
                    repo: repoInfo.full_name,
                    asset: chosen.name,
                    userId: user.id,
                    handled: releaseKey(release, chosen),
                },
            )
            return { ...result, watching: watch }
        } catch (err) {
            await db.query("UPDATE uploads SET status = 'failed', error = $2 WHERE id = $1", [
                id,
                String(err.message).slice(0, 2000),
            ])
            throw err
        }
    })
}
