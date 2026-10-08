/**
 * A stand-in for window.beepm (backend/preload.cjs) when the UI runs in a normal browser, e.g.
 * the Vite dev server. It answers every call with sample data and simulates logins, downloads and
 * uploads, so nothing is installed, published or opened for real.
 *
 * URL options: ?loggedout starts logged out, ?admin makes the sample user an admin, ?nobee2:
 * BeePM doesn't know where BEE2 is, ?bee2open: BEE2 is running, ?clean: the BEE2 check finds
 * nothing (no duplicates, none of the user's packages on BeePM), ?appupdate: a BeePM update is
 * downloaded.
 */
import { isCompatible } from "@beepm/core/compat"
import semver from "semver"

const params = new URLSearchParams(window.location.search)
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const rid = () => Math.random().toString(36).slice(2, 12)
const ago = (hours) => new Date(Date.now() - hours * 3600 * 1000).toISOString()
const days = (n) => ago(n * 24)
const ok = (data = {}) => ({ ok: true, ...data })
const fail = (error, extra = {}) => ({ ok: false, error, ...extra })
const clone = (value) => JSON.parse(JSON.stringify(value))

const BEE2_DIR = "C:\\Users\\you\\Documents\\BEE2_4.46.0_win"
const PACKAGES_DIR = `${BEE2_DIR}\\packages\\beepm`
const USERS = ["areng14", "portalfan", "oldtimer", "carl", "mel"]

function version(v, extra = {}) {
    return {
        version: v,
        compatibleWith: ">=2.4.41",
        dependencies: {},
        sha256: "5f".repeat(32),
        size: 2_400_000,
        publishedAt: days(30),
        publishedBy: "areng14",
        yanked: false,
        yankReason: null,
        deprecated: null,
        downloads: 100,
        source: { type: "upload" },
        ...extra,
    }
}

/** Recomputes what the registry derives: latest, downloads, updatedAt. */
function refresh(doc) {
    const usable = Object.values(doc.versions)
        .filter((v) => !v.yanked)
        .map((v) => v.version)
    const stable = usable.filter((v) => !semver.prerelease(v))
    doc.latest = semver.rsort([...(stable.length ? stable : usable)])[0] ?? null
    doc.downloads = Object.values(doc.versions).reduce((sum, v) => sum + v.downloads, 0)
    doc.updatedAt =
        Object.values(doc.versions)
            .map((v) => v.publishedAt)
            .sort()
            .at(-1) ?? doc.createdAt
    return doc
}

function samplePackages() {
    const docs = [
        {
            name: "@areng14/arengitems",
            displayName: "Areng's Items",
            beeId: "ARENGS_PACKAGES",
            description: "New test elements: laser relays, timed buttons and a few new cube types.",
            owners: ["areng14"],
            createdAt: days(400),
            versions: {
                "1.0.0": version("1.0.0", { publishedAt: days(300), downloads: 820 }),
                "1.1.0": version("1.1.0", {
                    publishedAt: days(90),
                    downloads: 640,
                    dependencies: { "@beemod/BEE2_CLEAN_STYLE": "*" },
                }),
                "1.2.0": version("1.2.0", {
                    publishedAt: ago(20),
                    downloads: 72,
                    compatibleWith: ">=2.4.44",
                    dependencies: { "@beemod/BEE2_CLEAN_STYLE": "*" },
                }),
            },
        },
        {
            name: "@portalfan/gel-pack",
            displayName: "Gel Pack",
            beeId: "GEL_PACK",
            description:
                "Extra gels and gel dispensers. Uses Areng's Items for the dispensers and Mel Sounds for effects.",
            owners: ["portalfan"],
            createdAt: days(70),
            versions: {
                "0.9.0": version("0.9.0", {
                    publishedBy: "portalfan",
                    publishedAt: days(60),
                    size: 5_800_000,
                }),
                "1.0.0": version("1.0.0", {
                    publishedBy: "portalfan",
                    publishedAt: days(12),
                    size: 6_100_000,
                    compatibleWith: ">=2.4.44",
                    downloads: 310,
                    dependencies: { "@areng14/arengitems": "^1.0.0", "@mel/mel-sounds": "^1.0.0" },
                }),
            },
        },
        {
            name: "@oldtimer/legacy-style",
            displayName: "Legacy Style",
            beeId: "LEGACY_STYLE",
            description: "The 2014 look, for BEE2 versions before 2.4.40.",
            deprecated: "Use @portalfan/gel-pack instead",
            owners: ["oldtimer"],
            createdAt: days(950),
            versions: {
                "2.0.0": version("2.0.0", {
                    compatibleWith: "<2.4.40",
                    publishedBy: "oldtimer",
                    publishedAt: days(900),
                    downloads: 1200,
                }),
            },
        },
        {
            name: "@carl/catapult-plus",
            displayName: "Catapult+",
            beeId: "CATAPULT_PLUS",
            description: "Faith plates with adjustable arcs and a trajectory preview.",
            owners: ["carl", "areng14"],
            createdAt: days(45),
            versions: {
                "2.0.0": version("2.0.0", {
                    compatibleWith: null,
                    publishedBy: "carl",
                    publishedAt: days(40),
                    downloads: 290,
                }),
                "2.1.0": version("2.1.0", {
                    compatibleWith: null,
                    publishedBy: "carl",
                    publishedAt: days(5),
                    yanked: true,
                    yankReason: "Breaks saved puzzles",
                    downloads: 12,
                }),
            },
        },
        {
            name: "@mel/mel-sounds",
            displayName: "Mel Sounds",
            beeId: "MEL_SOUNDS",
            description: "Music and sound effects in the style of Portal Stories: Mel.",
            owners: ["mel"],
            createdAt: days(160),
            versions: {
                "1.0.0": version("1.0.0", {
                    compatibleWith: ">=2.4.43",
                    publishedBy: "mel",
                    publishedAt: days(150),
                    size: 48_000_000,
                    downloads: 2030,
                }),
            },
        },
    ]
    return new Map(
        docs.map((doc) => [
            doc.name,
            refresh({ scope: doc.name.slice(1, doc.name.indexOf("/")), deprecated: null, ...doc }),
        ]),
    )
}

