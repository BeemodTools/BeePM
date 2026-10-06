import { mkdtemp, readFile, rm, stat } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import semver from "semver"
import { bee2Semver } from "../compat.js"
import { readInfoTxt } from "../infotxt.js"
import { MANIFEST_FILE } from "../manifest.js"
import { BUILTIN_SCOPE, PACKAGE_NAME_RE, suggestHandle } from "../names.js"
import { checkPack, hashFile, packFolder, readPack, stripPack } from "../pack.js"
import { uploadFile } from "./download.js"

/**
 * Gets a .bee_pack file or a package folder ready to publish: zips folders, checks it the
 * way the registry will, and leaves out files of types packages can't include (from a
 * copy; the original isn't changed). Throws PackError if it still can't be published.
 * Returns { file, size, sha256, manifest, beeId, info, stripped, skipped, cleanup }.
 * Call cleanup() when done.
 */
export async function preparePublish(input, { handle = null } = {}) {
    const work = await mkdtemp(path.join(os.tmpdir(), "beepm-publish-"))
    const cleanup = () => rm(work, { recursive: true, force: true })
    try {
        let file = input
        let skipped = []
        if ((await stat(input)).isDirectory()) {
            file = path.join(work, "package.bee_pack")
            ;({ skipped } = await packFolder(input, file))
        }

        let checked = await checkPack(file, { defaultScope: handle, allowDisallowed: true })
        const stripped = checked.disallowed
        if (stripped.length) {
            const clean = path.join(work, "clean.bee_pack")
            await stripPack(file, clean, stripped)
            file = clean
            checked = await checkPack(file, { defaultScope: handle })
        }

        return {
            file,
            size: (await stat(file)).size,
            sha256: await hashFile(file),
            manifest: checked.manifest,
            beeId: checked.beeId,
            info: checked.info,
            stripped,
            skipped,
            cleanup,
        }
    } catch (err) {
        await cleanup()
        throw err
    }
}

/**
 * Asks the registry whether a prepared package would be accepted (owner, handle, version,
 * BEE2 ID, dependencies) without uploading it. Throws the RegistryError publishing would.
 */
export function checkWithRegistry(api, prepared) {
    const m = prepared.manifest
    return api.checkPublish({
        manifest: {
            name: m.fullName,
            version: m.version,
            ...(m.compatibleWith ? { compatibleWith: m.compatibleWith } : {}),
            dependencies: m.dependencies,
        },
        beeId: prepared.beeId,
    })
}

/**
 * Uploads a prepared package and publishes it. onProgress(sentBytes, totalBytes).
 * Returns the registry's answer: { name, version, created, strippedFiles, sha256, size }.
 */
export async function publishPrepared(api, prepared, { onProgress } = {}) {
    const { id, upload } = await api.createUpload({ size: prepared.size, sha256: prepared.sha256 })
    await uploadFile(upload, prepared.file, prepared.size, { onProgress })
    return api.finalizeUpload(id)
}

/**
 * Suggests a bee-package.json for a package folder or .bee_pack, from its info.txt:
 * name and title from "Name", and dependencies from "Prerequisites" (BEE2's own packages
 * become @beemod/<ID>; others are looked up in the registry by ID).
 * If a package with the same BEE2 ID is already published (IDs are unique), this is a new
 * version of it: its name is suggested, with the version after its newest one.
 * Returns { manifest, existing, published } where existing is the current bee-package.json,
 * if any, and published is { name, latest } for that package (or null).
 */
export async function suggestManifest(ctx, input, { handle = null, bee2Version = null } = {}) {
    let infoText = null
    let existing = null
    if ((await stat(input)).isDirectory()) {
        infoText = await readFile(path.join(input, "info.txt"), "utf8").catch(() => null)
        existing = await readFile(path.join(input, MANIFEST_FILE), "utf8").catch(() => null)
    } else {
        const pack = await readPack(input)
        infoText = pack.infoText
        existing = pack.manifestText
    }
    if (!infoText) throw new Error("info.txt wasn't found, so this isn't a BEE2 package.")
    const info = readInfoTxt(infoText)

    const title = info.name || info.id
    let name = suggestHandle(title).slice(0, 64)
    if (!PACKAGE_NAME_RE.test(name)) name = info.id.toLowerCase().replace(/_/g, "-")

    const base = new Set(ctx.basePackages ?? [])
    const dependencies = {}
    for (const id of info.prerequisites) {
        if (base.has(id) || !ctx.api) {
            dependencies[`@${BUILTIN_SCOPE}/${id}`] = "*"
            continue
        }
        const { packages } = await ctx.api.lookup({ beeId: id }).catch(() => ({ packages: [] }))
        dependencies[packages.length === 1 ? packages[0] : `@${BUILTIN_SCOPE}/${id}`] = "*"
    }

    let published = null
    if (ctx.api) {
        const { packages } = await ctx.api
            .lookup({ beeId: info.id })
            .catch(() => ({ packages: [] }))
        if (packages.length === 1) {
            const doc = await ctx.api.packument(packages[0]).catch(() => null)
            const latest =
                Object.keys(doc?.versions ?? {})
                    .filter((v) => semver.valid(v))
                    .sort(semver.rcompare)[0] ?? null
            published = { name: packages[0], latest }
        }
    }

    const version = bee2Semver(bee2Version)
    return {
        manifest: {
            name: published?.name ?? (handle ? `@${handle}/${name}` : name),
            version: published?.latest ? semver.inc(published.latest, "patch") : "1.0.0",
            display_name: title,
            description: info.description ? info.description.slice(0, 2000) : "",
            compatibleWith: version ? `>=${version}` : ">=2.4.41",
            dependencies,
        },
        existing,
        published,
    }
}
