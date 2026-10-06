import { requireText } from "../util.js"

export function registryHandlers({ ctx }) {
    return {
        // Server-side search: name, scope, BEE2 ID, title or description
        "registry:search": async (query) => {
            const q = typeof query === "string" ? query.trim().slice(0, 100) : ""
            const { total, packages } = await ctx.api.search(q, { limit: 200 })
            return { total, packages }
        },

        "registry:package": async (name) => ({
            package: await ctx.api.packument(requireText(name, "Say which package to show.")),
        }),
    }
}
