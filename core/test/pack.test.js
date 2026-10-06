import assert from "node:assert/strict"
import { createWriteStream } from "node:fs"
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { pipeline } from "node:stream/promises"
import { after, before, test } from "node:test"
import yazl from "yazl"
import {
    checkPack,
    hashFile,
    PackError,
    packFolder,
    putFileInZip,
    readPack,
    stripPack,
} from "../src/pack.js"
import { makeZip, packFiles, tempDir } from "./helpers.js"

let tmp
before(async () => {
    tmp = await tempDir()
})
after(() => tmp.cleanup())

test("checkPack accepts a valid package", async () => {
    const file = await makeZip(path.join(tmp.dir, "ok.bee_pack"), packFiles())
    const result = await checkPack(file, { defaultScope: "tester" })
    assert.equal(result.beeId, "TEST_PACK")
    assert.equal(result.manifest.fullName, "@tester/test-pack")
    assert.equal(result.files.length, 4)
    assert.match(await hashFile(file), /^[0-9a-f]{64}$/)
})

test("checkPack lists every problem", async () => {
    const file = await makeZip(path.join(tmp.dir, "bad.bee_pack"), {
        "bee-package.json": JSON.stringify({ name: "x", version: "nope" }),
        "virus.exe": "MZ",
        README: "no extension",
    })
    await assert.rejects(checkPack(file), (err) => {
        assert.ok(err instanceof PackError)
        assert.equal(err.problems.length, 3) // no info.txt, bad version, disallowed files
        assert.deepEqual(err.disallowed.sort(), ["README", "virus.exe"])
        return true
    })
})

