import { isContentKind } from "@beepm/core"
import { requireText } from "../util.js"

export function registryHandlers({ ctx }) {
    return {
        // Server-side search: name, scope, BEE2 ID, title or description, and what's in the
        // packages (kind: only those with that kind of thing in them, see core's kinds.js)
        "registry:search": async (query, options = {}) => {
            const q = typeof query === "string" ? query.trim().slice(0, 100) : ""
            const kind = isContentKind(options?.kind) ? options.kind : undefined
            const { total, packages } = await ctx.api.search(q, { limit: 200, kind })
            return { total, packages }
        },

        "registry:package": async (name) => ({
            package: await ctx.api.packument(requireText(name, "Say which package to show.")),
        }),

        // What a version contains: { version, read, error, contents: [{ kind, id, name, aliases }] }
        "registry:contents": async (name, version) => {
            const contents = await ctx.api.contents(
                requireText(name, "Say which package to show."),
                requireText(version, "Say which version to show."),
            )
            return { ...contents }
        },
    }
}
