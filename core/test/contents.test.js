/**
 * What's in a package (contents.js): items, styles, music, signage... from info.txt, with items
 * named from their editoritems.txt.
 */
import assert from "node:assert/strict"
import path from "node:path"
import { after, before, test } from "node:test"
import { itemNames, nameFromId, readPackContents } from "../src/contents.js"
import { encodePng } from "../src/images.js"
import { contentLabel, isContentKind } from "../src/kinds.js"
import { makeZip, tempDir } from "./helpers.js"

let tmp
before(async () => {
    tmp = await tempDir()
})
after(() => tmp.cleanup())

const editorItem = (type, subtypes) =>
    `"Item"\n{\n"Type" "${type}"\n"Editor"\n{\n${subtypes
        .map(
            ([name, tooltip]) =>
                `"SubType"\n{\n"Name" "${name}"\n${tooltip ? `"Palette" { "Tooltip" "${tooltip}" }\n` : ""}}\n`,
        )
        .join("")}}\n}\n`

test("a package's items, music, signage, voice lines and the rest, by name", async () => {
    const file = await makeZip(path.join(tmp.dir, "contents.bee_pack"), {
        "info.txt": `"ID" "CONTENTS_TEST"
"Name" "Contents test"
"Item"
{
    "ID" "ITEM_LASER_RELAY"
    "Version" { "Styles" { "BEE2_CLEAN" "relay" } }
}
"item"
{
    "ID" "CUBES"
    "Version" { "Styles" { "BEE2_OVERGROWN" "<BEE2_CLEAN>" "BEE2_CLEAN" { "Folder" "Cubes/All" } } }
}
"Item"
{
    "ID" "ITEM_EXIT_DOOR"
    "Version" { "Styles" { "BEE2_CLEAN" "exit_door" } }
}
"Item"
{
    "ID" "ITEM_NO_FILES"
    "Version" { "Styles" { "BEE2_CLEAN" "missing" } }
}
"Music" { "ID" "CHILL" "Name" "Chill in Aperture" "Group" "Above Aperture" }
"Signage" { "ID" "PIT" "Name" "Bottomless Pit" }
"Signage" { "ID" "pit" "Name" "The same sign again" }
"QuotePack" { "ID" "GLADOS_CLEAN" "Name" "GLaDOS (Clean)" }
"SkyBox" { "ID" "FOGGY" "Name" "Foggy Skybox" }
"Style" { "ID" "MY_STYLE" "Name" "My Style" }
"Elevator" { "ID" "LOGO" "Name" "Aperture Logo" }
"StyleVar" { "ID" "DoorCameras" "Name" "Door Cameras" }
"PlayerModel" { "ID" "ATLAS" "name" "ATLAS" }
"BrushTemplate" { "ID" "NOT_SHOWN" "File" "x.vmf" }
"Overrides" { "Item" { "ID" "SOMEONE_ELSES" } }
`,
        "items/relay/editoritems.txt": editorItem("ITEM_LASER_RELAY", [["Laser Relay"]]),
        "items/cubes/all/EditorItems.txt": editorItem("CUBES", [
            ["Weighted Cube"],
            ["Companion Cube"],
            ["Weighted Cube"],
        ]),
        // BEE2's own items: Portal 2's translation keys, so the palette tooltip
        "items/exit_door/editoritems.txt": editorItem("ITEM_EXIT_DOOR", [
            ["PORTAL2_PuzzleEditor_Item_exit_door", "EXIT DOOR"],
        ]),
    })
    const contents = await readPackContents(file)
    assert.deepEqual(
        contents.map((o) => [o.kind, o.id, o.name, o.aliases]),
        [
            ["item", "ITEM_LASER_RELAY", "Laser Relay", []],
            ["item", "CUBES", "Weighted Cube", ["Companion Cube"]],
            ["item", "ITEM_EXIT_DOOR", "Exit Door", []],
            ["item", "ITEM_NO_FILES", "No Files", []], // named from its ID
            ["music", "CHILL", "Chill in Aperture", []],
            ["signage", "PIT", "Bottomless Pit", []],
            ["voice", "GLADOS_CLEAN", "GLaDOS (Clean)", []],
            ["skybox", "FOGGY", "Foggy Skybox", []],
            ["style", "MY_STYLE", "My Style", []],
            ["elevator", "LOGO", "Aperture Logo", []],
            ["stylevar", "DoorCameras", "Door Cameras", []],
            ["playermodel", "ATLAS", "ATLAS", []],
        ],
    )
})