/** A copy of a package in BEE2's packages folder, changed `ago` days ago. */
const copyOf = (file, name, ago) => ({
    path: `${BEE2_DIR}\\packages\\${file}`,
    file,
    name,
    modified: days(ago),
    managed: false,
})

/** The BEE2 check: a package there twice, two packages with the same items, one on BeePM. */
function sampleCheck() {
    return {
        duplicates: {
            packages: [
                {
                    id: "PORTAL_PROPS",
                    name: "Portal Props",
                    copies: [
                        copyOf("portal-props-v2.bee_pack", "Portal Props", 3),
                        copyOf("Old\\portal-props.bee_pack", "Portal Props", 120),
                    ],
                },
            ],
            items: [
                {
                    items: ["ITEM_SIGN_ARROW", "ITEM_SIGN_EXIT"],
                    packages: [
                        {
                            id: "SIGNAGE_PLUS",
                            name: "Signage Plus",
                            copies: [copyOf("signage_plus.bee_pack", "Signage Plus", 10)],
                        },
                        {
                            id: "OLD_SIGNAGE",
                            name: "Old Signage",
                            copies: [copyOf("old_signage.zip", "Old Signage", 400)],
                        },
                    ],
                },
            ],
        },
        onBeepm: [
            { id: "MEL_SOUNDS", name: "Mel Sounds", file: "mel.zip", package: "@mel/mel-sounds" },
        ],
    }
}

