/**
 * What broke BEE2, from its log (client/bee2log.js). The logs here are shaped like real BEE2
 * 4.46 logs: a crash on a package that can't be parsed, and the "BEEmod Error" dialog.
 */
import assert from "node:assert/strict"
import { mkdir, utimes, writeFile } from "node:fs/promises"
import path from "node:path"
import { after, before, test } from "node:test"
import { bee2LogProblems, bee2RunEnd, readBee2Problems } from "../src/client/bee2log.js"
import { tempDir } from "./helpers.js"

let tmp
before(async () => {
    tmp = await tempDir()
})
after(() => tmp.cleanup())

// A crash: BEE2's warnings (AppError) and the error that stopped it, in an exception group
const CRASH = String.raw`[INFO] packages.parse_type(): Post-process ConfigGroup objects...
[ERROR] core.done_callback(): Trio exited with exception
  + Exception Group Traceback (most recent call last):
  |   File "ui_tk\core.py", line 137, in app_main
  | ExceptionGroup: Exceptions from Trio nursery (1 sub-exception)
  +-+---------------- 1 ----------------
      | ExceptionGroup: ErrorUI block raised (3 sub-exceptions)
      +-+---------------- 1 ----------------
        | transtoken.AppError: AppError: Potential package file has no info.txt: packages\Dogs_WIP_package.bee_pack
        +---------------- 2 ----------------
        | transtoken.AppError: AppError: TemplateBrush "temp_box" in package "ENDEREK-S_PACKAGES" no longer needs to be defined in info.txt.
        +---------------- 3 ----------------
                  | Traceback (most recent call last):
                  |   File "editoritems.py", line 1057, in parse_one
                  |   File "utils.py", line 374, in obj_id_optional
                  | ValueError: Invalid Item ID "VERSION". IDs cannot be any of the following: NAME, VERSION, ID, TYPE
                  +------------------------------------
              |
              | The above exception was the direct cause of the following exception:
              |
              | Traceback (most recent call last):
              |   File "packages\__init__.py", line 1286, in parse_object
              | ValueError: Error occured parsing TEMP23:VERSION item!
`

// The "BEEmod Error" dialog BEE2 closes after, and one it only warns with
const DIALOGS = `[ERROR] errors.__aexit__(): ErrorUI block failed.
 | title=BEEmod Error
 | desc=An error occurred when loading packages:
 | Duplicate package with id "ALEXUS_PACKAGE"!
 | If you just updated the mod, delete any old files in packages/.
 | Package 1: packages\\alexus-fixed.bee_pack
 | Package 2: packages\\Alexus.s_Items.bee_pack
 | Package "BROKEN_PACK" has an invalid prerequisite.
 |___

[ERROR] errors.__aexit__(): ErrorUI block failed.
 | title=BEEmod Error
 | desc=Loading packages was partially successful:
 | Package "TAG_MUSIC" could not be enabled - Aperture Tag is not installed.
 | Unknown object type "Item." with ID "CAMERA" in package "MARCUS"!
 |___
`

test("a crash names the package and its cause; BEE2's warnings don't count", () => {
    assert.deepEqual(bee2LogProblems(CRASH), [
        {
            packageId: "TEMP23",
            message:
                'Invalid Item ID "VERSION". IDs cannot be any of the following: NAME, VERSION, ID, TYPE',
        },
    ])
})

test('"An error occurred when loading packages" counts, duplicates and warnings don\'t', () => {
    assert.deepEqual(bee2LogProblems(DIALOGS), [
        { packageId: "BROKEN_PACK", message: 'Package "BROKEN_PACK" has an invalid prerequisite.' },
    ])
    assert.deepEqual(bee2LogProblems("[INFO] Everything loaded.\n"), [])

    // Several errors: BEE2 says so, and closes the same way
    const several = String.raw`[ERROR] errors.__aexit__(): ErrorUI block failed.
 | title=BEEmod Error
 | desc=Multiple errors occurred when loading packages:
 | Potential package file has no info.txt: packages\Dogs_WIP_package.bee_pack
 | Duplicate package with id "OLDAPERTUREPAINTINGS_83BC"!
 | Package "BROKEN_PACK" has an invalid prerequisite.
 |___
[DEBUG] core.done_callback(): Trio exited normally.
`
    assert.deepEqual(
        bee2LogProblems(several).map((p) => p.packageId),
        ["BROKEN_PACK"],
    )
})

test("the log is read from BEE2's logs folder; no log is no problem", async () => {
    const dir = path.join(tmp.dir, "BEE2")
    assert.deepEqual(await readBee2Problems(dir), [])
    await mkdir(path.join(dir, "logs"), { recursive: true })
    await writeFile(path.join(dir, "logs", "bee2.log"), CRASH.replace(/\n/g, "\r\n"))
    assert.deepEqual(
        (await readBee2Problems(dir)).map((p) => p.packageId),
        ["TEMP23"],
    )
})

test("each run has its own log: the one written to while it ran, and when it ended", async () => {
    const dir = path.join(tmp.dir, "BEE2-runs")
    const logs = path.join(dir, "logs")
    await mkdir(logs, { recursive: true })
    const at = (file, ms) => utimes(path.join(logs, file), new Date(ms), new Date(ms))
    const start = Date.now() - 60 * 60 * 1000
    // A run that crashed, still in bee2.log (left open, so the next run couldn't move it)...
    await writeFile(path.join(logs, "bee2.log"), CRASH)
    await at("bee2.log", start + 10_000)
    // ...a later one that closed after "An error occurred when loading packages"...
    await writeFile(
        path.join(logs, "bee2.1.log"),
        DIALOGS + "[DEBUG] core.done_callback(): Trio exited normally.\n",
    )
    await at("bee2.1.log", start + 70_000)
    // ...and one still running
    await writeFile(path.join(logs, "bee2.2.log"), "[INFO] packages.find_packages(): Reading...\n")
    await at("bee2.2.log", start + 130_000)

    const problems = async (since) =>
        (await readBee2Problems(dir, { since })).map((p) => p.packageId)
    assert.deepEqual(await problems(start), ["TEMP23"]) // the run that was running then
    assert.deepEqual(await problems(start + 60_000), ["BROKEN_PACK"])
    assert.deepEqual(await problems(undefined), []) // the latest: still running, no problems
    assert.deepEqual(await problems(start + 200_000), []) // nothing written since

    assert.equal(await bee2RunEnd(dir, start), start + 10_000)
    assert.equal(await bee2RunEnd(dir, start + 60_000), start + 70_000)
    assert.equal(await bee2RunEnd(dir, start + 120_000), null) // still running
    assert.equal(await bee2RunEnd(dir, start + 200_000), null) // no log of its own yet
    assert.equal(await bee2RunEnd(path.join(tmp.dir, "nowhere"), start), null)
})