test("descriptions, authors and icons, found where BEE2 looks for them", async () => {
    const png = encodePng(4, 4, Buffer.alloc(64, 200))
    const file = await makeZip(path.join(tmp.dir, "icons.bee_pack"), {
        "info.txt": `"ID" "ICONS_TEST"
"Item" { "ID" "WITH_PROPERTIES" "Description" "From info.txt." "Version" { "Styles" { "BEE2_CLEAN" "a" } } }
"Item" { "ID" "WITH_PALETTE" "Version" { "Styles" { "BEE2_CLEAN" "b" } } }
"Music" { "ID" "TUNE" "Name" "Tune" "Icon" "music/tune" "Authors" "Someone"
    "Description" { "" "Line one." "" "" "" "Line three." } }
"Signage" { "ID" "SIGN" "Name" "Sign" "Styles" { "BEE2_CLEAN" { "icon" "signs/sign.png" } } }
"SkyBox" { "ID" "SKY" "Name" "Sky" "Icon" "OTHER_PACKAGE:sky/elsewhere.png" }
`,
        "items/a/editoritems.txt": editorItem("WITH_PROPERTIES", [["A"]]),
        "items/a/properties.txt": `"Properties" { "Authors" "Ann" "Icon" { "0" "my/a.png" }
            "Description" { "" "From properties.txt." } }`,
        // No icon in properties.txt: the palette image, in resources/BEE2/items without "palette/"
        "items/b/editoritems.txt": `"Item" { "Type" "WITH_PALETTE" "Editor" { "SubType" {
            "Name" "B" "Palette" { "Image" "palette/my/b.png" } } } }`,
        "resources/BEE2/items/my/a.png": png,
        "resources/BEE2/items/my/b.png": png,
        "resources/BEE2/music/tune.png": png,
        "resources/BEE2/signs/sign.png": png,
    })
    const contents = await readPackContents(file)
    assert.deepEqual(
        contents.map((o) => [o.id, o.description, o.authors, o.icon?.type ?? null]),
        [
            ["WITH_PROPERTIES", "From info.txt.", "Ann", "image/png"],
            ["WITH_PALETTE", null, null, "image/png"],
            ["TUNE", "Line one.\n\nLine three.", "Someone", "image/png"],
            ["SIGN", null, null, "image/png"],
            ["SKY", null, null, null], // its icon is in another package
        ],
    )
    assert.deepEqual(contents[0].icon.data, png)
})

test("names: translation keys, tooltips, names made from IDs, and kinds", () => {
    assert.deepEqual(itemNames(editorItem("X", [["Real Name", "IGNORED"]]), "X"), ["Real Name"])
    assert.deepEqual(
        itemNames(editorItem("X", [["#PORTAL2_PuzzleEditor_Item_x", "LIGHT BRIDGE"]]), "X"),
        ["Light Bridge"],
    )
    assert.deepEqual(itemNames("not { valid", "X"), [])
    assert.equal(nameFromId("ITEM_LASER_RELAY"), "Laser Relay")
    assert.equal(nameFromId("BEE2_CLEAN"), "Bee2 Clean")
    assert.equal(isContentKind("music"), true)
    assert.equal(isContentKind("brushtemplate"), false)
    assert.equal(contentLabel("voice"), "Voice lines")
})
