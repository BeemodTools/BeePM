import { randomUUID } from "node:crypto"
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import {
    MANIFEST_FILE,
    ManifestError,
    PackError,
    putFileInZip,
    validateManifest,
} from "@beepm/core"
import {
    checkWithRegistry,
    downloadFile,
    loadConfig,
    preparePublish,
    publishPrepared,
    RegistryError,
    suggestManifest,
} from "@beepm/core/client"
import { AppError, fileSize, isLocalPath, listOf, optionalText, throttle } from "../util.js"

function parseManifest(text) {
    if (!text) return null
    try {
        const value = JSON.parse(String(text).replace(/^\uFEFF/, ""))
        return value && typeof value === "object" && !Array.isArray(value) ? value : null
    } catch {
        return null
    }
}

/**
 * Publishing (DESIGN.md "Publishing"): publish:prepare checks a .bee_pack or folder locally and
 * keeps the prepared copy under an id; publish:upload(id) sends it, with "publish:progress"
 * events. Nothing here holds storage keys: the registry hands out a presigned upload URL.
 */
// Refusals that come from bee-package.json, so the window offers to fix it
const MANIFEST_CODES = new Set([
    "invalid_package",
    "wrong_scope",
    "not_owner",
    "version_exists",
    "unknown_dependency",
    "unsatisfiable_dependency",
])

// The registry's default size limit: a bigger release file isn't worth downloading to check
const MAX_RELEASE_BYTES = 512 * 1024 * 1024

/** What the window shows of a prepared package. */
function describePrepared(id, result) {
    const m = result.manifest
    return {
        id,
        size: result.size,
        sha256: result.sha256,
        beeId: result.beeId,
        manifest: {
            scope: m.scope,
            name: m.name,
            fullName: m.fullName,
            version: m.version,
            displayName: m.displayName,
            description: m.description,
            compatibleWith: m.compatibleWith,
            dependencies: m.dependencies,
        },
        info: {
            name: result.info?.name ?? null,
            description: result.info?.description ?? null,
        },
        stripped: result.stripped,
        skipped: result.skipped,
    }
}

