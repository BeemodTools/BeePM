import assert from "node:assert/strict"
import { test } from "node:test"
import { bee2Semver, isCompatible, normalizeCompat } from "../src/compat.js"
import { readInfoTxt } from "../src/infotxt.js"
import { ManifestError, parseManifestText, validateManifest } from "../src/manifest.js"

test("normalizeCompat converts the old forms to semver ranges", () => {
    assert.equal(normalizeCompat(">=2.4.41"), ">=2.4.41")
    assert.equal(normalizeCompat(">=2.4.41 <2.4.46"), ">=2.4.41 <2.4.46")
    assert.equal(normalizeCompat(">=2.4.40,<2.5"), ">=2.4.40 <2.5")
    assert.equal(normalizeCompat("~=2.4.40"), "~2.4.40")
    assert.equal(normalizeCompat("==2.4.*"), "=2.4.*")
    assert.equal(normalizeCompat(">=2.4.46.1"), ">=2.4.46")
    assert.equal(normalizeCompat(["2.4.45", "v2.4.46.0", "2.4.46"]), "2.4.45 || 2.4.46")
    assert.equal(normalizeCompat("*"), null)
    assert.equal(normalizeCompat(undefined), null)
    assert.throws(() => normalizeCompat("whenever"))
    assert.throws(() => normalizeCompat(["2.4"]))
})

test("isCompatible compares against the first three parts of the BEE2 version", () => {
    assert.equal(bee2Semver("v2.4.46.1"), "2.4.46")
    assert.equal(isCompatible(">=2.4.41 <2.4.46", "2.4.45.2"), true)
    assert.equal(isCompatible(">=2.4.41 <2.4.46", "2.4.46.0"), false)
    assert.equal(isCompatible(null, "2.4.46"), true)
    assert.equal(isCompatible(">=9.0.0", "not a version"), true)
})

test("readInfoTxt reads the top-level ID, not one nested in a block", () => {
    const info = readInfoTxt(`﻿// BEE2 package
"Name" "Areng's Items"
"Desc" "Custom items"
"Prerequisites"
    {
    "Package" "BEE2_CLEAN_STYLE"
    "Package" "valve_test_elem"
    }
"Item"
    {
    "ID" "NOT_THIS_ONE"
    }
ID arengs_packages
`)
    assert.equal(info.id, "ARENGS_PACKAGES")
    assert.equal(info.name, "Areng's Items")
    assert.deepEqual(info.prerequisites, ["BEE2_CLEAN_STYLE", "VALVE_TEST_ELEM"])
})

test("readInfoTxt falls back to the old regex for malformed files and rejects bad IDs", () => {
    assert.equal(readInfoTxt('"ID" "OK_ID"\n"Broken" {').id, "OK_ID")
    assert.throws(() => readInfoTxt('"Name" "No ID here"'), /no top-level "ID"/)
    assert.throws(() => readInfoTxt('"ID" "has spaces"'), /may only contain/)
})

// Checking these takes time that grows with the square of their length: one huge value in a
// publish request could stall the registry, so they're refused (or read in one pass)
test("huge version ranges, dependency lists and broken info.txt files don't take long", () => {
    const started = Date.now()
    assert.throws(() => normalizeCompat(`>=2.4.40${" ".repeat(1_000_000)}x`), /longer than 200/)
    assert.throws(() => normalizeCompat(Array(51).fill("2.4.46")), /more than 50/)
    const problems = (manifest) => {
        try {
            validateManifest({ name: "@a/p", version: "1.0.0", ...manifest })
            return []
        } catch (err) {
            return err.problems
        }
    }
    assert.ok(problems({ compatibleWith: " ,".repeat(500_000) }).some((p) => /longer/.test(p)))
    const many = Object.fromEntries(Array.from({ length: 101 }, (_, i) => [`@a/dep${i}`, "*"]))
    assert.ok(problems({ dependencies: many }).some((p) => /more than 100/.test(p)))
    const long = { "@a/b": `>=1.0.0${" ".repeat(1000)}` }
    assert.ok(problems({ dependencies: long }).some((p) => /invalid version range/.test(p)))
    // A malformed info.txt (a stray "}") that's mostly blank lines: the fallback still reads it
    assert.equal(readInfoTxt(`${"\n".repeat(1_000_000)}"ID" "SLOW"\n}`).id, "SLOW")
    assert.ok(Date.now() - started < 2000, `took ${Date.now() - started} ms`)
})

test("validateManifest normalizes names, scope, compat and dependencies", () => {
    const m = validateManifest(
        {
            name: "ArengItems",
            author: "Areng14",
            version: "1.2.0",
            display_name: "Areng's Items",
            compatibleWith: ">=2.4.40,<2.5",
            dependencies: {
                "@beemod/BEE2_CLEAN_STYLE": "*",
                "@PieCreeper12/WIDE_LIGHT_STRIP": "",
                "@axolabs/hybrid-style": "^1.0.0",
            },
        },
        { defaultScope: "someoneelse" },
    )
    assert.equal(m.fullName, "@areng14/arengitems")
    assert.equal(m.compatibleWith, ">=2.4.40 <2.5")
    assert.deepEqual(m.dependencies, {
        "@beemod/BEE2_CLEAN_STYLE": "*",
        "@piecreeper12/wide_light_strip": "*",
        "@axolabs/hybrid-style": "^1.0.0",
    })
    assert.deepEqual(m.legacyDependencyIds, {
        "@piecreeper12/wide_light_strip": "WIDE_LIGHT_STRIP",
    })

    assert.equal(
        validateManifest({ name: "x", version: "1.0.0" }, { defaultScope: "me" }).fullName,
        "@me/x",
    )
    assert.equal(validateManifest({ name: "@Me/X", version: "1.0.0" }).fullName, "@me/x")
})

test("validateManifest reports every problem at once", () => {
    try {
        validateManifest({
            name: "bad name!",
            version: "1.0",
            author: "@@",
            compatibleWith: "soon",
            dependencies: { "not-scoped": "*" },
        })
        assert.fail("should throw")
    } catch (err) {
        assert.ok(err instanceof ManifestError)
        assert.equal(err.problems.length, 5)
    }
    assert.throws(
        () => validateManifest({ name: "@a/x", author: "b", version: "1.0.0" }),
        /doesn't match/,
    )
    assert.throws(() => validateManifest({ name: "x", version: "1.0.0+build" }), /semantic version/)
    assert.throws(() => validateManifest({ name: "@beemod/X", version: "1.0.0" }), /reserved/)
    assert.throws(
        () => validateManifest({ name: "@a/x", version: "1.0.0", dependencies: { "@a/x": "*" } }),
        /itself/,
    )
    assert.throws(() => parseManifestText("{nope"), /valid JSON/)
    assert.equal(parseManifestText('﻿{"a":1}').a, 1)
})
