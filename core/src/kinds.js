/**
 * What BeePM shows of a package's contents: the things BEE2 lets you pick, each one of BEE2's
 * object types in info.txt (`type`; BEE2 ignores its case). `label` names a list of them, `one`
 * a single one ("Item: Laser Relay"), `nouns` count them ("1 song", "3 songs").
 */
export const CONTENT_KINDS = [
    { kind: "item", type: "Item", label: "Items", one: "Item", nouns: ["item", "items"] },
    { kind: "style", type: "Style", label: "Styles", one: "Style", nouns: ["style", "styles"] },
    { kind: "music", type: "Music", label: "Music", one: "Music", nouns: ["song", "songs"] },
    { kind: "signage", type: "Signage", label: "Signage", one: "Sign", nouns: ["sign", "signs"] },
    {
        kind: "voice",
        type: "QuotePack",
        label: "Voice lines",
        one: "Voice",
        nouns: ["voice", "voices"],
    },
    {
        kind: "skybox",
        type: "SkyBox",
        label: "Skyboxes",
        one: "Skybox",
        nouns: ["skybox", "skyboxes"],
    },
    {
        kind: "elevator",
        type: "Elevator",
        label: "Elevators",
        one: "Elevator",
        nouns: ["elevator video", "elevator videos"],
    },
    {
        kind: "stylevar",
        type: "StyleVar",
        label: "Style options",
        one: "Style option",
        nouns: ["style option", "style options"],
    },
    {
        kind: "playermodel",
        type: "PlayerModel",
        label: "Player models",
        one: "Player model",
        nouns: ["player model", "player models"],
    },
]

const byKind = new Map(CONTENT_KINDS.map((k) => [k.kind, k]))

export const isContentKind = (kind) => byKind.has(kind)
export const contentLabel = (kind) => byKind.get(kind)?.label ?? kind
export const contentOne = (kind) => byKind.get(kind)?.one ?? kind

/** "1 song", "3 songs" */
export function contentCount(kind, count) {
    const [one, many] = byKind.get(kind)?.nouns ?? [kind, kind]
    return `${count} ${count === 1 ? one : many}`
}
