import pc from "picocolors"

export const color = pc

export const ok = (message) => console.log(`${pc.green("✔")} ${message}`)
export const info = (message) => console.log(message)
export const warn = (message) => console.error(`${pc.yellow("!")} ${message}`)
export const fail = (message) => console.error(`${pc.red("✖")} ${message}`)

export function formatBytes(bytes) {
    if (!bytes) return "0 B"
    const units = ["B", "KB", "MB", "GB"]
    const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)))
    return `${(bytes / 1024 ** i).toFixed(i ? 1 : 0)} ${units[i]}`
}

export const formatDate = (value) => (value ? new Date(value).toISOString().slice(0, 10) : "-")

/** A one-line progress display that rewrites itself (only on a terminal). */
export function progress(label) {
    const tty = process.stderr.isTTY
    let last = 0
    return {
        update(received, total) {
            if (!tty) return
            const now = Date.now()
            if (now - last < 80 && received !== total) return
            last = now
            const pct = total ? Math.floor((received / total) * 100) : null
            const bar = total
                ? `${"█".repeat(Math.floor(pct / 5)).padEnd(20, "░")} ${String(pct).padStart(3)}%`
                : ""
            process.stderr.write(
                `\r${label} ${bar} ${formatBytes(received)}${total ? ` / ${formatBytes(total)}` : ""}   `,
            )
        },
        done() {
            if (tty) process.stderr.write("\r\x1b[2K")
        },
    }
}

/** Prints rows as aligned columns. */
export function table(rows, headers) {
    const all = headers ? [headers, ...rows] : rows
    const widths = all[0].map((_, i) => Math.max(...all.map((r) => String(r[i] ?? "").length)))
    const line = (r) =>
        r
            .map((cell, i) => String(cell ?? "").padEnd(widths[i]))
            .join("  ")
            .trimEnd()
    if (headers) console.log(pc.bold(line(headers)))
    for (const r of rows) console.log(line(r))
}

/** Asks a yes/no question on the terminal. Non-interactive runs get the default. */
export async function confirm(question, defaultYes = false) {
    if (!process.stdin.isTTY) return defaultYes
    const { createInterface } = await import("node:readline/promises")
    const rl = createInterface({ input: process.stdin, output: process.stdout })
    try {
        const answer = (await rl.question(`${question} ${defaultYes ? "[Y/n]" : "[y/N]"} `))
            .trim()
            .toLowerCase()
        return answer ? answer.startsWith("y") : defaultYes
    } finally {
        rl.close()
    }
}

/** Asks for a line of text, with a default. */
export async function ask(question, fallback = "") {
    if (!process.stdin.isTTY) return fallback
    const { createInterface } = await import("node:readline/promises")
    const rl = createInterface({ input: process.stdin, output: process.stdout })
    try {
        const answer = (
            await rl.question(`${question}${fallback ? pc.dim(` (${fallback})`) : ""}: `)
        ).trim()
        return answer || fallback
    } finally {
        rl.close()
    }
}
