import { createLocalStorage } from "./local.js"
import { createS3Storage } from "./s3.js"

/**
 * Storage keys:
 *   uploads/<upload id>.bee_pack               staging, deleted after finalize
 *   packages/<scope>/<name>/<version>.bee_pack  published versions, never overwritten
 */
export function createStorage(config) {
    if (config.storage.kind === "s3") return createS3Storage(config.storage)
    return createLocalStorage({ dir: config.storage.dir, publicUrl: config.publicUrl })
}

export const uploadKey = (uploadId) => `uploads/${uploadId}.bee_pack`
export const versionKey = (scope, name, version) => `packages/${scope}/${name}/${version}.bee_pack`
