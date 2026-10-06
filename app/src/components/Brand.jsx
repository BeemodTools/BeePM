import { Box } from "@mui/material"

/** The BeePM wordmark: "Bee" in white, "PM" in green. Size and weight come from the parent. */
export default function Brand() {
    return (
        <>
            <Box component="span" sx={{ color: "#fff" }}>
                Bee
            </Box>
            <Box component="span" sx={{ color: "#2eff7b" }}>
                PM
            </Box>
        </>
    )
}
