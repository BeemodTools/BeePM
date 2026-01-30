import { Box, Typography } from "@mui/material"
import InventoryIcon from "@mui/icons-material/Inventory"
import ExploreIcon from "@mui/icons-material/Explore"

function EmptyState({ view, search }) {
    return (
        <Box sx={{ textAlign: "center", py: 10, color: "#666" }}>
            {view === "installed" ? (
                <InventoryIcon sx={{ fontSize: 48, mb: 2, opacity: 0.5 }} />
            ) : (
                <ExploreIcon sx={{ fontSize: 48, mb: 2, opacity: 0.5 }} />
            )}
            <Typography variant="h6" sx={{ color: "#888", mb: 1 }}>
                {view === "installed" ? "No packages installed" : "No packages found"}
            </Typography>
            <Typography variant="body2">
                {view === "installed"
                    ? "Install packages from the Browse section"
                    : search
                      ? "Try a different search term"
                      : "The registry appears to be empty"}
            </Typography>
        </Box>
    )
}

export default EmptyState
