import { Box, Button, IconButton, Typography } from "@mui/material"
import CloseIcon from "@mui/icons-material/Close"
import Brand from "./Brand.jsx"

/**
 * The small window in the bottom-right corner that asks about an update when BEE2 opens
 * (backend/main.js askUpdate). Closing it is "Not now".
 */
export default function UpdateToast({ name, from, to }) {
    const answer = (value) => window.beepm?.toast?.answer(value)
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
                    aria-label="Not now"
                    onClick={() => answer("later")}
                    sx={{ mr: -1, color: "#888" }}
                >
                    <CloseIcon fontSize="small" />
                </IconButton>
            </Box>
            <Typography noWrap sx={{ color: "#fff", fontWeight: 600, mt: 0.5 }}>
                Update {name}?
            </Typography>
            <Typography variant="body2" noWrap sx={{ color: "#888" }}>
                {from} → {to}
            </Typography>
            <Box sx={{ display: "flex", gap: 1, mt: "auto" }}>
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
            </Box>
        </Box>
    )
}
