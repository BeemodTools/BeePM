import path from "node:path"
import { thumbnail } from "./images.js"
import { parseKeyValues } from "./infotxt.js"
import { CONTENT_KINDS } from "./kinds.js"
import { readPack, readPackFiles, readPackTexts } from "./pack.js"

/**
 * What a package defines that people look for (kinds.js): its items, styles, music, signage and
 * so on, read from info.txt, with items named from their editoritems.txt. Each has its
 * description, authors and icon (a small PNG, see images.js) when the package has them.
 */

const KIND_BY_TYPE = new Map(CONTENT_KINDS.map((k) => [k.type.toLowerCase(), k.kind]))
const MAX_OBJECTS = 5000
// BEE2's own packages can have a bigger info.txt than BeePM accepts for publishing
const MAX_INFO_BYTES = 16 * 1024 * 1024
const MAX_DESCRIPTION = 2000
const MAX_AUTHORS = 200
// Icons are shrunk as they're read; some packages have huge ones
const MAX_ICON_BYTES = 16 * 1024 * 1024
const IMAGE_TYPES = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".vtf": "image/vtf",
}
// BEE2's own items are named with Portal 2's translation keys: their palette tooltip reads better
const TRANSLATION_KEY = /^#?portal2_puzzleeditor/i

const isBlock = (pair) => Array.isArray(pair.value)
const text = (pairs, key) =>
    pairs.find((p) => p.key.toLowerCase() === key && typeof p.value === "string")?.value.trim() ||
    null
const block = (pairs, key) => pairs.find((p) => p.key.toLowerCase() === key && isBlock(p))?.value
const parse = (source) => {
    try {
        return parseKeyValues(source)
    } catch {
        return []
    }
}

// "EXIT DOOR" -> "Exit Door"; mixed case stays as it is
const titleCase = (value) =>
    value === value.toUpperCase()
        ? value
              .toLowerCase()
              .replace(/(^|[\s(-])(\p{L})/gu, (_, gap, letter) => gap + letter.toUpperCase())
        : value

/** A name for something that has none: "ITEM_LASER_RELAY" -> "Laser Relay". */
export function nameFromId(id) {
    const words = String(id)
        .replace(/^ITEM_/i, "")
        .split(/[_\s]+/)
        .filter(Boolean)
    return words.map((w) => w[0].toUpperCase() + w.slice(1).toLowerCase()).join(" ") || String(id)
}

/** A description: a string, or BEE2's block of lines ("" "a line"). */
function descriptionOf(pairs) {
    const found = pairs.find((p) => p.key.toLowerCase() === "description")
    if (!found) return null
    const value = isBlock(found)
        ? found.value
              .filter((p) => typeof p.value === "string")
              .map((p) => p.value)
              .join("\n")
        : found.value
    return (
        value
            .replace(/\n{3,}/g, "\n\n")
            .trim()
            .slice(0, MAX_DESCRIPTION) || null
    )
}

const authorsOf = (pairs) =>
    (text(pairs, "authors") ?? text(pairs, "author"))?.slice(0, MAX_AUTHORS) ?? null

/**
 * Where an image BEE2 refers to is in the package: its resources/BEE2/ folder (items' icons are
 * in .../items/), .png added when there's no extension ("PACKAGE:path" is looked for here too).
 * Null for BEE2's built-in images ("<black>") and formats BeePM doesn't show.
 */
function imagePath(value, folder = "") {
    if (!value || value.startsWith("<")) return null
    let file = value
        .replace(/^[^:/\\]+:/, "")
        .replace(/\\/g, "/")
        .replace(/^\/+/, "")
    if (!path.posix.extname(file)) file += ".png"
    if (!IMAGE_TYPES[path.posix.extname(file).toLowerCase()]) return null
    return `resources/BEE2/${folder}${file}`
}

/** An item's folder in the package (items/<folder>/), from its first style that names one. */
function itemFolder(pairs) {
    const styles = block(block(pairs, "version") ?? [], "styles") ?? []
    for (const style of styles) {
        const folder = isBlock(style) ? text(style.value, "folder") : style.value.trim()
        // "<BEE2_CLEAN>" means: the same as that style
        if (folder && !folder.startsWith("<")) {
            return folder.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "")
        }
    }
    return null
}

/** Signage has an icon per style: the first one. */
function signageIcon(pairs) {
    for (const style of block(pairs, "styles") ?? []) {
        const icon = isBlock(style) ? text(style.value, "icon") : null
        if (icon) return icon
    }
    return text(pairs, "icon")
}

/**
 * What info.txt lists: [{ kind, id, name, description, authors, iconPath, folder? }] in its order,
 * each kind and ID once. Items have no name or icon there; `folder` says where their files are.
 */
export function contentsFromInfo(infoText) {
    const objects = []
    const seen = new Set()
    for (const pair of parseKeyValues(infoText)) {
        const kind = isBlock(pair) ? KIND_BY_TYPE.get(pair.key.toLowerCase()) : null
        const id = kind ? text(pair.value, "id") : null
        if (!id || seen.has(`${kind}:${id.toUpperCase()}`)) continue
        seen.add(`${kind}:${id.toUpperCase()}`)
        const object = {
            kind,
            id,
            name: kind === "item" ? null : text(pair.value, "name"),
            description: descriptionOf(pair.value),
            authors: authorsOf(pair.value),
            iconPath: null,
        }
        if (kind === "item") object.folder = itemFolder(pair.value)
        else {
            object.iconPath = imagePath(
                kind === "signage" ? signageIcon(pair.value) : text(pair.value, "icon"),
            )
        }
        objects.push(object)
        if (objects.length >= MAX_OBJECTS) break
    }
    return objects
}

