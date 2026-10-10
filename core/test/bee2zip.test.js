/**
 * Zips the way BEE2 sees them (client/bee2zip.js): what it can't load, and fixing a zip with
 * packages in folders inside it. The zips are made here, some then broken on purpose.
 */
import assert from "node:assert/strict"
import { createWriteStream } from "node:fs"
import { readFile, truncate, writeFile } from "node:fs/promises"
import path from "node:path"
import { pipeline } from "node:stream/promises"
import { after, before, test } from "node:test"
import yauzl from "yauzl"
import yazl from "yazl"
import { inspectBee2Zip, repackFolders } from "../src/client/bee2zip.js"
import { tempDir } from "./helpers.js"

let tmp
before(async () => {
    tmp = await tempDir()
})
after(() => tmp.cleanup())

const INFO = '"ID" "TEST_PACK"\n"Name" "Test"\n'

/** A zip of { name: text }; stored (not compressed) unless `compress`. */
async function zip(name, files, { compress = false } = {}) {
    const file = path.join(tmp.dir, name)
    const out = new yazl.ZipFile()
    const written = pipeline(out.outputStream, createWriteStream(file))
    for (const [entry, text] of Object.entries(files)) {
        out.addBuffer(Buffer.from(text), entry, { compress })
    }
    out.end()
    await written
    return file
}

/** Changes every central directory record of a zip with change(bytes, offset). */
async function patchCentral(file, change) {
    const bytes = await readFile(file)
    for (let i = bytes.indexOf("PK\x01\x02"); i >= 0; i = bytes.indexOf("PK\x01\x02", i + 4)) {
        change(bytes, i)
    }
    await writeFile(file, bytes)
}

const names = (file) =>
    new Promise((resolve, reject) =>
        yauzl.open(file, { lazyEntries: false }, (err, z) => {
            if (err) return reject(err)
            const all = []
            z.on("entry", (e) => all.push(e.fileName))
            z.on("end", () => resolve(all.sort()))
        }),
    )

test("a zip BEE2 can load: its info.txt; ones it can't, and why", async () => {
    const good = await zip("good.bee_pack", { "info.txt": INFO, "items/x.txt": "x" })
    assert.deepEqual(await inspectBee2Zip(good), { infoText: INFO, problem: null })

    const notZip = path.join(tmp.dir, "page.bee_pack")
    await writeFile(notZip, "<html>Not found</html>")
    assert.equal((await inspectBee2Zip(notZip)).problem.kind, "unreadable")

    // A download that didn't finish: the end of the zip, with its list of files, is missing
    const cut = await zip("cut.bee_pack", { "info.txt": INFO, "big.txt": "x".repeat(5000) })
    await truncate(cut, 3000)
    assert.equal((await inspectBee2Zip(cut)).problem.kind, "unreadable")

    const empty = await zip("empty.bee_pack", { "A.txt": "nothing" })
    assert.deepEqual((await inspectBee2Zip(empty)).problem, {
        kind: "no-info",
        message: "It has no info.txt, so it isn't a package",
    })

    // Marked encrypted (a real one's stored files are 12 bytes longer, so a compressed one here)
    const locked = await zip("locked.bee_pack", { "info.txt": INFO }, { compress: true })
    await patchCentral(locked, (bytes, at) =>
        bytes.writeUInt16LE(bytes.readUInt16LE(at + 8) | 1, at + 8),
    )
    assert.equal((await inspectBee2Zip(locked)).problem.kind, "encrypted")

    // Deflate64, which Windows uses for big zips and Python's zipfile can't read
    const deflate64 = await zip("big.bee_pack", { "info.txt": INFO })
    await patchCentral(deflate64, (bytes, at) => bytes.writeUInt16LE(9, at + 10))
    assert.deepEqual((await inspectBee2Zip(deflate64)).problem, {
        kind: "compression",
        message: "It's packed with Deflate64 compression, which BEE2 can't read",
    })
})

test("a damaged file inside is found by checking every file (deep)", async () => {
    const file = await zip("damaged.bee_pack", { "info.txt": INFO, "sound.txt": "a".repeat(200) })
    const bytes = await readFile(file)
    bytes.write("ZZZZ", bytes.indexOf("aaaa")) // a few bytes of its data changed
    await writeFile(file, bytes)
    assert.equal((await inspectBee2Zip(file)).problem, null) // its list of files is fine
    assert.deepEqual(await inspectBee2Zip(file, { deep: true }), {
        infoText: INFO, // it still says which package it is
        problem: { kind: "damaged", message: '"sound.txt" in it is damaged' },
    })
    // ...unless its info.txt is what's damaged
    const badInfo = await zip("bad-info.bee_pack", { "info.txt": INFO })
    const infoBytes = await readFile(badInfo)
    infoBytes.write("XX", infoBytes.indexOf('"ID"') + 1)
    await writeFile(badInfo, infoBytes)
    assert.deepEqual(await inspectBee2Zip(badInfo, { deep: true }), {
        infoText: null,
        problem: { kind: "damaged", message: '"info.txt" in it is damaged' },
    })
    // A deep check can be stopped
    await assert.rejects(inspectBee2Zip(file, { deep: true, signal: AbortSignal.abort() }), {
        name: "AbortError",
    })
    // Compressed ones are checked too
    const deflated = await zip(
        "fine.bee_pack",
        { "info.txt": INFO, "a.txt": "b".repeat(500) },
        {
            compress: true,
        },
    )
    assert.equal((await inspectBee2Zip(deflated, { deep: true })).problem, null)
})

test("packages in folders inside a zip are found, and fixed into packages of their own", async () => {
    const one = await zip("Dogs_WIP_package.bee_pack", {
        "READ ME PLEASE.txt": "hi",
        "Dog's WIP Package/info.txt": INFO,
        "Dog's WIP Package/items/dog/editoritems.txt": "item",
    })
    const { problem } = await inspectBee2Zip(one)
    assert.deepEqual(problem.folders, ["Dog's WIP Package"])
    assert.equal(problem.kind, "nested")
    assert.match(problem.message, /folder "Dog's WIP Package" inside it/)

    const [made] = await repackFolders(one, problem.folders, tmp.dir)
    assert.equal(path.basename(made), "Dog's WIP Package.bee_pack")
    assert.deepEqual(await names(made), ["info.txt", "items/dog/editoritems.txt"])
    assert.deepEqual(await inspectBee2Zip(made, { deep: true }), { infoText: INFO, problem: null })

    // Several packages zipped together (deeper ones count; a folder inside a package doesn't)
    const two = await zip("libs_standalone_packages.bee_pack", {
        "jail bars/info.txt": INFO,
        "jail bars/items/bars/info.txt": "not a package of its own",
        "more/player only button/info.txt": INFO,
    })
    const nested = (await inspectBee2Zip(two)).problem
    assert.deepEqual(nested.folders, ["jail bars", "more/player only button"])
    const made2 = await repackFolders(two, nested.folders, tmp.dir)
    assert.deepEqual(
        made2.map((f) => path.basename(f)),
        ["jail bars.bee_pack", "player only button.bee_pack"],
    )
    assert.deepEqual(await names(made2[0]), ["info.txt", "items/bars/info.txt"])
})
