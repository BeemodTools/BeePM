import { normalizeBeeId } from "./names.js"

/**
 * A small reader for Valve KeyValues (the format of BEE2's info.txt):
 *   "key" "value"    key value    "block" { ... }    // comments
 * Returns a list of { key, value } where value is a string or a nested list.
 */
export function parseKeyValues(text) {
    const source = String(text).replace(/^﻿/, "")
    let pos = 0

    function skip() {
        for (;;) {
            while (pos < source.length && /\s/.test(source[pos])) pos++
            if (source.startsWith("//", pos)) {
                const end = source.indexOf("\n", pos)
                pos = end < 0 ? source.length : end + 1
            } else return
        }
    }

    function token() {
        skip()
        if (pos >= source.length) return null
        const ch = source[pos]
        if (ch === "{" || ch === "}") {
            pos++
            return { brace: ch }
        }
        if (ch === "[") {
            // Platform flags like [$X360]: ignored
            const end = source.indexOf("]", pos)
            pos = end < 0 ? source.length : end + 1
            return token()
        }
        if (ch === '"') {
            let value = ""
            pos++
            while (pos < source.length && source[pos] !== '"') {
                if (source[pos] === "\\" && pos + 1 < source.length) {
                    const next = source[pos + 1]
                    value += next === "n" ? "\n" : next === "t" ? "\t" : next
                    pos += 2
                } else {
                    value += source[pos++]
                }
            }
            if (pos >= source.length) throw new Error("Unterminated quoted string")
            pos++
            return { text: value }
        }
        const start = pos
        while (pos < source.length && !/[\s{}"]/.test(source[pos])) pos++
        return { text: source.slice(start, pos) }
    }

    function block(nested) {
        const pairs = []
        for (;;) {
            const key = token()
            if (key === null) {
                if (nested) throw new Error("Missing closing }")
                return pairs
            }
            if (key.brace === "}") {
                if (!nested) throw new Error("Unexpected }")
                return pairs
            }
            if (key.brace) throw new Error("Unexpected {")
            const value = token()
            if (value === null) throw new Error(`Missing value for "${key.text}"`)
            if (value.brace === "{") pairs.push({ key: key.text, value: block(true) })
            else if (value.brace) throw new Error(`Unexpected } after "${key.text}"`)
            else pairs.push({ key: key.text, value: value.text })
        }
    }

    return block(false)
}

const findValue = (pairs, key) =>
    pairs.find((p) => p.key.toLowerCase() === key && typeof p.value === "string")?.value ?? null

/**
 * Reads the parts of info.txt BeePM uses: the package ID (uppercased), name,
 * description, and the IDs listed under Prerequisites.
 * Throws if there's no valid top-level "ID".
 */
export function readInfoTxt(text) {
    let pairs
    try {
        pairs = parseKeyValues(text)
    } catch (err) {
        // Fall back to the line BeePM 1 looked for, so slightly malformed files still work
        const match = /^\s*"ID"\s+"([^"]+)"/im.exec(String(text).replace(/^﻿/, ""))
        const id = normalizeBeeId(match?.[1])
        if (!id) throw new Error(`info.txt couldn't be read (${err.message})`)
        return { id, name: null, description: null, prerequisites: [] }
    }

    const rawId = findValue(pairs, "id")
    if (!rawId) throw new Error('info.txt has no top-level "ID"')
    const id = normalizeBeeId(rawId)
    if (!id) {
        throw new Error(`info.txt ID "${rawId}" may only contain letters, digits and _`)
    }

    const prereqBlock = pairs.find(
        (p) => p.key.toLowerCase() === "prerequisites" && Array.isArray(p.value),
    )
    const prerequisites = (prereqBlock?.value || [])
        .filter((p) => typeof p.value === "string")
        .map((p) => normalizeBeeId(p.value))
        .filter(Boolean)

    return {
        id,
        name: findValue(pairs, "name"),
        description: findValue(pairs, "desc"),
        prerequisites,
    }
}
