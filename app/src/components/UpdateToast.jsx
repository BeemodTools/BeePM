import { Box, Button, IconButton, Typography } from "@mui/material"
import CloseIcon from "@mui/icons-material/Close"
import Brand from "./Brand.jsx"

/**
 * The small window in the bottom-right corner (backend/main.js showToast). "update" asks about
 * an update when BEE2 opens; "close" asks to close BEE2 for the updates picked, since BEE2 has
 * the package files open. Closing it is "Not now" / "When I close it".
 */
export default function UpdateToast({ kind = "update", name, from, to }) {
    const answer = (value) => window.beepm?.toast?.answer(value)
    const close = kind === "close"
    return (
        <Box
            sx={{
                height: "100vh",
                boxSizing: "border-box",
                display: "flex",
                flexDirection: "column",
                px: 2,
                pt: 1,
                pb: 1.5,
                backgroundColor: "#262829",
                border: "1px solid #3a3a3a",
                userSelect: "none",
            }}
        >
            <Box sx={{ display: "flex", alignItems: "center" }}>
                <Typography sx={{ flex: 1, fontSize: 15, fontWeight: 700 }}>
                    <Brand />
                </Typography>
                <IconButton
                    size="small"
                    aria-label={close ? "When I close it" : "Not now"}
                    onClick={() => answer("later")}
                    sx={{ mr: -1, color: "#888" }}
                >
                    <CloseIcon fontSize="small" />
                </IconButton>
            </Box>
            <Typography noWrap sx={{ color: "#fff", fontWeight: 600, mt: 0.5 }}>
                {close ? "Close BEE2 to update?" : `Update ${name}?`}
            </Typography>
            <Typography variant="body2" noWrap sx={{ color: "#888" }}>
                {close ? "Save your work in BEE2 first." : `${from} → ${to}`}
            </Typography>
            <Box sx={{ display: "flex", gap: 1, mt: "auto" }}>
                {close ? (
                    <>
                        <Button size="small" variant="contained" onClick={() => answer("now")}>
                            Close BEE2
                        </Button>
                        <Button size="small" variant="outlined" onClick={() => answer("later")}>
                            When I close it
                        </Button>
                    </>
                ) : (
                    <>
                        <Button size="small" variant="contained" onClick={() => answer("update")}>
                            Update
                        </Button>
                        <Button size="small" variant="outlined" onClick={() => answer("later")}>
                            Not now
                        </Button>
                        <Button
                            size="small"
                            onClick={() => answer("never")}
                            sx={{ ml: "auto", color: "#888" }}
                        >
                            Don't ask again
                        </Button>
                    </>
                )}
            </Box>
        </Box>
    )
}
