import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import { ThemeProvider } from "@mui/material/styles"
import CssBaseline from "@mui/material/CssBaseline"
import App from "./App.jsx"
import { theme } from "./theme.js"
import "./index.css"

function render() {
    createRoot(document.getElementById("root")).render(
        <StrictMode>
            <ThemeProvider theme={theme}>
                <CssBaseline />
                <App />
            </ThemeProvider>
        </StrictMode>,
    )
}

// Electron's preload provides window.beepm. In a normal browser (the Vite dev server) a fake
// bridge with sample data stands in, so the UI can be previewed without Electron.
if (window.beepm) {
    render()
} else {
    import("./devBridge.js").then(({ installDevBridge }) => {
        installDevBridge()
        render()
    })
}
