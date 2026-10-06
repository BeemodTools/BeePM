import assert from "node:assert/strict"
import { test } from "node:test"
import { normalizeBeeId, parseName, parseSpec, suggestHandle } from "../src/names.js"

test("parseSpec handles scoped names, ranges, bare names and the old author@name form", () => {
    assert.deepEqual(parseSpec("@Areng14/ArengItems"), {
        scope: "areng14",
        name: "arengitems",
        range: null,
    })
    assert.deepEqual(parseSpec("@areng14/arengitems@^1.2.0"), {
        scope: "areng14",
        name: "arengitems",
        range: "^1.2.0",
    })
    assert.deepEqual(parseSpec("arengitems"), { scope: null, name: "arengitems", range: null })
    assert.deepEqual(parseSpec("arengitems@1.0.0"), {
        scope: null,
        name: "arengitems",
        range: "1.0.0",
    })
    assert.deepEqual(parseSpec("Areng14@wheatley-os"), {
        scope: "areng14",
        name: "wheatley-os",
        range: null,
    })
    assert.deepEqual(parseSpec("Areng14@wheatley-os@2.0.0"), {
        scope: "areng14",
        name: "wheatley-os",
        range: "2.0.0",
    })
    assert.deepEqual(parseSpec("@areng14/x@latest"), { scope: "areng14", name: "x", range: null })
})

test("parseSpec rejects invalid input", () => {
    for (const bad of ["", "@areng14", "@bad scope/x", "-bad", "@a/b@not a range!!", "a@b@c@d"]) {
        assert.throws(() => parseSpec(bad), undefined, bad)
    }
})

test("built-in @beemod names keep BEE2 IDs uppercase", () => {
    assert.deepEqual(parseName("@beemod/bee2_clean_style"), {
        scope: "beemod",
        name: "BEE2_CLEAN_STYLE",
    })
    assert.equal(parseName("@beemod/has-dash"), null)
    assert.equal(normalizeBeeId(" arengs_packages "), "ARENGS_PACKAGES")
    assert.equal(normalizeBeeId("bad id"), null)
})

test("suggestHandle turns provider usernames into valid handles", () => {
    assert.equal(suggestHandle("Areng14"), "areng14")
    assert.equal(suggestHandle("cool.user__99"), "cool-user-99")
    assert.equal(suggestHandle("___"), "")
    assert.equal(suggestHandle("a".repeat(60)).length, 39)
})