/** A small picture without fetching anything: a colored square with a letter. */
const sampleAvatar = (color, letter) =>
    `data:image/svg+xml,${encodeURIComponent(
        `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40"><rect width="40" height="40" fill="${color}"/><text x="20" y="27" font-size="20" font-family="sans-serif" text-anchor="middle" fill="#fff">${letter}</text></svg>`,
    )}`
const AVATARS = { discord: sampleAvatar("#5865F2", "D"), github: sampleAvatar("#24292f", "G") }

const state = {
    loggedIn: !params.has("loggedout"),
    // ?bee2open: BEE2 is running, so setup/hook/unhook "close" it
    bee2Running: params.has("bee2open"),
    user: {
        handle: "areng14",
        displayName: "Areng",
        avatarUrl: AVATARS.github,
        role: params.has("admin") ? "admin" : "user",
        createdAt: days(500),
    },
    avatarSource: "github",
    identities: [
        {
            provider: "github",
            username: "Areng14",
            avatarUrl: AVATARS.github,
            linkedAt: days(500),
            lastLoginAt: days(1),
        },
    ],
    bee2: { dir: params.has("nobee2") ? null : BEE2_DIR, version: "2.4.46.1" },
    docs: samplePackages(),
    installed: {
        "@areng14/arengitems": {
            version: "1.1.0",
            range: "*",
            explicit: true,
            file: "areng14@arengitems.bee_pack",
            sha256: "5f".repeat(32),
            beeId: "ARENGS_PACKAGES",
            dependencies: { "@beemod/BEE2_CLEAN_STYLE": "*" },
            compatibleWith: ">=2.4.41",
            installedAt: days(30),
        },
    },
    appSettings: {
        background: true,
        ignoredUpdates: ["@mel/mel-sounds"],
        keepOwn: [],
        ignoredBee2: [],
    },
    // What the BEE2 check finds in BEE2's packages folder
    check: params.has("clean")
        ? { duplicates: { packages: [], items: [] }, onBeepm: [] }
        : sampleCheck(),
    plans: new Map(),
    prepared: new Map(),
    // package path -> its bee-package.json (folders start without one)
    manifests: new Map(
        params.has("barepack")
            ? []
            : [
                  [
                      "C:\\Users\\you\\Downloads\\cool-items.bee_pack",
                      {
                          name: "@areng14/cool-items",
                          version: "1.0.0",
                          display_name: "Cool Items",
                          description: "Sample package from the dev bridge.",
                          compatibleWith: ">=2.4.44",
                          dependencies: { "@beemod/BEE2_CLEAN_STYLE": "*" },
                      },
                  ],
              ],
    ),
    flow: null,
    // package -> automatic GitHub releases
    watches: new Map([
        [
            "@areng14/arengitems",
            {
                repo: "Areng14/ArengItems",
                asset: "items.bee_pack",
                release: "v1.2.0",
                checkedAt: new Date().toISOString(),
                error: null,
                by: "areng14",
            },
        ],
    ]),
}

// ---------- events ----------

const listeners = new Map()
function emit(event, payload) {
    for (const callback of listeners.get(event) ?? []) callback(payload)
}

async function simulate(total, steps, delay, report) {
    for (let i = 0; i <= steps; i++) {
        report(Math.round((total * i) / steps))
        await sleep(delay)
    }
}

// ---------- helpers ----------

// What the sample packages' latest versions contain (the registry reads it from their files):
// [kind, name, other names]
const SAMPLE_CONTENTS = {
    "@areng14/arengitems": [
        [
            "item",
            "Laser Relay",
            ["Angled Laser Relay"],
            "Passes a laser on to the next relay. Use **Angled** for corners.\n\n* Works with any laser\n* Can be turned off",
        ],
        ["item", "Timed Button", [], "A floor button that stays pressed for a while."],
        ["item", "Portal Spawner", [], "Spawns a second pair of portals."],
        ["item", "Bullseye"],
        ["item", "Ascension Cube", ["Ascension Sphere"], "A cube that floats up when dropped."],
        ["item", "Better Dropper"],
        ["item", "Bullet Detector", [], "Activates when a turret shoots it."],
        ["signage", "Laser Hazard"],
        ["signage", "Cube Drop"],
    ],
    "@portalfan/gel-pack": [
        ["item", "Gel Dispenser"],
        ["item", "Gel Pipe"],
        ["item", "Gel Drip"],
    ],
    "@oldtimer/legacy-style": [
        ["style", "Legacy (2014)"],
        ["skybox", "Old Foggy Sky"],
        ["elevator", "Old Aperture Logo"],
        ["stylevar", "Rusty Panels"],
    ],
    "@carl/catapult-plus": [
        ["item", "Adjustable Faith Plate"],
        ["item", "Trajectory Preview Plate"],
    ],
    "@mel/mel-sounds": [
        ["music", "Old Aperture Ambience"],
        ["music", "Sunset Lift"],
        ["music", "Lab Rat Waltz"],
        ["voice", "Virgil"],
    ],
}
// A stand-in icon: a colored square with the name's initials (no icon for style options)
const sampleIcon = (kind, name, index) => {
    if (kind === "stylevar") return null
    const initials = name
        .split(/\s+/)
        .map((word) => word[0])
        .join("")
        .slice(0, 2)
    const hue = (index * 47 + kind.length * 60) % 360
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" fill="hsl(${hue},40%,32%)"/><text x="32" y="41" font-family="Arial" font-size="24" font-weight="700" fill="#fff" text-anchor="middle">${initials}</text></svg>`
    return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`
}
const contentsOf = (name) =>
    (SAMPLE_CONTENTS[name] ?? []).map(
        ([kind, objectName, aliases = [], description = null], index) => ({
            kind,
            id: `${kind.toUpperCase()}_${index}`,
            name: objectName,
            aliases,
            description,
            authors: name.split("/")[0].slice(1),
            icon: sampleIcon(kind, objectName, index),
        }),
    )
const countsOf = (name) => {
    const counts = {}
    for (const { kind } of contentsOf(name)) counts[kind] = (counts[kind] ?? 0) + 1
    return counts
}

const summary = (doc) => ({
    name: doc.name,
    scope: doc.scope,
    displayName: doc.displayName,
    description: doc.description,
    beeId: doc.beeId,
    latest: doc.latest,
    compatibleWith: doc.versions[doc.latest]?.compatibleWith ?? null,
    deprecated: doc.deprecated,
    updatedAt: doc.updatedAt,
    downloads: doc.downloads,
    contents: countsOf(doc.name),
    removed: doc.removed,
})

const isAdmin = () => state.loggedIn && state.user.role === "admin"
const canManage = (doc) => state.loggedIn && (isAdmin() || doc.owners.includes(state.user.handle))

function managed(name) {
    const doc = state.docs.get(name)
    if (!doc)
        return { error: fail(`Package ${name} doesn't exist.`, { code: "not_found", status: 404 }) }
    if (!state.loggedIn)
        return { error: fail("You need to log in first.", { code: "unauthorized", status: 401 }) }
    if (!canManage(doc))
        return {
            error: fail(`You're not an owner of ${name}.`, { code: "not_owner", status: 403 }),
        }
    return { doc }
}

function parseSpec(spec) {
    const match = /^(@[^/@\s]+\/[^/@\s]+)(?:@(.+))?$/.exec(spec.trim())
    if (!match) throw new Error(`"${spec}" isn't a valid @scope/name.`)
    return {
        name: match[1].toLowerCase(),
        range: match[2] && match[2] !== "latest" ? match[2] : null,
    }
}

/** A simplified version of core's planInstall, good enough for previews. */
function planFor(specs, { update = false, force = false } = {}) {
    const bee2Version = state.bee2?.version ?? null
    const warnings = []
    const steps = []
    const markExplicit = []
    const seen = new Set()

    function visit(name, range, explicit, requested) {
        if (name.startsWith("@beemod/") || seen.has(name)) return
        seen.add(name)
        const doc = state.docs.get(name)
        if (!doc || doc.removed)
            throw new Error(`${name} isn't in the registry (it may have been removed).`)
        const current = state.installed[name]
        if (current && requested && !range && !update && !force) {
            warnings.push(`${name}@${current.version} is already installed.`)
            if (!current.explicit) markExplicit.push(name)
            return
        }
        const wanted = range ?? current?.range ?? "*"
        let to
        if (current && !requested && !update && semver.satisfies(current.version, wanted)) {
            to = current.version
        } else {
            const pinned = semver.valid(wanted)
            const usable = Object.values(doc.versions)
                .filter(
                    (v) =>
                        (!v.yanked || pinned === v.version) &&
                        isCompatible(v.compatibleWith, bee2Version),
                )
                .map((v) => v.version)
            to = semver.maxSatisfying(usable, wanted)
            if (!to) {
                throw new Error(
                    Object.values(doc.versions).some((v) => semver.satisfies(v.version, wanted))
                        ? `${name} has no version for your BEE2 version (${bee2Version}).`
                        : `No version of ${name} matches ${wanted}.`,
                )
            }
        }
        const info = doc.versions[to]
        for (const [dep, depRange] of Object.entries(info.dependencies))
            visit(dep, depRange, false, false)
        if (current?.version === to && !force) return
        if (info.deprecated || doc.deprecated)
            warnings.push(`${name} is deprecated: ${info.deprecated || doc.deprecated}`)
        steps.push({
            name,
            from: current?.version ?? null,
            to,
            change: !current
                ? "install"
                : semver.gt(to, current.version)
                  ? "upgrade"
                  : semver.lt(to, current.version)
                    ? "downgrade"
                    : "reinstall",
            range: range ?? current?.range ?? "*",
            explicit: explicit || Boolean(current?.explicit),
            sha256: info.sha256,
            size: info.size,
            beeId: doc.beeId,
            displayName: doc.displayName,
            dependencies: info.dependencies,
            compatibleWith: info.compatibleWith,
        })
    }

    if (specs.length) {
        for (const spec of specs) {
            const { name, range } = parseSpec(spec)
            visit(name, range, true, true)
        }
    } else if (update) {
        for (const [name, entry] of Object.entries(state.installed))
            visit(name, null, entry.explicit, false)
    }
    return { steps, warnings, markExplicit }
}

