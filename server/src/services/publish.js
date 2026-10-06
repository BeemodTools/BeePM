import { stat } from "node:fs/promises"
import {
    BUILTIN_SCOPE,
    checkPack,
    formatName,
    hashFile,
    PackError,
    parseName,
    stripPack,
} from "@beepm/core"
import semver from "semver"
import { audit } from "../lib/audit.js"
import { ApiError, badRequest, conflict, forbidden } from "../lib/errors.js"
import { versionKey } from "../storage/index.js"
import { latestVersion } from "./packages.js"
import { findUserByHandle } from "./users.js"

/** Turns a PackError into a 400 the client can show line by line. */
export function packErrorToApi(err) {
    if (err instanceof PackError) {
        return badRequest(err.message, "invalid_package", {
            problems: err.problems,
            disallowed: err.disallowed,
        })
    }
    return err
}

/**
 * Maps each dependency to a real registry package:
 * - @beemod/<ID> stays as is (BEE2 built-ins)
 * - @scope/name must exist; old @scope/BEE2_ID keys are rewritten to the package with that ID
 * - the range must match at least one published, unyanked version
 */
async function resolveDependencies(db, manifest) {
    const resolved = {}
    for (const [key, range] of Object.entries(manifest.dependencies)) {
        const { scope, name } = parseName(key)
        if (scope === BUILTIN_SCOPE) {
            resolved[key] = range
            continue
        }
        let { rows } = await db.query(
            "SELECT id, scope, name FROM packages WHERE scope = $1 AND name = $2 AND removed_at IS NULL",
            [scope, name],
        )
        const legacyId = manifest.legacyDependencyIds[key]
        if (!rows.length && legacyId) {
            ;({ rows } = await db.query(
                "SELECT id, scope, name FROM packages WHERE scope = $1 AND upper(bee_id) = $2 AND removed_at IS NULL",
                [scope, legacyId],
            ))
        }
        if (!rows.length)
            throw badRequest(
                `Dependency ${key} doesn't exist in the registry.`,
                "unknown_dependency",
            )

        const dep = rows[0]
        const { rows: versions } = await db.query(
            "SELECT version FROM versions WHERE package_id = $1 AND unpublished_at IS NULL AND yanked_at IS NULL",
            [dep.id],
        )
        const depName = formatName(dep.scope, dep.name)
        if (
            !versions.some((v) => semver.satisfies(v.version, range, { includePrerelease: true }))
        ) {
            throw badRequest(
                `No published version of ${depName} matches "${range}".`,
                "unsatisfiable_dependency",
            )
        }
        resolved[depName] = range
    }
    return resolved
}

/**
 * Publishes a .bee_pack that's already on this server's disk as a new version.
 *   user        who is publishing (row from users, or the request user)
 *   filePath    the file; sha256/size are checked against it if given
 *   source      stored with the version, e.g. { type: "upload" } or { type: "github", ... }
 *   stagingKey  if set, the file is already in the bucket there and gets copied (no re-upload)
 *   strip       remove disallowed files instead of rejecting them (GitHub imports)
 *   publishedAt / skipDependencyCheck / allowLegacy / forceScope: used by the old-registry import only
 * Returns { name, version, created, strippedFiles }.
 */