export function publishHandlers(shared) {
    const { ctx, deps, log, step } = shared
    const prepared = new Map() // id -> preparePublish() result, until it's published or discarded

    /** A checked package in the log: what it is, and the files that had to be left out. */
    function logPrepared(result) {
        const m = result.manifest
        log.info(`${m.fullName}@${m.version}, ${fileSize(result.size)}`)
        if (result.stripped?.length) {
            log.info(`Removed files that aren't allowed: ${listOf(result.stripped, "files")}`)
        }
    }

    /** Why a package can't be published, one line each, before the step fails. */
    const logProblems = (problems) => {
        for (const problem of problems ?? []) log.warn(problem)
    }

    async function resolveInput(input) {
        const text = optionalText(input)
        if (!text) throw new AppError("Choose a .bee_pack file or a package folder.")
        const target = path.resolve(text)
        if (!isLocalPath(target)) throw new AppError("Choose a file or folder on this PC.")
        const info = await stat(target).catch(() => null)
        if (!info) throw new AppError(`${target} doesn't exist.`)
        return { target, isFolder: info.isDirectory() }
    }

    function requireLogin() {
        if (!shared.login) throw new AppError("Log in to publish.", { code: "login_required" })
    }

    /**
     * The registry's own rules (owner and handle, version, BEE2 ID, dependencies), checked
     * before Review so a package it would refuse never gets past the check. Returns the
     * refusal, or null. Skipped (null) when logged out, offline, or the registry can't check.
     */
    async function registryRefusal(result) {
        if (!shared.login) return null
        try {
            await checkWithRegistry(ctx.api, result)
            return null
        } catch (err) {
            const skip =
                !(err instanceof RegistryError) ||
                !err.status ||
                err.status === 401 ||
                err.status === 404 ||
                err.status >= 500
            if (skip) return null
            return {
                problems: err.details?.problems ?? [err.message],
                manifestProblem: MANIFEST_CODES.has(err.code),
            }
        }
    }

    async function discard(id) {
        const item = prepared.get(id)
        prepared.delete(id)
        await item?.cleanup().catch(() => {})
    }

    shared.disposers.push(async () => {
        for (const id of [...prepared.keys()]) await discard(id)
    })

    return {
        "publish:pick": async (kind) => {
            const result = await deps.showOpenDialog(
                kind === "folder"
                    ? { title: "Choose a package folder", properties: ["openDirectory"] }
                    : {
                          title: "Choose a .bee_pack file",
                          properties: ["openFile"],
                          filters: [{ name: "BEE2 packages", extensions: ["bee_pack", "zip"] }],
                      },
            )
            if (result.canceled || !result.filePaths?.length) return { canceled: true }
            return { canceled: false, path: result.filePaths[0] }
        },

        "publish:prepare": async (input) => {
            const { target, isFolder } = await resolveInput(input)
            return step(`Checking ${path.basename(target)}`, async () => {
                let result
                try {
                    result = await preparePublish(target, { handle: shared.handle })
                } catch (err) {
                    if (!(err instanceof PackError)) throw err
                    logProblems(err.problems)
                    throw new AppError("This package can't be published yet.", {
                        code: "invalid_package",
                        problems: err.problems,
                        path: target,
                        isFolder,
                        // bee-package.json is missing or invalid: offer to create one
                        manifestProblem: err.problems.some((p) => p.startsWith(MANIFEST_FILE)),
                    })
                }
                logPrepared(result)
                const refusal = await registryRefusal(result)
                if (refusal) {
                    await result.cleanup().catch(() => {})
                    logProblems(refusal.problems)
                    throw new AppError("This package can't be published yet.", {
                        code: "invalid_package",
                        ...refusal,
                        path: target,
                        isFolder,
                    })
                }
                const id = randomUUID()
                prepared.set(id, result)
                return { ...describePrepared(id, result), path: target, isFolder }
            })
        },

        /**
         * A .bee_pack attached to a GitHub release, checked the same way as a file: it's
         * downloaded here first. Publishing it then has the registry import the release (and
         * check it again) rather than uploading this copy. GitHub lookups go through the
         * registry, which has a GitHub token (see the registry's routes/github.js).
         */
        "publish:prepare-github": async (options = {}) => {
            const owner = optionalText(options?.owner)
            const repo = optionalText(options?.repo)
            const tag = optionalText(options?.tag)
            const name = optionalText(options?.asset)
            if (!owner || !repo || !tag || !name) {
                throw new AppError("Pick a repository, a release and its .bee_pack.")
            }
            requireLogin()
            return step(`Checking ${name} from ${owner}/${repo} ${tag}`, async () => {
                const { asset } = await ctx.api.githubAsset(owner, repo, tag, name)
                if (asset.size > MAX_RELEASE_BYTES) {
                    throw new AppError(`${asset.name} is larger than 512 MB.`)
                }

                const work = await mkdtemp(path.join(os.tmpdir(), "beepm-github-"))
                const removeWork = () => rm(work, { recursive: true, force: true })
                let result
                try {
                    const file = path.join(work, "release.bee_pack")
                    await downloadFile(asset.url, file, {
                        fetch: ctx.fetch,
                        expectedSize: asset.size,
                    })
                    result = await preparePublish(file, { handle: shared.handle })
                } catch (err) {
                    await removeWork()
                    // For a while after a release's file is replaced, GitHub can send the old one
                    if (err.code === "size_mismatch") {
                        throw new AppError(
                            `GitHub sent a different ${asset.name} than release ${tag} lists (it was probably just replaced). Try again in a few minutes.`,
                        )
                    }
                    if (!(err instanceof PackError)) throw err
                    logProblems(err.problems)
                    throw new AppError("This release can't be published yet.", {
                        code: "invalid_package",
                        problems: err.problems,
                        manifestProblem: err.problems.some((p) => p.startsWith(MANIFEST_FILE)),
                    })
                }
                logPrepared(result)
                const cleanup = result.cleanup
                result.cleanup = () => cleanup().finally(removeWork)
                const refusal = await registryRefusal(result)
                if (refusal) {
                    await result.cleanup().catch(() => {})
                    logProblems(refusal.problems)
                    throw new AppError("This release can't be published yet.", {
                        code: "invalid_package",
                        ...refusal,
                    })
                }
                result.github = { owner, repo, tag, asset: asset.name }
                const id = randomUUID()
                prepared.set(id, result)
                return {
                    ...describePrepared(id, result),
                    github: { ...result.github, fullName: `${owner}/${repo}` },
                }
            })
        },

        // options.watch (GitHub releases): publish the repo's new releases automatically too
        "publish:upload": async (id, options = {}) => {
            requireLogin()
            const item = prepared.get(id)
            if (!item) throw new AppError("This package isn't ready anymore. Choose it again.")
            if (item.uploading) throw new AppError("This package is already being published.")
            item.uploading = true
            const report = throttle((progress) =>
                deps.send("publish:progress", { id, ...progress }),
            )
            const { fullName, version } = item.manifest
            const github = item.github
            const from = github ? ` from ${github.owner}/${github.repo} ${github.tag}` : ""
            try {
                return await step(`Publishing ${fullName}@${version}${from}`, async () => {
                    // A GitHub release is imported by the registry, which downloads it itself
                    const result = github
                        ? await ctx.api.importGithub({ ...github, watch: Boolean(options?.watch) })
                        : await publishPrepared(ctx.api, item, {
                              onProgress: (sent, total) => report({ sent, total }),
                          })
                    if (result?.watching) {
                        log.info(
                            `New releases of ${github.owner}/${github.repo} will be published automatically`,
                        )
                    }
                    await discard(id)
                    return { result }
                })
            } finally {
                report.flush()
                item.uploading = false
            }
        },

        "publish:discard": async (id) => {
            await discard(id)
            return {}
        },

        /** The linked GitHub account's repositories that can be published from. */
        "publish:github-repos": async () => {
            requireLogin()
            return { repos: (await ctx.api.githubRepos()).repos }
        },

        /** A repository's releases that have a .bee_pack attached. */
        "publish:github-releases": async (options = {}) => {
            const owner = optionalText(options?.owner)
            const repo = optionalText(options?.repo)
            if (!owner || !repo) throw new AppError("Pick a repository.")
            requireLogin()
            return { releases: (await ctx.api.githubReleases(owner, repo)).releases }
        },

        // A bee-package.json suggested from info.txt, plus the current one (if any) to start from
        "publish:suggest-manifest": async (input) => {
            const { target, isFolder } = await resolveInput(input)
            const config = await loadConfig(ctx.paths)
            const { manifest, existing, published } = await suggestManifest(
                { api: ctx.api },
                target,
                { handle: shared.handle, bee2Version: config.bee2?.version ?? null },
            )
            return {
                path: target,
                isFolder,
                manifest,
                existing: parseManifest(existing),
                existingText: existing ?? null,
                published,
            }
        },

        // A folder gets the file written into it; a .bee_pack gets it added inside the zip
        // (every other file in the zip is kept exactly as it was)
        "publish:write-manifest": async (input, manifest) => {
            const { target, isFolder } = await resolveInput(input)
            try {
                validateManifest(manifest, { defaultScope: shared.handle })
            } catch (err) {
                if (!(err instanceof ManifestError)) throw err
                throw new AppError(`${MANIFEST_FILE} has problems.`, {
                    code: "invalid_manifest",
                    problems: err.problems,
                })
            }
            const text = JSON.stringify(manifest, null, 4) + "\n"
            return step(`Saving ${MANIFEST_FILE} in ${path.basename(target)}`, async () => {
                if (!isFolder) {
                    await putFileInZip(target, MANIFEST_FILE, text)
                    return { file: target, insidePack: true }
                }
                const file = path.join(target, MANIFEST_FILE)
                await writeFile(file, text)
                return { file, insidePack: false }
            })
        },
    }
}
