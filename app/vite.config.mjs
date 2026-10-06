import { defineConfig } from "vite"
import react from "@vitejs/plugin-react"

// The packaged app loads dist/index.html from disk: only its own scripts, plus avatar images
// (Discord/GitHub) over https. Emotion (MUI's styling) needs inline styles. The renderer itself
// never talks to the network: everything goes through the main process.
const CONTENT_SECURITY_POLICY = [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: https:",
    "font-src 'self' data:",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
].join("; ")

const contentSecurityPolicy = {
    name: "beepm-content-security-policy",
    apply: "build", // Vite's dev server needs inline scripts for hot reload
    transformIndexHtml: () => [
        {
            tag: "meta",
            attrs: { "http-equiv": "Content-Security-Policy", content: CONTENT_SECURITY_POLICY },
            injectTo: "head-prepend",
        },
    ],
}

export default defineConfig(({ command }) => {
    const isServe = command === "serve"

    return {
        plugins: [react(), contentSecurityPolicy],
        base: isServe ? "/" : "./",
        // Loaded from disk by Electron, so one bigger bundle is fine
        build: { chunkSizeWarningLimit: 1500 },
        server: {
            port: 5167,
            strictPort: true,
            watch: {
                ignored: ["**/node_modules/**"],
            },
        },
    }
})
