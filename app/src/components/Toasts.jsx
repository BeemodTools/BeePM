import { Alert, Snackbar } from "@mui/material"
import { useApp } from "../state/context.js"

// Success toasts use BeePM's green, like the green buttons
const brandGreen = {
    backgroundColor: "#2eff7b",
    color: "rgba(0, 0, 0, 0.87)",
    fontWeight: 500,
    "& .MuiAlert-icon, & .MuiAlert-action": { color: "rgba(0, 0, 0, 0.87)" },
}

const SHOWN_FOR_MS = 5000

/**
 * Shows toasts one after another, bottom right. Each goes away after 5 seconds, even while the
 * window isn't focused (hovering one keeps it open to read).
 */
export default function Toasts() {
    const { toasts, dismissToast } = useApp()
    const toast = toasts[0]
    if (!toast) return null
    return (
        <Snackbar
            key={toast.id}
            open
            autoHideDuration={SHOWN_FOR_MS}
            disableWindowBlurListener
            onClose={(_event, reason) => reason !== "clickaway" && dismissToast(toast.id)}
            anchorOrigin={{ vertical: "bottom", horizontal: "right" }}
        >
            <Alert
                onClose={() => dismissToast(toast.id)}
                severity={toast.severity}
                variant="filled"
                sx={{
                    minWidth: 300,
                    maxWidth: 520,
                    ...(toast.severity === "success" && brandGreen),
                }}
            >
                {toast.message}
            </Alert>
        </Snackbar>
    )
}
