import { readPackContents } from "@beepm/core"
import { withTemp } from "../lib/tmp.js"

/**
 * What versions define (items, styles, music...: core's contents.js), kept in version_contents
 * for listing and search. A version is read when it's published; startContentsReader reads the
 * ones from before, or whose reading was interrupted.
 */

const COLUMNS = [
    "version_id",
    "kind",
    "object_id",
    "name",
    "aliases",
    "position",
    "description",
    "authors",
    "icon",
    "icon_type",
]
// Rows per INSERT: at most this many, with at most this much icon data
const MAX_ROWS = 100
const MAX_ICON_BYTES = 4 * 1024 * 1024

/** The rows to insert, in INSERTs small enough to send. */
function* batches(objects) {
    let batch = []
    let bytes = 0
    for (const [position, object] of objects.entries()) {
        const size = object.icon?.data.length ?? 0
        if (batch.length && (batch.length >= MAX_ROWS || bytes + size > MAX_ICON_BYTES)) {
            yield batch
            batch = []
            bytes = 0
        }
        batch.push({ position, object })
        bytes += size
    }
    if (batch.length) yield batch
}

/** Saves what a version defines, or why its file couldn't be read. */
async function saveContents(db, versionId, objects, error) {
    await db.tx(async (tx) => {
        await tx.query("DELETE FROM version_contents WHERE version_id = $1", [versionId])
        for (const batch of batches(objects)) {
            const params = []
            const rows = batch.map(({ position, object }) => {
                const at = params.length
                params.push(
                    versionId,
                    object.kind,
                    object.id,
                    object.name,
                    object.aliases.join("\n"),
                    position,
                    object.description ?? null,
                    object.authors ?? null,
                    object.icon?.data ?? null,
                    object.icon?.type ?? null,
                )
                return `(${COLUMNS.map((_, i) => `$${at + i + 1}`).join(", ")})`
            })
            await tx.query(
                `INSERT INTO version_contents (${COLUMNS.join(", ")})
                 VALUES ${rows.join(", ")} ON CONFLICT DO NOTHING`,
                params,
            )
        }
        await tx.query(
            "UPDATE versions SET contents_read_at = now(), contents_error = $2 WHERE id = $1",
            [versionId, error],
        )
    })
}

/**
 * Reads what the version's file (on this server's disk) defines and saves it. A file that can't
 * be read is noted on the version, not retried. Returns { count, error }.
 */
export async function readVersionContents(db, versionId, filePath) {
    let objects = []
    let error = null
    try {
        objects = await readPackContents(filePath)
    } catch (err) {
        error = err.problems?.[0] ?? err.message
    }
    await saveContents(db, versionId, objects, error)
    return { count: objects.length, error }
}

/**
 * Reads the contents of the published versions that haven't been read yet, one at a time and
 * newest first, a while after startup. Returns a function that stops it.
 */
export function startContentsReader({ db, storage, log }, { delayMs = 30 * 1000 } = {}) {
    let stopped = false
    async function run() {
        const { rows } = await db.query(
            `SELECT v.id, v.version, v.storage_key, p.scope, p.name FROM versions v
               JOIN packages p ON p.id = v.package_id
              WHERE v.contents_read_at IS NULL AND v.unpublished_at IS NULL
              ORDER BY v.published_at DESC`,
        )
        if (!rows.length) return
        log.info(`Reading what ${rows.length} version(s) contain`)
        let read = 0
        for (const row of rows) {
            if (stopped) return
            try {
                await withTemp(async (tmp) => {
                    const file = await tmp.file(".bee_pack")
                    await storage.downloadTo(row.storage_key, file)
                    await readVersionContents(db, row.id, file)
                })
                read++
            } catch (err) {
                // Tried again after the next restart
                log.warn(`Couldn't read @${row.scope}/${row.name}@${row.version}: ${err.message}`)
            }
        }
        log.info(`Read what ${read} version(s) contain`)
    }
    const timer = setTimeout(
        () => run().catch((err) => log.warn({ err }, "reading versions' contents failed")),
        delayMs,
    )
    timer.unref()
    return () => {
        stopped = true
        clearTimeout(timer)
    }
}

/**
 * What a version defines: [{ kind, id, name, aliases, description, authors, icon }] in info.txt's
 * order. icon is iconUrl(position), the URL of its icon, or null without one.
 */
export async function versionContents(db, versionId, iconUrl) {
    const { rows } = await db.query(
        `SELECT kind, object_id, name, aliases, position, description, authors,
                icon IS NOT NULL AS has_icon
           FROM version_contents WHERE version_id = $1 ORDER BY position`,
        [versionId],
    )
    return rows.map((row) => ({
        kind: row.kind,
        id: row.object_id,
        name: row.name,
        aliases: row.aliases ? row.aliases.split("\n") : [],
        description: row.description,
        authors: row.authors,
        icon: row.has_icon ? iconUrl(row.position) : null,
    }))
}

/** One thing's icon, by its place in the version: { type, data } or null. */
export async function contentIcon(db, versionId, position) {
    const { rows } = await db.query(
        `SELECT icon, icon_type FROM version_contents
          WHERE version_id = $1 AND position = $2 AND icon IS NOT NULL`,
        [versionId, position],
    )
    return rows.length ? { type: rows[0].icon_type, data: Buffer.from(rows[0].icon) } : null
}

/** How many of each kind the versions define: Map version id -> { kind: count }. */
export async function contentCounts(db, versionIds) {
    const counts = new Map()
    if (!versionIds.length) return counts
    const { rows } = await db.query(
        `SELECT version_id, kind, count(*)::int AS n FROM version_contents
          WHERE version_id = ANY($1::int[]) GROUP BY version_id, kind`,
        [versionIds],
    )
    for (const row of rows) {
        counts.set(row.version_id, { ...counts.get(row.version_id), [row.kind]: row.n })
    }
    return counts
}

/**
 * What in the versions matches a search (pattern: an ILIKE pattern for the name, other names or
 * ID; kind: only that kind): Map version id -> { matches: [{ kind, name }] (the first few),
 * count }.
 */
export async function contentMatches(db, versionIds, { pattern = null, kind = null, max = 5 }) {
    const found = new Map()
    if (!versionIds.length || (!pattern && !kind)) return found
    const { rows } = await db.query(
        `SELECT version_id, kind, name FROM version_contents
          WHERE version_id = ANY($1::int[]) AND ($2::text IS NULL OR kind = $2)
            AND ($3::text IS NULL OR name ILIKE $3 OR aliases ILIKE $3 OR object_id ILIKE $3)
          ORDER BY version_id, position`,
        [versionIds, kind, pattern],
    )
    for (const row of rows) {
        const entry = found.get(row.version_id) ?? { matches: [], count: 0 }
        if (entry.matches.length < max) entry.matches.push({ kind: row.kind, name: row.name })
        entry.count++
        found.set(row.version_id, entry)
    }
    return found
}
