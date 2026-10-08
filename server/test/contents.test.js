/**
 * What packages contain (services/contents.js): read when they're published, listed per version,
 * and searched; versions from before are read in the background.
 */
import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { startContentsReader } from "../src/services/contents.js"
import { api, login, makePack, publish, setup } from "./helpers.js"

let t
let carol
before(async () => {
    t = await setup({ PUBLISHES_PER_HOUR: "100", PUBLISHES_PER_DAY: "100" })
    carol = (await login(t, t.profile({ username: "carol" }), { handle: "carol" })).token
})
after(() => t.cleanup())

const INFO = `"ID" "CAROL_STUFF"
"Name" "Carol's Stuff"
"Item" { "ID" "CAROL_RELAY" "Version" { "Styles" { "BEE2_CLEAN" "relay" } } }
"Music" { "ID" "CAROL_TUNE" "Name" "Chill Tune" "Authors" "Carol" "Icon" "music/tune"
    "Description" "Something to test to." }
"QuotePack" { "ID" "CAROL_VOICE" "Name" "Cave Johnson (Carol)" }
`
const EDITOR = `"Item" { "Type" "CAROL_RELAY" "Editor" {
    "SubType" { "Name" "Laser Relay" }
    "SubType" { "Name" "Laser Catcher Relay" }
} }`
const PROPERTIES = `"Properties" { "Authors" "Carol, Dave" "Icon" { "0" "carol/relay.png" }
    "Description" { "" "Sends lasers on." "" "" "" "Two lines." } }`
// A 1x1 PNG
const PNG = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
    "base64",
)
const ICONS = "http://registry.test/v1/packages/carol/carol-stuff/versions/1.0.0/icons"
const CONTENTS = [
    {
        kind: "item",
        id: "CAROL_RELAY",
        name: "Laser Relay",
        aliases: ["Laser Catcher Relay"],
        description: "Sends lasers on.\n\nTwo lines.",
        authors: "Carol, Dave",
        icon: `${ICONS}/0`,
    },
    {
        kind: "music",
        id: "CAROL_TUNE",
        name: "Chill Tune",
        aliases: [],
        description: "Something to test to.",
        authors: "Carol",
        icon: `${ICONS}/1`,
    },
    {
        kind: "voice",
        id: "CAROL_VOICE",
        name: "Cave Johnson (Carol)",
        aliases: [],
        description: null,
        authors: null,
        icon: null,
    },
]
const contentsOf = (version) =>
    api(t, null, "GET", `/v1/packages/@carol/carol-stuff/versions/${version}/contents`)
const search = async (query) => (await api(t, null, "GET", `/v1/packages?${query}`)).body

test("what a package contains: listed per version, counted, and searched", async () => {
    const file = await makePack(t.dir, {
        info: INFO,
        manifest: { name: "carol-stuff", version: "1.0.0" },
        extra: {
            "items/relay/editoritems.txt": EDITOR,
            "items/relay/properties.txt": PROPERTIES,
            "resources/BEE2/items/carol/relay.png": PNG,
            "resources/BEE2/music/tune.png": PNG,
        },
    })
    assert.equal((await publish(t, carol, file)).status, 200)

    const listed = await contentsOf("1.0.0")
    assert.equal(listed.status, 200)
    assert.deepEqual(listed.body, { version: "1.0.0", read: true, error: null, contents: CONTENTS })
    assert.equal((await contentsOf("9.9.9")).status, 404)
    // The icons, kept for good (versions never change)
    const icon = await t.app.inject({ url: new URL(CONTENTS[0].icon).pathname })
    assert.equal(icon.statusCode, 200)
    assert.equal(icon.headers["content-type"], "image/png")
    assert.match(icon.headers["cache-control"], /immutable/)
    assert.deepEqual(icon.rawPayload, PNG)
    const none = await t.app.inject({ url: `${new URL(ICONS).pathname}/2` })
    assert.equal(none.statusCode, 404)
    const doc = await api(t, null, "GET", "/v1/packages/@carol/carol-stuff")
    assert.deepEqual(doc.body.contents, { item: 1, music: 1, voice: 1 })

    // By what's in it: an item's other names count, and the results say what matched
    const relay = await search("q=catcher")
    assert.deepEqual(
        relay.packages.map((p) => [p.name, p.found]),
        [["@carol/carol-stuff", { matches: [{ kind: "item", name: "Laser Relay" }], count: 1 }]],
    )
    // A kind alone: every package with that in it
    assert.deepEqual(
        (await search("kind=music")).packages.map((p) => [p.name, p.found.matches]),
        [["@carol/carol-stuff", [{ kind: "music", name: "Chill Tune" }]]],
    )
    // A kind and a search: that kind named like it, or a package named like it that has the kind
    assert.equal((await search("kind=voice&q=cave")).total, 1)
    assert.equal((await search("kind=music&q=relay")).total, 0)
    assert.equal((await search("kind=voice&q=carol")).total, 1)
    assert.equal((await search("kind=signage&q=carol")).total, 0)
    assert.equal((await api(t, null, "GET", "/v1/packages?kind=nope")).status, 400)
})

test("versions published before contents were read are read in the background", async () => {
    await t.db.query("DELETE FROM version_contents")
    await t.db.query("UPDATE versions SET contents_read_at = NULL")
    const unread = await contentsOf("1.0.0")
    assert.deepEqual([unread.body.read, unread.body.contents], [false, []])

    const logs = []
    const log = { info: (m) => logs.push(m), warn: (m) => logs.push(m) }
    const stop = startContentsReader({ db: t.db, storage: t.storage, log }, { delayMs: 0 })
    for (let i = 0; i < 200 && !logs.some((m) => m.startsWith("Read what")); i++) {
        await new Promise((resolve) => setTimeout(resolve, 25))
    }
    stop()
    assert.deepEqual(logs, ["Reading what 1 version(s) contain", "Read what 1 version(s) contain"])
    assert.deepEqual((await contentsOf("1.0.0")).body.contents, CONTENTS)
})