test("checkPack finds root files case-insensitively and rejects non-zips", async () => {
    const file = await makeZip(path.join(tmp.dir, "case.bee_pack"), {
        "INFO.TXT": '"ID" "CASE_TEST"',
        "Bee-Package.json": JSON.stringify({ name: "@me/case", version: "2.0.0" }),
    })
    assert.equal((await checkPack(file)).beeId, "CASE_TEST")

    const notZip = path.join(tmp.dir, "fake.bee_pack")
    await writeFile(notZip, "not a zip")
    await assert.rejects(readPack(notZip), /isn't a valid zip/)
})

test("checkPack rejects unsafe paths", async () => {
    // yazl refuses to write "..", so write the name bytes by hand: same length as "..\\x.txt"
    const file = await makeZip(path.join(tmp.dir, "unsafe.bee_pack"), {
        ...packFiles(),
        "ZZ/evil.txt": "x",
    })
    const { readFile } = await import("node:fs/promises")
    const bytes = await readFile(file)
    let index = bytes.indexOf("ZZ/evil.txt")
    while (index >= 0) {
        bytes.write("../evil.txt", index)
        index = bytes.indexOf("ZZ/evil.txt", index + 1)
    }
    await writeFile(file, bytes)
    await assert.rejects(checkPack(file), /couldn't be read/)
})

test("stripPack removes disallowed files so the package passes", async () => {
    const file = await makeZip(path.join(tmp.dir, "dirty.bee_pack"), {
        ...packFiles(),
        "notes.md": "# hi",
        "tools/run.bat": "echo hi",
    })
    const first = await checkPack(file, { defaultScope: "me", allowDisallowed: true })
    assert.deepEqual(first.disallowed.sort(), ["notes.md", "tools/run.bat"])

    const clean = path.join(tmp.dir, "clean.bee_pack")
    await stripPack(file, clean, first.disallowed)
    const second = await checkPack(clean, { defaultScope: "me" })
    assert.equal(second.files.length, 4)
    assert.equal(second.beeId, "TEST_PACK")
})

test("packFolder zips allowed files and skips the rest", async () => {
    const folder = path.join(tmp.dir, "folder-pack")
    for (const [name, content] of Object.entries({
        ...packFiles(),
        ".git/config": "x",
        "build.ps1": "x",
    })) {
        await mkdir(path.dirname(path.join(folder, name)), { recursive: true })
        await writeFile(path.join(folder, name), content)
    }
    const out = path.join(tmp.dir, "folder.bee_pack")
    const { added, skipped } = await packFolder(folder, out)
    assert.equal(added.length, 4)
    assert.deepEqual(skipped.sort(), [".git/", "build.ps1"])
    assert.equal((await checkPack(out, { defaultScope: "me" })).beeId, "TEST_PACK")
})

const LZMA_FIXTURE = new URL("./fixtures/lzma.bee_pack", import.meta.url)

test("LZMA-compressed packages (like BEE2's own) can be read and stripped", async () => {
    const pack = await readPack(LZMA_FIXTURE)
    assert.match(pack.infoText, /"ID" "LZMA_TEST"/)
    assert.equal(pack.manifestText, null)

    const copy = path.join(tmp.dir, "lzma-strip.bee_pack")
    await stripPack(LZMA_FIXTURE, copy, ["resources/materials/lzma.vmt"])
    const stripped = await readPack(copy)
    assert.deepEqual(stripped.files.sort(), ["info.txt", "items/lzma_test/editoritems.txt"])
    assert.match(stripped.infoText, /LZMA_TEST/)
})

test("putFileInZip adds bee-package.json without touching the other files", async () => {
    const copy = path.join(tmp.dir, "lzma-add.bee_pack")
    await copyFile(LZMA_FIXTURE, copy)
    const before = await hashFile(LZMA_FIXTURE)

    await putFileInZip(
        copy,
        "bee-package.json",
        JSON.stringify({ name: "lzma-test", version: "1.0.0" }),
    )
    const checked = await checkPack(copy, { defaultScope: "me" })
    assert.equal(checked.manifest.fullName, "@me/lzma-test")
    assert.equal(checked.beeId, "LZMA_TEST")

    // Replacing it keeps one copy, and the original entries are still readable
    await putFileInZip(
        copy,
        "Bee-Package.json",
        JSON.stringify({ name: "lzma-test", version: "1.0.1" }),
    )
    const again = await readPack(copy)
    assert.equal(again.files.filter((f) => f.toLowerCase() === "bee-package.json").length, 1)
    assert.equal(JSON.parse(again.manifestText).version, "1.0.1")
    assert.match(again.infoText, /LZMA_TEST/)
    assert.equal(await hashFile(LZMA_FIXTURE), before) // the fixture itself wasn't touched

    const notZip = path.join(tmp.dir, "not-a-zip.bee_pack")
    await writeFile(notZip, "nope")
    await assert.rejects(putFileInZip(notZip, "bee-package.json", "{}"), PackError)
})

/** Changes the bytes of the central directory record of entry `index`, then saves the zip. */
async function patchCentralRecord(file, index, patch) {
    const bytes = await readFile(file)
    const records = []
    for (let at = bytes.indexOf("PK\x01\x02"); at >= 0; at = bytes.indexOf("PK\x01\x02", at + 4)) {
        records.push(at)
    }
    patch(bytes, records[index], records)
    await writeFile(file, bytes)
    return file
}

/** Writes a zip whose entries are [name, content] pairs (so a name can appear twice). */
async function zipOfEntries(filePath, entries) {
    const zip = new yazl.ZipFile()
    const written = pipeline(zip.outputStream, createWriteStream(filePath))
    for (const [name, content] of entries) zip.addBuffer(Buffer.from(content), name)
    zip.end()
    await written
    return filePath
}

test("zip bombs and other unsafe zips are refused before anything is unpacked", async () => {
    const at = (name) => path.join(tmp.dir, name)

    // One file that shrinks far too much: 20 MB of zeros
    const ratio = await makeZip(at("ratio.bee_pack"), {
        ...packFiles(),
        "resources/sound/silence.wav": Buffer.alloc(20 * 1024 * 1024),
    })
    await assert.rejects(checkPack(ratio), /zip bomb: "resources\/sound\/silence\.wav" unpacks/)

    // Too much in total (the limit is lowered here to keep the test small)
    const big = await makeZip(at("big.bee_pack"), packFiles())
    await assert.rejects(readPack(big, { maxUnpackedBytes: 50 }), /unpacks to more than/)

    // Two entries sharing the same data (how the biggest zip bombs work)
    const overlap = await patchCentralRecord(
        await makeZip(at("overlap.bee_pack"), packFiles()),
        1,
        (bytes, record, records) =>
            bytes.writeUInt32LE(bytes.readUInt32LE(records[0] + 42), record + 42),
    )
    await assert.rejects(readPack(overlap), /zip bomb: its files overlap/)

    // The same file twice, or two info.txt files BEE2 might choose between differently
    const twice = await zipOfEntries(at("twice.bee_pack"), [
        ["items/a.txt", "1"],
        ["items/a.txt", "2"],
    ])
    await assert.rejects(readPack(twice), /"items\/a\.txt" is in it twice/)
    const twoInfos = await zipOfEntries(at("two-infos.bee_pack"), [
        ["info.txt", '"ID" "ONE"'],
        ["INFO.TXT", '"ID" "TWO"'],
    ])
    await assert.rejects(readPack(twoInfos), /more than one info\.txt/)

    // Names Windows can't use (BEE2 unpacks resources when exporting)
    for (const name of ["items/bad|name.txt", "resources/NUL.vmt", "items/a:b.txt"]) {
        const file = await makeZip(at("names.bee_pack"), { ...packFiles(), [name]: "x" })
        await assert.rejects(readPack(file), /isn't a file name Windows can use/, name)
    }

    // Encrypted files, symbolic links, and compression BeePM can't read
    const encrypted = await patchCentralRecord(
        await makeZip(at("encrypted.bee_pack"), packFiles()),
        0,
        (bytes, record) => bytes.writeUInt16LE(bytes.readUInt16LE(record + 8) | 1, record + 8),
    )
    await assert.rejects(readPack(encrypted), /is encrypted/)
    const symlink = await patchCentralRecord(
        await makeZip(at("symlink.bee_pack"), packFiles()),
        0,
        (bytes, record) => bytes.writeUInt32LE((0o120777 << 16) >>> 0, record + 38),
    )
    await assert.rejects(readPack(symlink), /is a symbolic link/)
    const bzip2 = await patchCentralRecord(
        await makeZip(at("bzip2.bee_pack"), packFiles()),
        0,
        (bytes, record) => bytes.writeUInt16LE(12, record + 10),
    )
    await assert.rejects(readPack(bzip2), /compression BeePM can't read/)

    // And an ordinary package still passes
    assert.equal(
        (await checkPack(await makeZip(at("fine.bee_pack"), packFiles()))).beeId,
        "TEST_PACK",
    )
})
