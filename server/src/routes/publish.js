import { requireUser } from "../auth/guard.js"
import { badRequest, conflict, forbidden, notFound, tooMany } from "../lib/errors.js"
import { randomId } from "../lib/ids.js"
import { withTemp } from "../lib/tmp.js"
import { createGithubApi } from "../services/github.js"
import { publishFile } from "../services/publish.js"
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

    // Publish a .bee_pack attached to a GitHub release the user owns
    app.post("/v1/imports/github", async (request) => {
        const user = await requirePublisher(request)
        const { owner, repo, tag, asset } = request.body || {}
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

        const gh = createGithubApi(app.deps.fetch, config.githubApiToken)
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
                await gh.download(chosen.browser_download_url, file, config.maxUploadBytes)
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
            return result
        } catch (err) {
            await db.query("UPDATE uploads SET status = 'failed', error = $2 WHERE id = $1", [
                id,
                String(err.message).slice(0, 2000),
            ])
            throw err
        }
    })
}
