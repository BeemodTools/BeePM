import { useState } from "react"
import {
    Button,
    CircularProgress,
    Dialog,
    DialogActions,
    DialogContent,
    DialogTitle,
    TextField,
    Typography,
} from "@mui/material"
import { useLastValue } from "../lib/useLastValue.js"
import { useApp } from "../state/context.js"
import ErrorAlert from "./ErrorAlert.jsx"

function ConfirmBody({ confirm, onClose }) {
    const [value, setValue] = useState(confirm.input?.initial ?? "")
    const [running, setRunning] = useState(false)
    const [failure, setFailure] = useState(null)
    const missing = Boolean(confirm.input?.required && !value.trim())

    async function submit() {
        if (missing || running) return
        setRunning(true)
        setFailure(null)
        const result = await confirm.onConfirm(value.trim())
        setRunning(false)
        if (result && result.ok === false) setFailure(result)
        else onClose()
    }

    return (
        <>
            <DialogTitle>{confirm.title}</DialogTitle>
            <DialogContent>
                {confirm.message && (
                    <Typography sx={{ color: "#ccc", whiteSpace: "pre-line" }}>
                        {confirm.message}
                    </Typography>
                )}
                {confirm.input && (
                    <TextField
                        autoFocus
                        fullWidth
                        size="small"
                        label={confirm.input.label}
                        helperText={confirm.input.helperText}
                        value={value}
                        multiline={Boolean(confirm.input.multiline)}
                        minRows={confirm.input.multiline ? 2 : undefined}
                        onChange={(event) => setValue(event.target.value)}
                        onKeyDown={(event) => {
                            if (event.key === "Enter" && !confirm.input.multiline) submit()
                        }}
                        sx={{ mt: confirm.message ? 2.5 : 1 }}
                    />
                )}
                {failure && (
                    <ErrorAlert error={failure.error} problems={failure.problems} sx={{ mt: 2 }} />
                )}
            </DialogContent>
            <DialogActions>
                <Button onClick={onClose} disabled={running}>
                    Cancel
                </Button>
                <Button
                    variant="contained"
                    color={confirm.danger ? "error" : "primary"}
                    onClick={submit}
                    disabled={missing || running}
                    startIcon={running ? <CircularProgress size={16} color="inherit" /> : null}
                >
                    {confirm.confirmLabel ?? "OK"}
                </Button>
            </DialogActions>
        </>
    )
}

/** The shared confirmation dialog (see askConfirm in AppProvider). */
export default function ConfirmDialog() {
    const { confirm, closeConfirm } = useApp()
    const shown = useLastValue(confirm)
    return (
        <Dialog open={Boolean(confirm)} onClose={closeConfirm} maxWidth="xs" fullWidth>
            {shown && <ConfirmBody key={shown.id} confirm={shown} onClose={closeConfirm} />}
        </Dialog>
    )
}