/**
 * What an item's editoritems.txt says: { names, image }. names: one per subtype (in order, each
 * once); BEE2's own items use their palette tooltip ("EXIT DOOR" -> "Exit Door"). image: the
 * first subtype's palette image, which BEE2 keeps in resources/BEE2/items/ without "palette/".
 */
export function itemEditor(editorText, id) {
    const items = parse(editorText).filter((p) => p.key.toLowerCase() === "item" && isBlock(p))
    const item =
        items.find((p) => text(p.value, "type")?.toUpperCase() === id.toUpperCase()) ?? items[0]
    const names = []
    let image = null
    for (const sub of block(item?.value ?? [], "editor") ?? []) {
        if (sub.key.toLowerCase() !== "subtype" || !isBlock(sub)) continue
        const name = text(sub.value, "name")
        const palette = block(sub.value, "palette") ?? []
        const tooltip = text(palette, "tooltip")
        const shown =
            name && !TRANSLATION_KEY.test(name) ? name : tooltip ? titleCase(tooltip) : null
        if (shown && !names.includes(shown)) names.push(shown)
        image ??= text(palette, "image")
    }
    return { names, image }
}

/**
 * Where an item's palette image can be (like BEE2 and BeePEE look for it): its PNG in
 * resources/BEE2/items/ ("palette/" left out), else the editor's own texture, a VTF.
 */
function paletteIcons(image) {
    if (!image) return []
    const file = image.replace(/\\/g, "/").replace(/^\/+/, "")
    const texture = `resources/materials/models/props_map_editor/${file.replace(/\.[a-z0-9]+$/i, "")}.vtf`
    return [imagePath(file.replace(/^palette\//i, ""), "items/"), texture].filter(Boolean)
}

/** An item's names from its editoritems.txt (see itemEditor). */
export const itemNames = (editorText, id) => itemEditor(editorText, id).names

/** What an item's properties.txt says: { icon (as BEE2 refers to it), description, authors }. */
export function itemProperties(propertiesText) {
    const pairs = block(parse(propertiesText), "properties") ?? []
    const icon = pairs.find((p) => p.key.toLowerCase() === "icon")
    return {
        icon: !icon
            ? null
            : isBlock(icon)
              ? (icon.value.find((p) => typeof p.value === "string")?.value ?? null)
              : icon.value,
        description: descriptionOf(pairs),
        authors: authorsOf(pairs),
    }
}

/**
 * What a .bee_pack defines that people look for: [{ kind, id, name, aliases, description,
 * authors, icon: { type, data } | null }] in info.txt's order. An item's aliases are its other
 * subtypes' names; anything without a name gets one from its ID. Throws a PackError for files
 * readPack refuses.
 */
export async function readPackContents(filePath) {
    const { infoText } = await readPack(filePath, { maxInfoBytes: MAX_INFO_BYTES })
    if (infoText == null) return []
    const objects = contentsFromInfo(infoText)

    // Items' files: items/<folder>/editoritems.txt and properties.txt, lowercase -> its items
    const itemFiles = new Map()
    const want = (file, object) =>
        itemFiles.set(file.toLowerCase(), [...(itemFiles.get(file.toLowerCase()) ?? []), object])
    for (const object of objects) {
        if (!object.folder) continue
        want(`items/${object.folder}/editoritems.txt`, object)
        want(`items/${object.folder}/properties.txt`, object)
    }
    if (itemFiles.size) {
        const texts = await readPackTexts(filePath, (name) => itemFiles.has(name.toLowerCase()))
        for (const [file, fileText] of texts) {
            for (const object of itemFiles.get(file.toLowerCase())) {
                if (/editoritems\.txt$/i.test(file)) {
                    const { names, image } = itemEditor(fileText, object.id)
                    ;[object.name = null, ...object.aliases] = names
                    object.paletteIcons = paletteIcons(image)
                } else {
                    const properties = itemProperties(fileText)
                    object.iconPath = imagePath(properties.icon, "items/")
                    object.description ??= properties.description
                    object.authors ??= properties.authors
                }
            }
        }
    }

    // An item's icon is in its properties.txt, else it's its palette image (like BEE2)
    const candidates = (o) => [o.iconPath, ...(o.paletteIcons ?? [])].filter(Boolean)
    const wanted = new Set(objects.flatMap((o) => candidates(o).map((p) => p.toLowerCase())))
    const images = new Map() // lowercase path -> its thumbnail
    if (wanted.size) {
        const found = await readPackFiles(filePath, (name) => wanted.has(name.toLowerCase()), {
            maxBytes: MAX_ICON_BYTES,
            transform: (name, data) => {
                try {
                    return thumbnail({
                        type: IMAGE_TYPES[path.posix.extname(name).toLowerCase()],
                        data,
                    })
                } catch {
                    return null // not an image BeePM can read: no icon
                }
            },
        })
        for (const [name, icon] of found) images.set(name.toLowerCase(), icon)
    }

    return objects.map((object) => {
        const { kind, id, name, aliases = [], description, authors } = object
        const iconPath = candidates(object).find((p) => images.has(p.toLowerCase()))
        return {
            kind,
            id,
            name: name || nameFromId(id),
            aliases,
            description,
            authors,
            icon: iconPath ? images.get(iconPath.toLowerCase()) : null,
        }
    })
}
