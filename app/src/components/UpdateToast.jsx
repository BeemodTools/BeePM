import { useEffect } from "react"
import { Box, Button, IconButton, Typography } from "@mui/material"
import CloseIcon from "@mui/icons-material/Close"
import { playChime } from "../lib/chime.js"
import Brand from "./Brand.jsx"

/**
 * What a corner question says, and its answers: [label, answer, style]. The first answer is
 * the main one; "quiet" ones go to the right. Closing the window is always "later".
 */
function question({ kind, name, from, to, count, folder, switching, version, text, by }) {
    switch (kind) {
        case "broken":
            return {
                title: `BEE2 couldn't load ${name}`,
                text: text || "Removing it lets BEE2 start.",
                answers: [
                    ["Remove it", "remove"],
                    ["Not now", "later"],
                ],
            }
        case "crashed":
            return {
                title: "BEE2 crashed",
                text: text || "Its log says why.",
                answers: [
                    ["Open its log", "log"],
                    ["Not now", "later"],
                ],
            }
        case "app-update":
            return {
                title: `BeePM ${version} is ready`,
                text: "Restart BeePM to finish updating.",
                answers: [
                    ["Restart", "restart"],
                    ["Later", "later"],
                ],
            }
        case "use-bee2":
            return {
                title: switching ? "Switch BeePM to this BEE2?" : "Use this BEE2 with BeePM?",
                text: folder,
                answers: [
                    [switching ? "Switch" : "Use it", "use"],
                    ["Not now", "later"],
                    ["Don't ask again", "never", "quiet"],
                ],
            }
        case "close":
            return {
                title: "Close BEE2 to finish?",
                text: "Save your work in BEE2 first.",
                answers: [
                    ["Close BEE2", "now"],
                    ["When I close it", "later"],
                ],
            }
        case "duplicates":
            return {
                title: "Duplicate packages in BEE2",
                text:
                    count === 1
                        ? "BEE2 can't load them together."
                        : `${count} clashes. BEE2 can't load these together.`,
                answers: [
                    ["Delete duplicates", "delete"],
                    ["Choose", "choose"],
                ],
            }
        case "adopt":
            return count > 1
                ? {
                      title: `${count} of your packages are on BeePM`,
                      text: "Use BeePM's versions? They get updates.",
                      answers: [
                          ["Use BeePM's", "use"],
                          ["Choose", "choose"],
                          ["Keep mine", "keep", "quiet"],
                      ],
                  }
                : {
                      title: `Use BeePM's ${name}?`,
                      text: `By @${by}. BeePM's gets updates.`,
                      answers: [
                          ["Use BeePM's", "use"],
                          ["Keep mine", "keep"],
                      ],
                  }
        default:
            return {
                title: `Update ${name}?`,
                text: `${from} → ${to}`,
                answers: [
                    ["Update", "update"],
                    ["Not now", "later"],
                    ["Don't ask again", "never", "quiet"],
                ],
            }
    }
}

/**
 * The small window in the bottom-right corner (backend/main.js ask): what BeePM asks about when
 * BEE2 opens (see backend/updateWatcher.js). It chimes when it appears. Closing it is "later".
 */
export default function UpdateToast(props) {
    const answer = (value) => window.beepm?.toast?.answer(value)
    const { title, text, answers } = question(props)
    useEffect(playChime, [])
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
                    aria-label="Later"
                    onClick={() => answer("later")}
                    sx={{ mr: -1, color: "#888" }}
                >
                    <CloseIcon fontSize="small" />
                </IconButton>
            </Box>
            <Typography noWrap sx={{ color: "#fff", fontWeight: 600, mt: 0.5 }}>
                {title}
            </Typography>
            <Typography variant="body2" noWrap title={text} sx={{ color: "#888" }}>
                {text}
            </Typography>
            <Box sx={{ display: "flex", gap: 1, mt: "auto" }}>
                {answers.map(([label, value, style], index) => (
                    <Button
                        key={value}
                        size="small"
                        variant={
                            style === "quiet" ? "text" : index === 0 ? "contained" : "outlined"
                        }
                        onClick={() => answer(value)}
                        sx={style === "quiet" ? { ml: "auto", color: "#888" } : undefined}
                    >
                        {label}
                    </Button>
                ))}
            </Box>
        </Box>
    )
}