export async function publishFile(deps, options) {
    const { db, config, storage, tmp } = deps
    const { user, source, stagingKey = null, strip = false } = options
    let { filePath } = options
    let strippedFiles = []

    let checked
    try {
        checked = await checkPack(filePath, { defaultScope: user.handle, allowDisallowed: strip })
        if (strip && checked.disallowed.length) {
            strippedFiles = checked.disallowed
            const cleaned = await tmp.file(".bee_pack")
            await stripPack(filePath, cleaned, strippedFiles)
            filePath = cleaned
            checked = await checkPack(filePath, { defaultScope: user.handle })
        }
    } catch (err) {
        throw packErrorToApi(err)
    }
    const { manifest, beeId } = checked
    const size = (await stat(filePath)).size
    const sha256 = await hashFile(filePath)
    if (size > config.maxUploadBytes && !options.allowLegacy) {
        throw badRequest(
            `Packages can be at most ${Math.round(config.maxUploadBytes / 1048576)} MB.`,
            "too_large",
        )
    }
    if (options.sha256 && !strippedFiles.length && options.sha256 !== sha256) {
        throw badRequest(
            "The uploaded file doesn't match its checksum. Try publishing again.",
            "checksum_mismatch",
        )
    }

    // The old-registry import puts packages in their owner's scope, whatever the old author was
    const scope = options.forceScope ?? manifest.scope
    const { name, version } = manifest
    const fullName = formatName(scope, name)
    const dependencies = options.skipDependencyCheck
        ? manifest.dependencies
        : await resolveDependencies(db, manifest)
    const key = versionKey(scope, name, version)
    let uploaded = false

    try {
        const result = await db.tx(async (tx) => {
            const { rows } = await tx.query(
                "SELECT * FROM packages WHERE scope = $1 AND name = $2 FOR UPDATE",
                [scope, name],
            )
            let pkg = rows[0]
            let created = false

            if (pkg) {
                if (pkg.removed_at)
                    throw forbidden(`${fullName} was removed by an admin.`, "package_removed")
                const { rows: owner } = await tx.query(
                    "SELECT 1 FROM package_owners WHERE package_id = $1 AND user_id = $2",
                    [pkg.id, user.id],
                )
                if (!owner.length && user.role !== "admin") {
                    throw forbidden(`You're not an owner of ${fullName}.`, "not_owner")
                }
                if (pkg.bee_id.toUpperCase() !== beeId) {
                    throw conflict(
                        `${fullName} has the BEE2 ID ${pkg.bee_id}, but this file's info.txt says ${beeId}. Every version must keep the same ID.`,
                        "bee_id_mismatch",
                    )
                }
            } else {
                // New package: it goes in the publisher's own scope (admins may use any user's scope)
                let ownerId = user.id
                if (scope !== user.handle) {
                    const scopeUser =
                        user.role === "admin" ? await findUserByHandle(tx, scope) : null
                    if (!scopeUser) {
                        throw forbidden(
                            `You can only create packages under @${user.handle}, not @${scope}. Change "name" or "author" in bee-package.json.`,
                            "wrong_scope",
                        )
                    }
                    ownerId = scopeUser.id
                }
                const { rows: taken } = await tx.query(
                    "SELECT scope, name FROM packages WHERE upper(bee_id) = $1",
                    [beeId],
                )
                if (taken.length) {
                    throw conflict(
                        `The BEE2 ID ${beeId} is already used by ${formatName(taken[0].scope, taken[0].name)}. BEE2 can't load two packages with the same ID, so change "ID" in info.txt.`,
                        "bee_id_taken",
                    )
                }
                const { rows: inserted } = await tx.query(
                    `INSERT INTO packages (scope, name, bee_id, display_name, description)
                     VALUES ($1, $2, $3, $4, $5) RETURNING *`,
                    [
                        scope,
                        name,
                        beeId,
                        manifest.displayName || checked.info.name,
                        manifest.description || checked.info.description,
                    ],
                )
                pkg = inserted[0]
                created = true
                await tx.query(
                    "INSERT INTO package_owners (package_id, user_id, added_by) VALUES ($1, $2, $3)",
                    [pkg.id, ownerId, user.id],
                )
            }

            const { rows: existing } = await tx.query(
                "SELECT unpublished_at FROM versions WHERE package_id = $1 AND version = $2",
                [pkg.id, version],
            )
            if (existing.length) {
                throw conflict(
                    existing[0].unpublished_at
                        ? `${fullName}@${version} was unpublished, and version numbers can't be reused. Bump "version" in bee-package.json.`
                        : `${fullName}@${version} already exists. Bump "version" in bee-package.json.`,
                    "version_exists",
                )
            }

            // Store the file before the version row commits, so a version never exists without its file
            if (stagingKey) await storage.copy(stagingKey, key)
            else await storage.putFile(key, filePath)
            uploaded = true

            const { rows: others } = await tx.query(
                "SELECT version, yanked_at, unpublished_at FROM versions WHERE package_id = $1",
                [pkg.id],
            )
            await tx.query(
                `INSERT INTO versions (package_id, version, compatible_with, dependencies, manifest, sha256, size,
                                       storage_key, source, published_by, published_at)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, coalesce($11, now()))`,
                [
                    pkg.id,
                    version,
                    manifest.compatibleWith,
                    JSON.stringify(dependencies),
                    JSON.stringify(manifestForStorage({ ...manifest, fullName }, beeId)),
                    sha256,
                    size,
                    key,
                    JSON.stringify(source),
                    user.id,
                    options.publishedAt ?? null,
                ],
            )

            // Package title and description follow the newest version
            if (!created && latestVersion([...others, { version }]) === version) {
                await tx.query(
                    `UPDATE packages SET display_name = coalesce($2, display_name),
                            description = coalesce($3, description), updated_at = now() WHERE id = $1`,
                    [pkg.id, manifest.displayName, manifest.description],
                )
            } else {
                await tx.query("UPDATE packages SET updated_at = now() WHERE id = $1", [pkg.id])
            }
            return { name: fullName, version, created, beeId }
        })

        await audit(db, user.id, "version.publish", `${fullName}@${version}`, {
            source,
            sha256,
            size,
            strippedFiles,
        })
        return { ...result, strippedFiles, sha256, size }
    } catch (err) {
        if (uploaded) await storage.remove(key).catch(() => {})
        if (err instanceof ApiError) throw err
        if (err.code === "23505")
            throw conflict(`${fullName}@${version} was published at the same time by someone else.`)
        throw err
    }
}

function manifestForStorage(manifest, beeId) {
    return {
        name: manifest.fullName,
        version: manifest.version,
        display_name: manifest.displayName,
        description: manifest.description,
        compatibleWith: manifest.compatibleWith,
        dependencies: manifest.dependencies,
        beeId,
    }
}
