import { defineConfig } from "vite"
import react from "@vitejs/plugin-react"

export default defineConfig(({ command }) => {
    const isServe = command === "serve"

    return {
        plugins: [react()],
        base: isServe ? "/" : "./",
        server: {
            watch: {
                ignored: ["**/node_modules/**"],
            },
        },
    }
})
