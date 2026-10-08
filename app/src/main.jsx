// First, so the logs of every module below reach the log file
import "./lib/logForwarding.js"
import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import { ThemeProvider } from "@mui/material/styles"
import CssBaseline from "@mui/material/CssBaseline"
import App from "./App.jsx"
import { ContentsWindow } from "./components/Contents.jsx"
import { ReviewWindow } from "./components/ReviewDialog.jsx"
import UpdateToast from "./components/UpdateToast.jsx"
import { theme } from "./theme.js"
import "./index.css"

// The same page also draws the corner windows that ask things (backend/main.js ask), the window
// their "Choose" opens (showReview), and "View contents" windows (showContents)
const params = new URLSearchParams(window.location.search)
const TOASTS = ["update", "close", "duplicates", "adopt", "use-bee2", "app-update"]
const toast = TOASTS.includes(params.get("toast")) ? params.get("toast") : null
const review = params.has("review") ? params.get("review") : null
const contents = params.get("contents")

function render() {
    createRoot(document.getElementById("root")).render(
        <StrictMode>
            <ThemeProvider theme={theme}>
                <CssBaseline />
                {contents ? (
                    <ContentsWindow
                        name={contents}
                        version={params.get("version")}
                        title={params.get("title")}
                    />
                ) : review !== null ? (
                    <ReviewWindow reviewId={review || null} />
                ) : toast ? (
                    <UpdateToast
                        kind={toast}
                        name={params.get("name")}
                        from={params.get("from")}
                        to={params.get("to")}
                        count={Number(params.get("count")) || 1}
                        folder={params.get("folder")}
                        switching={Boolean(params.get("switching"))}
                        version={params.get("version")}
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
