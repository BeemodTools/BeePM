import { Box, Typography, Card, Button } from "@mui/material"

function ConsoleView({ consoleLog, setConsoleLog }) {
    return (
        <Box>
            <Typography variant="subtitle2" sx={{ mb: 2, color: "#888" }}>
                CLI OUTPUT
            </Typography>
            <Card variant="outlined" sx={{ backgroundColor: "#1a1b1c", border: "1px solid #3a3a3a" }}>
                <Box
                    sx={{
                        p: 2,
                        fontFamily: "monospace",
                        fontSize: 12,
                        minHeight: 400,
                        maxHeight: 600,
                        overflow: "auto",
                    }}
                >
                    {consoleLog.length === 0 ? (
                        <Typography variant="body2" sx={{ color: "#666", fontStyle: "italic" }}>
                            No commands executed yet. Use hook/unhook in Settings to see output here.
                        </Typography>
                    ) : (
                        consoleLog.map((entry, i) => (
                            <Box key={i} sx={{ mb: 2 }}>
                                <Typography
                                    component="div"
                                    sx={{ color: "#888", fontSize: 10, mb: 0.5 }}
                                >
                                    [{entry.timestamp}]
                                </Typography>
                                <Typography
                                    component="div"
                                    sx={{ color: "#2eff7b", fontWeight: 500 }}
                                >
                                    $ {entry.command}
                                </Typography>
                                <Typography
                                    component="div"
                                    sx={{
                                        color: entry.success ? "#aaa" : "#ff6b6b",
                                        whiteSpace: "pre-wrap",
                                        mt: 0.5,
                                    }}
                                >
                                    {entry.output}
                                </Typography>
                            </Box>
                        ))
                    )}
                </Box>
            </Card>
            {consoleLog.length > 0 && (
                <Button
                    size="small"
                    sx={{ mt: 1 }}
                    onClick={() => setConsoleLog([])}
                >
                    Clear Log
                </Button>
            )}
        </Box>
    )
}

export default ConsoleView