/** Removes packages installed only as dependencies that nothing needs anymore. */
function prune() {
    const removed = []
    for (;;) {
        const needed = new Set(
            Object.values(state.installed).flatMap((e) => Object.keys(e.dependencies ?? {})),
        )
        const orphans = Object.keys(state.installed).filter(
            (n) => !state.installed[n].explicit && !needed.has(n),
        )
        if (!orphans.length) return removed
        for (const name of orphans) {
            delete state.installed[name]
            removed.push(name)
        }
    }
}

function preparedSummary(path, raw) {
    const scoped = raw.name.startsWith("@")
    const fullName = scoped ? raw.name : `@${state.user.handle}/${raw.name}`
    const isFolder = !/\.bee_pack$/i.test(path)
    return {
        path,
        isFolder,
        size: isFolder ? 3_400_000 : 7_900_000,
        sha256: "ab".repeat(32),
        beeId: isFolder ? "MY_NEW_ITEMS" : "COOL_ITEMS",
        manifest: {
            scope: fullName.slice(1, fullName.indexOf("/")),
            name: fullName.slice(fullName.indexOf("/") + 1),
            fullName,
            version: raw.version,
            displayName: raw.display_name ?? null,
            description: raw.description ?? null,
            compatibleWith: raw.compatibleWith ?? null,
            dependencies: raw.dependencies ?? {},
        },
        info: { name: raw.display_name ?? null, description: raw.description ?? null },
        stripped: isFolder ? [] : ["readme.md", "preview.psd"],
        skipped: isFolder ? [".git/", "notes.txt.bak"] : [],
    }
}

/** What the registry's publish check would refuse (like the real one), or null. */
function registryRefusal(summary) {
    if (!state.loggedIn) return null
    const m = summary.manifest
    const doc = state.docs.get(m.fullName)
    if (doc) {
        if (!isAdmin() && !doc.owners.includes(state.user.handle)) {
            return `You're not an owner of ${m.fullName}.`
        }
        if (doc.versions[m.version]) {
            return `${m.fullName}@${m.version} already exists. Bump "version" in bee-package.json.`
        }
        return null
    }
    if (m.scope !== state.user.handle) {
        return `You can only create packages under @${state.user.handle}, not @${m.scope}. Change "name" or "author" in bee-package.json.`
    }
    return null
}

/** Adds a published version to the sample registry. */
function addVersion({
    fullName,
    version: v,
    displayName,
    description,
    compatibleWith,
    dependencies,
    beeId,
    size,
    source,
}) {
    let doc = state.docs.get(fullName)
    const created = !doc
    if (doc && doc.versions[v]) {
        return fail(`${fullName}@${v} already exists. Publish a new version number.`, {
            code: "version_exists",
            status: 409,
        })
    }
    if (!doc) {
        doc = {
            name: fullName,
            scope: fullName.slice(1, fullName.indexOf("/")),
            displayName,
            description,
            beeId,
            deprecated: null,
            owners: [state.user.handle],
            createdAt: new Date().toISOString(),
            versions: {},
        }
        state.docs.set(fullName, doc)
    }
    doc.versions[v] = version(v, {
        publishedAt: new Date().toISOString(),
        publishedBy: state.user.handle,
        downloads: 0,
        compatibleWith,
        dependencies,
        size,
        source,
    })
    refresh(doc)
    return ok({
        result: {
            name: fullName,
            version: v,
            created,
            strippedFiles: [],
            sha256: "ab".repeat(32),
            size,
        },
    })
}

function startFlow(kind) {
    if (kind === "link" && !state.loggedIn) return fail("Log in first.", { code: "login_required" })
    if (state.flow) clearTimeout(state.flow.timer)
    const id = rid()
    // Pretends the user finishes in the browser after a few seconds
    const timer = setTimeout(() => {
        state.flow = null
        if (kind === "login") {
            state.loggedIn = true
            emit("auth:login-result", { id, kind, ok: true, user: clone(state.user) })
            return
        }
        const provider = state.identities.some((i) => i.provider === "discord")
            ? "github"
            : "discord"
        const identity = { provider, username: provider === "discord" ? "areng_dc" : "Areng14" }
        state.identities.push({
            ...identity,
            avatarUrl: AVATARS[provider],
            linkedAt: new Date().toISOString(),
            lastLoginAt: null,
        })
        if (!state.user.avatarUrl && state.avatarSource !== "none") {
            state.user.avatarUrl = AVATARS[provider]
            state.avatarSource = provider
        }
        emit("auth:login-result", { id, kind, ok: true, identity })
    }, 4000)
    state.flow = { id, timer }
    return ok({
        id,
        kind,
        confirmCode: "K7QD-4MXP",
        url: `https://registry.example/${kind}/dev-bridge`,
        expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
    })
}

