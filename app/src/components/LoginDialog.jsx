import {
    Alert,
    Box,
    Button,
    CircularProgress,
    Dialog,
    DialogActions,
    DialogContent,
    DialogTitle,
    Typography,
} from "@mui/material"
import OpenInNewIcon from "@mui/icons-material/OpenInNew"
import { useLastValue } from "../lib/useLastValue.js"
import { useApp } from "../state/context.js"

/**
 * The browser login (and account linking): shows the confirm code while the user finishes in
 * the browser. It closes by itself when the login is done.
 */
export default function LoginDialog() {
    const { login, auth, startLogin, cancelLogin, reopenLoginPage } = useApp()
    const shown = useLastValue(login)
    const linking = shown?.kind === "link"

    return (
        <Dialog
            open={Boolean(login)}
            onClose={(_event, reason) => reason !== "backdropClick" && cancelLogin()}
            maxWidth="xs"
            fullWidth
        >
            <DialogTitle>{linking ? "Link another account" : "Log in to BeePM"}</DialogTitle>
            <DialogContent>
                {shown?.phase === "starting" && (
                    <Box sx={{ display: "flex", alignItems: "center", gap: 1.5, py: 2 }}>
                        <CircularProgress size={20} />
                        <Typography sx={{ color: "#aaa" }}>Opening your browser…</Typography>
                    </Box>
                )}

                {shown?.phase === "waiting" && (
                    <Box sx={{ textAlign: "center" }}>
                        <Typography sx={{ color: "#aaa", mb: 1.5 }}>
                            Check that your browser shows the same code:
                        </Typography>
                        <Box
                            sx={{
                                fontFamily: "monospace",
                                fontSize: 38,
                                fontWeight: 700,
                                letterSpacing: 4,
                                color: "#2eff7b",
                                backgroundColor: "#1a1b1c",
                                border: "1px solid #3a3a3a",
                                borderRadius: 2,
                                py: 2,
                                mb: 2.5,
                                userSelect: "all",
                            }}
                        >
                            {shown.confirmCode}
                        </Box>
                        <Box
                            sx={{
                                display: "flex",
                                alignItems: "center",
                                justifyContent: "center",
                                gap: 1.5,
                                mb: 1.5,
                            }}
                        >
                            <CircularProgress size={16} />
                            <Typography sx={{ color: "#ddd" }}>
                                Waiting for you to finish in your browser…
                            </Typography>
                        </Box>
                        <Typography variant="body2" sx={{ color: "#888" }}>
                            {linking
                                ? `Pick the Discord or GitHub account to link to @${auth.user?.handle ?? "you"}.`
                                : "Continue with Discord or GitHub there."}{" "}
                            If the browser didn't open, use "Open browser again".
                        </Typography>
                    </Box>
                )}

                {shown?.phase === "error" && <Alert severity="error">{shown.error}</Alert>}
            </DialogContent>
            <DialogActions>
                {shown?.phase === "waiting" && (
                    <Button startIcon={<OpenInNewIcon />} onClick={reopenLoginPage}>
                        Open browser again
                    </Button>
                )}
                {shown?.phase === "error" ? (
                    <>
                        <Button onClick={cancelLogin}>Close</Button>
                        <Button variant="contained" onClick={() => startLogin(shown.kind)}>
                            Try again
                        </Button>
                    </>
                ) : (
                    <Button onClick={cancelLogin}>Cancel</Button>
                )}
            </DialogActions>
        </Dialog>
    )
}
