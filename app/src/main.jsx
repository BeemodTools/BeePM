// First, so the logs of every module below reach the log file
import "./lib/logForwarding.js"
import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import { ThemeProvider } from "@mui/material/styles"
import CssBaseline from "@mui/material/CssBaseline"
import App from "./App.jsx"
import UpdateToast from "./components/UpdateToast.jsx"
import { theme } from "./theme.js"
import "./index.css"

// The same page also draws the windows that ask about updates (backend/main.js showToast)
const params = new URLSearchParams(window.location.search)
const toast = ["update", "close"].includes(params.get("toast")) ? params.get("toast") : null

function render() {
    createRoot(document.getElementById("root")).render(
        <StrictMode>
            <ThemeProvider theme={theme}>
                <CssBaseline />
                {toast ? (
                    <UpdateToast
                        kind={toast}
                        name={params.get("name")}
                        from={params.get("from")}
                        to={params.get("to")}
                    />
                ) : (
                    <App />
                )}
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
