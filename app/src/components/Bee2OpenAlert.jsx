import { Alert, Button, CircularProgress } from "@mui/material"
import { useApp } from "../state/context.js"

/**
 * BEE2 is open, so packages can't be installed, updated or removed (it has them open): says so,
 * with a button that asks BEE2 to close the way its close button does.
 */
export default function Bee2OpenAlert({ sx }) {
    const { bee2Open, bee2Action, closeBee2 } = useApp()
    if (!bee2Open) return null
    const closing = bee2Action === "closing"
    return (
        <Alert
            severity="info"
            sx={sx}
            action={
                <Button
                    color="inherit"
                    size="small"
                    disabled={Boolean(bee2Action)}
                    onClick={closeBee2}
                    startIcon={closing ? <CircularProgress size={14} color="inherit" /> : null}
                >
                    {closing ? "Closing…" : "Close BEE2"}
                </Button>
            }
        >
            BEE2 is open. Close it to install or remove packages.
        </Alert>
    )
}
