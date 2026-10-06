import { Alert, Box } from "@mui/material"

/** An error message with its list of problems (e.g. everything wrong with a package). */
export default function ErrorAlert({ error, problems, severity = "error", action, sx }) {
    if (!error && !problems?.length) return null
    return (
        <Alert severity={severity} action={action} sx={{ textAlign: "left", ...sx }}>
            {error && <Box sx={{ whiteSpace: "pre-line" }}>{error}</Box>}
            {problems?.length > 0 && (
                <Box component="ul" sx={{ m: 0, mt: error ? 0.75 : 0, pl: 2.5 }}>
                    {problems.map((problem, i) => (
                        <li key={i}>{problem}</li>
                    ))}
                </Box>
            )}
        </Alert>
    )
}