// ---------- the bridge ----------

const bridge = {
    app: {
        ready: async () => ok(),
        info: async () =>
            ok({
                version: "1.0.0 (dev bridge)",
                registry: "https://beepm.beemodtools.org",
                packagesDir: PACKAGES_DIR,
                platform: "win32",
            }),
        openExternal: async (url) => {
            console.info(`[dev bridge] would open ${url}`)
            return ok()
        },
        // A browser window stands in for the app's own one
        openContents: async (name, version, title) => {
            const query = new URLSearchParams({ contents: name, version, title: title ?? "" })
            window.open(`/?${query}`, "_blank", "width=760,height=660")
            return ok()
        },
        openPackagesFolder: async () => {
            if (!state.bee2.dir) return fail("Choose where BEE2 is installed first.")
            console.info(`[dev bridge] would open ${PACKAGES_DIR}`)
            return ok()
        },
        settings: async () => ok({ settings: clone(state.appSettings) }),
        updateSettings: async (changes = {}) => {
            Object.assign(state.appSettings, changes)
            return ok({ settings: clone(state.appSettings) })
        },
        // BeePM's own updates: ?appupdate pretends a new version is downloaded
        update: async (action) => {
            if (action === "restart") console.info("[dev bridge] would restart into BeePM 1.0.2")
            return ok({
                status: params.has("appupdate")
                    ? { phase: "ready", version: "1.0.2" }
                    : { phase: "current" },
            })
        },
        openLogsFolder: async () => {
            console.info("[dev bridge] would open the logs folder")
            return ok()
        },
    },

    toast: {
        answer: async (value) => {
            console.info(`[dev bridge] update question answered: ${value}`)
            return ok()
        },
    },

    auth: {
        status: async () => {
            await sleep(150)
            if (!state.loggedIn) return ok({ loggedIn: false })
            return ok({
                loggedIn: true,
                offline: false,
                user: clone(state.user),
                avatarSource: state.avatarSource,
                identities: clone(state.identities),
                canPublish: true,
                publishBlockedReason: null,
                tokenKind: "session",
            })
        },
        login: async () => {
            await sleep(300)
            return startFlow("login")
        },
        link: async () => {
            await sleep(300)
            return startFlow("link")
        },
        cancel: async (id) => {
            const flow = state.flow
            if (flow && (!id || flow.id === id)) {
                clearTimeout(flow.timer)
                state.flow = null
                emit("auth:login-result", {
                    id: flow.id,
                    ok: false,
                    reason: "aborted",
                    error: "Login cancelled.",
                })
            }
            return ok()
        },
        unlink: async (provider) => {
            await sleep(300)
            if (state.identities.length === 1) {
                return fail("You can't unlink your only login. Link another account first.", {
                    code: "last_identity",
                    status: 409,
                })
            }
            state.identities = state.identities.filter((i) => i.provider !== provider)
            if (state.avatarSource === provider) {
                state.avatarSource = state.identities[0].provider
                state.user.avatarUrl = state.identities[0].avatarUrl
            }
            return ok({ identities: clone(state.identities) })
        },
        updateProfile: async ({ displayName, avatar } = {}) => {
            await sleep(250)
            if (!state.loggedIn) return fail("Log in first.", { code: "login_required" })
            if (displayName !== undefined) {
                const name = String(displayName).trim()
                if (!name || name.length > 50) {
                    return fail("Your nickname needs 1 to 50 characters.", { status: 400 })
                }
                state.user.displayName = name
            }
            if (avatar !== undefined) {
                if (avatar === "none") {
                    state.user.avatarUrl = null
                } else {
                    const identity = state.identities.find((i) => i.provider === avatar)
                    if (!identity) return fail(`No ${avatar} account is linked.`, { status: 400 })
                    state.user.avatarUrl = identity.avatarUrl
                }
                state.avatarSource = avatar
            }
            return ok({
                user: clone(state.user),
                identities: clone(state.identities),
                avatarSource: state.avatarSource,
            })
        },
    },

    registry: {
        // Like the registry: package fields, or what's in the latest version (kind: only that)
        search: async (query = "", { kind } = {}) => {
            await sleep(250)
            const q = String(query).trim().toLowerCase()
            const list = [...state.docs.values()]
                .filter((doc) => (!doc.removed || isAdmin()) && doc.latest)
                .sort((a, b) => b.downloads - a.downloads)
                .flatMap((doc) => {
                    const contents = contentsOf(doc.name).filter((o) => !kind || o.kind === kind)
                    const matching = contents.filter(
                        (o) =>
                            !q || [o.name, ...o.aliases].some((n) => n.toLowerCase().includes(q)),
                    )
                    const fields =
                        !q ||
                        [doc.name, doc.scope, doc.beeId, doc.displayName, doc.description].some(
                            (field) => field?.toLowerCase().includes(q),
                        )
                    const keep = kind
                        ? matching.length > 0 || (q && fields && contents.length > 0)
                        : fields || matching.length > 0
                    if (!keep) return []
                    if ((!q && !kind) || !matching.length) return [summary(doc)]
                    const matches = matching
                        .slice(0, 5)
                        .map(({ kind: k, name }) => ({ kind: k, name }))
                    return [{ ...summary(doc), found: { matches, count: matching.length } }]
                })
            return ok({ total: list.length, packages: list })
        },
        package: async (name) => {
            await sleep(200)
            const doc = state.docs.get(name)
            if (!doc || (doc.removed && !isAdmin())) {
                return fail(`Package ${name} doesn't exist.`, { code: "not_found", status: 404 })
            }
            return ok({ package: { ...clone(doc), contents: countsOf(name) } })
        },
        contents: async (name, version) => {
            await sleep(200)
            if (!state.docs.get(name)?.versions[version]) {
                return fail(`${name}@${version} doesn't exist.`, { code: "not_found", status: 404 })
            }
            // Only the latest version was looked inside (the others: as if not read yet)
            const latest = state.docs.get(name).latest === version
            return ok({
                version,
                read: latest,
                error: null,
                contents: latest ? contentsOf(name) : [],
            })
        },
    },

    packages: {
        installed: async () => ok({ packages: clone(state.installed) }),
        plan: async (specs = [], options = {}) => {
            await sleep(300)
            try {
                const plan = planFor(specs, options)
                const planId = rid()
                state.plans.set(planId, plan)
                return ok({ planId, ...clone(plan) })
            } catch (err) {
                return fail(err.message, { code: "install" })
            }
        },
        apply: async (planId) => {
            const plan = state.plans.get(planId)
            if (!plan) return fail("That install plan is out of date. Try again.")
            state.plans.delete(planId)
            for (const [index, step] of plan.steps.entries()) {
                await simulate(step.size, 10, 120, (received) =>
                    emit("packages:progress", {
                        planId,
                        index,
                        count: plan.steps.length,
                        name: step.name,
                        version: step.to,
                        received,
                        total: step.size,
                    }),
                )
                state.installed[step.name] = {
                    version: step.to,
                    range: step.range,
                    explicit: step.explicit,
                    file: `${step.name.slice(1).replace("/", "@")}.bee_pack`,
                    sha256: step.sha256,
                    beeId: step.beeId,
                    dependencies: step.dependencies,
                    compatibleWith: step.compatibleWith,
                    installedAt: new Date().toISOString(),
                }
            }
            for (const name of plan.markExplicit)
                if (state.installed[name]) state.installed[name].explicit = true
            const removed = prune()
            return ok({
                installed: plan.steps.map(({ name, from, to, change, explicit }) => ({
                    name,
                    from,
                    to,
                    change,
                    explicit,
                })),
                removed,
                warnings: plan.warnings,
            })
        },
        discardPlan: async (planId) => {
            state.plans.delete(planId)
            return ok()
        },
        uninstall: async (names, options = {}) => {
            await sleep(300)
            for (const name of names) {
                if (!state.installed[name])
                    return fail(`${name} isn't installed.`, { code: "install" })
            }
            if (!options.force) {
                const dependents = names
                    .map((name) => ({
                        name,
                        neededBy: Object.keys(state.installed).filter(
                            (other) =>
                                !names.includes(other) &&
                                state.installed[other].dependencies?.[name],
                        ),
                    }))
                    .filter((d) => d.neededBy.length)
                if (dependents.length) {
                    return fail(
                        dependents
                            .map((d) => `${d.name} is needed by ${d.neededBy.join(", ")}.`)
                            .join(" "),
                        {
                            code: "has_dependents",
                            dependents,
                        },
                    )
                }
            }
            for (const name of names) delete state.installed[name]
            return ok({ removed: [...names, ...prune()] })
        },
        outdated: async () => {
            await sleep(300)
            const bee2Version = state.bee2?.version ?? null
            const rows = []
            for (const [name, entry] of Object.entries(state.installed)) {
                const doc = state.docs.get(name)
                if (!doc || doc.removed) {
                    rows.push({
                        name,
                        current: entry.version,
                        wanted: null,
                        latest: null,
                        removed: true,
                    })
                    continue
                }
                const usable = Object.values(doc.versions)
                    .filter((v) => !v.yanked && isCompatible(v.compatibleWith, bee2Version))
                    .map((v) => v.version)
                const row = {
                    name,
                    current: entry.version,
                    wanted: semver.maxSatisfying(usable, entry.range ?? "*"),
                    latest: doc.latest,
                    deprecated: doc.versions[entry.version]?.deprecated || doc.deprecated || null,
                    yanked: Boolean(doc.versions[entry.version]?.yanked),
                }
                if (
                    row.yanked ||
                    (row.wanted && row.wanted !== row.current) ||
                    (row.latest && row.latest !== row.current)
                ) {
                    rows.push(row)
                }
            }
            return ok({ rows })
        },
    },

    bee2: {
        status: async () =>
            ok({
                dir: state.bee2.dir,
                version: state.bee2.dir ? state.bee2.version : null,
                found: Boolean(state.bee2.dir),
                packagesDir: state.bee2.dir ? PACKAGES_DIR : null,
                suggestion: !state.bee2.dir && state.bee2Running ? BEE2_DIR : null,
                moving: null,
            }),
        pickFolder: async () => ok({ canceled: false, path: BEE2_DIR }),
        setFolder: async (folder) => {
            await sleep(300)
            state.bee2.dir = String(folder).replace(/\\packages(\\beepm)?$/i, "")
            return ok({ dir: state.bee2.dir, version: state.bee2.version, moved: 0 })
        },
        check: async () => {
            await sleep(500)
            if (!state.bee2.dir) return fail("Choose where BEE2 is installed first.")
            const onBeepm = state.check.onBeepm.filter(
                (p) => !state.appSettings.keepOwn.includes(p.id),
            )
            return ok({ reviewId: rid(), ...clone(state.check), onBeepm, offline: false })
        },
        // Deletes what wasn't kept, and installs BeePM's version of the packages switched
        resolve: async ({ choices = {}, adopt = [], keep = [], closeBee2 = false } = {}) => {
            await sleep(600)
            const { duplicates, onBeepm } = state.check
            const removed = []
            for (const group of duplicates.packages) {
                const kept = choices.packages?.[group.id] ?? group.copies[0].path
                removed.push(...group.copies.filter((c) => c.path !== kept).map((c) => c.path))
            }
            duplicates.items.forEach((group, index) => {
                const kept = choices.items?.[index] ?? group.packages[0].id
                for (const pkg of group.packages.filter((p) => p.id !== kept)) {
                    removed.push(...pkg.copies.map((c) => c.path))
                }
            })
            const switching = onBeepm.filter((p) => adopt.includes(p.id))
            state.appSettings.keepOwn.push(...keep)
            if ((removed.length || switching.length) && state.bee2Running && !closeBee2) {
                return fail("BEE2 is open, and it has the package files open.", {
                    code: "bee2_running",
                })
            }
            const installed = []
            for (const { package: name } of switching) {
                const doc = state.docs.get(name)
                state.installed[name] = {
                    version: doc.latest,
                    range: "*",
                    explicit: true,
                    file: `${name.slice(1).replace("/", "@")}.bee_pack`,
                    beeId: doc.beeId,
                    dependencies: {},
                    compatibleWith: null,
                    installedAt: new Date().toISOString(),
                }
                installed.push(`${name}@${doc.latest}`)
            }
            state.check = { duplicates: { packages: [], items: [] }, onBeepm: [] }
            return ok({
                removed,
                uninstalled: [],
                installed,
                replaced: switching.map((p) => ({ name: p.package, files: [p.file] })),
            })
        },
    },

    publish: {
        pick: async (kind) =>
            ok({
                canceled: false,
                path:
                    kind === "folder"
                        ? "C:\\Users\\you\\Documents\\my-new-items"
                        : "C:\\Users\\you\\Downloads\\cool-items.bee_pack",
            }),
        prepare: async (path) => {
            await sleep(700)
            const isFolder = !/\.bee_pack$/i.test(path)
            // The sample folder has no bee-package.json until it's created with "Save"
            const raw = state.manifests.get(path)
            if (!raw) {
                return fail("This package can't be published yet.", {
                    code: "invalid_package",
                    problems: ["bee-package.json is missing from the root of the package"],
                    path,
                    isFolder,
                    manifestProblem: true,
                })
            }
            const prepared = preparedSummary(path, raw)
            const refusal = registryRefusal(prepared)
            if (refusal) {
                return fail("This package can't be published yet.", {
                    code: "invalid_package",
                    problems: [refusal],
                    path,
                    isFolder,
                    manifestProblem: true,
                })
            }
            const id = rid()
            state.prepared.set(id, prepared)
            return ok({ id, ...clone(prepared) })
        },
        upload: async (id, options = {}) => {
            if (!state.loggedIn) return fail("Log in to publish.", { code: "login_required" })
            const item = state.prepared.get(id)
            if (!item) return fail("This package isn't ready anymore. Choose it again.")
            if (item.github)
                await sleep(1500) // the registry downloads the release
            else {
                await simulate(item.size, 15, 120, (sent) =>
                    emit("publish:progress", { id, sent, total: item.size }),
                )
            }
            await sleep(900)
            const m = item.manifest
            const res = addVersion({
                fullName: m.fullName,
                version: m.version,
                displayName: m.displayName,
                description: m.description,
                compatibleWith: m.compatibleWith,
                dependencies: m.dependencies,
                beeId: item.beeId,
                size: item.size,
                source: item.github
                    ? { type: "github", repo: item.github.fullName, tag: item.github.tag }
                    : { type: "upload" },
            })
            if (res.ok) {
                state.prepared.delete(id)
                if (item.github && options.watch) {
                    state.watches.set(m.fullName, {
                        repo: item.github.fullName,
                        asset: item.github.asset,
                        release: item.github.tag,
                        checkedAt: new Date().toISOString(),
                        error: null,
                        by: state.user.handle,
                    })
                } else if (item.github) state.watches.delete(m.fullName)
                if (item.github) res.result = { ...res.result, watching: Boolean(options.watch) }
            }
            return res
        },
        // BEEmodders/gel-pack's sample release has no bee-package.json
        prepareGithub: async ({ owner, repo, tag, asset } = {}) => {
            await sleep(1200)
            if (repo === "gel-pack") {
                return fail("This release can't be published yet.", {
                    code: "invalid_package",
                    problems: ["bee-package.json is missing from the root of the package"],
                    manifestProblem: true,
                })
            }
            const raw = {
                name: repo.toLowerCase(),
                version: tag.replace(/^v/, ""),
                display_name: repo,
                description: `Sample release ${tag} from the dev bridge.`,
                compatibleWith: ">=2.4.44",
                dependencies: { "@beemod/BEE2_CLEAN_STYLE": "*" },
            }
            const github = { owner, repo, tag, asset, fullName: `${owner}/${repo}` }
            const prepared = { ...preparedSummary(asset, raw), github }
            const refusal = registryRefusal(prepared)
            if (refusal) {
                return fail("This release can't be published yet.", {
                    code: "invalid_package",
                    problems: [refusal],
                    manifestProblem: true,
                })
            }
            const id = rid()
            state.prepared.set(id, prepared)
            return ok({ id, ...clone(prepared) })
        },
        discard: async (id) => {
            state.prepared.delete(id)
            return ok()
        },
        githubRepos: async () => {
            await sleep(400)
            if (!state.identities.some((i) => i.provider === "github")) {
                return fail("Link a GitHub account first.", { code: "no_github" })
            }
            return ok({
                repos: [
                    { owner: "Areng14", name: "ArengItems", fullName: "Areng14/ArengItems" },
                    { owner: "BEEmodders", name: "gel-pack", fullName: "BEEmodders/gel-pack" },
                    { owner: "Areng14", name: "dotfiles", fullName: "Areng14/dotfiles" },
                ],
            })
        },
        githubReleases: async ({ repo } = {}) => {
            await sleep(300)
            if (repo === "dotfiles") return ok({ releases: [] })
            return ok({
                releases: [
                    {
                        tag: "v1.3.0",
                        name: "Laser relays",
                        publishedAt: days(3),
                        prerelease: false,
                        assets: ["items.bee_pack", "items-lite.bee_pack"],
                    },
                    {
                        tag: "v1.1.0",
                        name: "v1.1.0",
                        publishedAt: days(60),
                        prerelease: false,
                        assets: ["items.bee_pack"],
                    },
                ],
            })
        },
        suggestManifest: async (path) => {
            await sleep(300)
            const existing = state.manifests.get(path) ?? null
            return ok({
                path,
                isFolder: !/\.bee_pack$/i.test(path),
                manifest: {
                    name: `@${state.user.handle}/my-new-items`,
                    version: "1.0.0",
                    display_name: "My New Items",
                    description: "",
                    compatibleWith: `>=${state.bee2?.version.split(".").slice(0, 3).join(".") ?? "2.4.41"}`,
                    dependencies: { "@beemod/BEE2_CLEAN_STYLE": "*" },
                },
                existing: existing && clone(existing),
                existingText: existing && JSON.stringify(existing, null, 4),
            })
        },
        writeManifest: async (path, manifest) => {
            await sleep(200)
            state.manifests.set(path, clone(manifest))
            if (/\.bee_pack$/i.test(path)) return ok({ file: path, insidePack: true })
            return ok({ file: `${path}\\bee-package.json`, insidePack: false })
        },
    },

    manage: {
        githubWatch: async (name) => {
            await sleep(150)
            return ok({ watch: clone(state.watches.get(name) ?? null) })
        },
        stopGithubWatch: async (name) => {
            await sleep(200)
            state.watches.delete(name)
            return ok()
        },
        yank: async ({ name, version: v, reason } = {}) => {
            await sleep(250)
            const { doc, error } = managed(name)
            if (error) return error
            Object.assign(doc.versions[v], { yanked: true, yankReason: reason || null })
            refresh(doc)
            return ok()
        },
        unyank: async ({ name, version: v } = {}) => {
            await sleep(250)
            const { doc, error } = managed(name)
            if (error) return error
            Object.assign(doc.versions[v], { yanked: false, yankReason: null })
            refresh(doc)
            return ok()
        },
        deprecate: async ({ name, version: v, message } = {}) => {
            await sleep(250)
            const { doc, error } = managed(name)
            if (error) return error
            if (v) doc.versions[v].deprecated = message || null
            else doc.deprecated = message || null
            return ok()
        },
        unpublish: async ({ name, version: v } = {}) => {
            await sleep(250)
            const { doc, error } = managed(name)
            if (error) return error
            if (
                Date.now() - new Date(doc.versions[v].publishedAt).getTime() > 72 * 3600 * 1000 &&
                !isAdmin()
            ) {
                return fail(
                    "Versions can only be unpublished within 72 hours. Yank or deprecate it instead.",
                    {
                        code: "unpublish_window",
                        status: 403,
                    },
                )
            }
            delete doc.versions[v]
            refresh(doc)
            return ok()
        },
        owners: async (name) => ok({ owners: clone(state.docs.get(name)?.owners ?? []) }),
        addOwner: async ({ name, handle } = {}) => {
            await sleep(250)
            const { doc, error } = managed(name)
            if (error) return error
            const user = String(handle).replace(/^@/, "").toLowerCase()
            if (!USERS.includes(user))
                return fail(`@${user} doesn't exist.`, { code: "not_found", status: 404 })
            if (!doc.owners.includes(user)) doc.owners.push(user)
            return ok({ owners: clone(doc.owners) })
        },
        removeOwner: async ({ name, handle } = {}) => {
            await sleep(250)
            const { doc, error } = managed(name)
            if (error) return error
            if (doc.owners.length === 1)
                return fail("A package needs at least one owner.", {
                    code: "last_owner",
                    status: 409,
                })
            doc.owners = doc.owners.filter((owner) => owner !== handle)
            return ok({ owners: clone(doc.owners) })
        },
    },

    admin: {
        removePackage: async ({ name, reason } = {}) => {
            await sleep(250)
            if (!isAdmin())
                return fail("Only admins can do this.", { code: "admin_required", status: 403 })
            state.docs.get(name).removed = { at: new Date().toISOString(), reason: reason || null }
            return ok()
        },
        restorePackage: async (name) => {
            await sleep(250)
            if (!isAdmin())
                return fail("Only admins can do this.", { code: "admin_required", status: 403 })
            delete state.docs.get(name).removed
            return ok()
        },
    },

    on(event, callback) {
        if (!listeners.has(event)) listeners.set(event, new Set())
        listeners.get(event).add(callback)
        return () => listeners.get(event).delete(callback)
    },
}

export function installDevBridge() {
    window.beepm = bridge
    console.info(
        "BeePM dev bridge: sample data, nothing is installed or published. Add ?loggedout or ?admin to the URL to preview those states.",
    )
}
