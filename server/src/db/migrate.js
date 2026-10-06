import { readdir, readFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"

const migrationsDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "migrations")
const LOCK_KEY = 4207011

/** Applies every migrations/*.sql file that hasn't run yet, in name order. */
export async function migrate(db, log = () => {}) {
    await db.withLock(LOCK_KEY, async () => {
        await db.exec(`
            CREATE TABLE IF NOT EXISTS schema_migrations (
                name TEXT PRIMARY KEY,
                applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
            )
        `)
        const applied = new Set(
            (await db.query("SELECT name FROM schema_migrations")).rows.map((r) => r.name),
        )
        const files = (await readdir(migrationsDir)).filter((f) => f.endsWith(".sql")).sort()

        for (const file of files) {
            if (applied.has(file)) continue
            const sql = await readFile(path.join(migrationsDir, file), "utf8")
            await db.tx(async (tx) => {
                await tx.exec(sql)
                await tx.query("INSERT INTO schema_migrations (name) VALUES ($1)", [file])
            })
            log(`Applied migration ${file}`)
        }
    })
}
