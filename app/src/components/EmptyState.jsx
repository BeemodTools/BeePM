import { Box, Typography } from "@mui/material"

export default function EmptyState({ icon: Icon, title, text, action }) {
    return (
        <Box sx={{ textAlign: "center", py: 10, color: "#666" }}>
            {Icon && <Icon sx={{ fontSize: 48, mb: 2, opacity: 0.5 }} />}
            <Typography variant="h6" sx={{ color: "#888", mb: 1 }}>
                {title}
            </Typography>
            {text && <Typography variant="body2">{text}</Typography>}
            {action && <Box sx={{ mt: 3 }}>{action}</Box>}
        </Box>
    )
}
