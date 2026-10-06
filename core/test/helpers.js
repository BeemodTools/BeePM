import { createWriteStream } from "node:fs"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { pipeline } from "node:stream/promises"
import yazl from "yazl"

/** A temporary folder that's deleted by the returned cleanup function. */
export async function tempDir() {
    const dir = await mkdtemp(path.join(os.tmpdir(), "beepm-test-"))
    return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) }
}

/** Writes a zip containing { "name": "text or Buffer" } and returns its path. */
export async function makeZip(filePath, files) {
    const zip = new yazl.ZipFile()
    const written = pipeline(zip.outputStream, createWriteStream(filePath))
    for (const [name, content] of Object.entries(files)) {
        zip.addBuffer(Buffer.isBuffer(content) ? content : Buffer.from(content), name)
    }
    zip.end()
    await written
    return filePath
}

export const infoTxt = (id, extra = "") => `"ID" "${id}"\n"Name" "Test package"\n${extra}`

/** A valid .bee_pack with the given manifest fields. */
export function packFiles({ id = "TEST_PACK", manifest = {}, extra = {} } = {}) {
    return {
        "info.txt": infoTxt(id),
        "bee-package.json": JSON.stringify({ name: "test-pack", version: "1.0.0", ...manifest }),
        "items/test/editoritems.txt": '"Item" {}',
        "resources/materials/test.vmt": '"LightmappedGeneric" {}',
        ...extra,
    }
}
