import { Box, Typography } from "@mui/material"
import SettingsIcon from "@mui/icons-material/Settings"

function NotInitializedView() {
    return (
        <Box
            sx={{
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                justifyContent: "center",
                height: "100%",
                textAlign: "center",
                color: "#888",
            }}
        >
            <Box
                sx={{
                    width: 80,
                    height: 80,
                    borderRadius: "50%",
                    backgroundColor: "rgba(211, 47, 47, 0.1)",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    mb: 3,
                }}
            >
                <SettingsIcon sx={{ fontSize: 40, color: "#d32f2f" }} />
            </Box>
            <Typography variant="h5" sx={{ color: "#fff", mb: 1, fontWeight: 600 }}>
                Not Hooked
            </Typography>
            <Typography variant="body1" sx={{ mb: 3, maxWidth: 400 }}>
                BeePM needs to be hooked to your BEE2 installation before you can view installed packages.
            </Typography>
            <Typography variant="body2" sx={{ color: "#666" }}>
                Go to Settings to hook BeePM to BEE2, or browse available packages first.
            </Typography>
        </Box>
    )
}

export default NotInitializedView
