import { useEffect, useState } from "react"
import {
    Box,
    Button,
    Chip,
    CircularProgress,
    InputAdornment,
    Link,
    TextField,
    Tooltip,
    Typography,
} from "@mui/material"
import CategoryIcon from "@mui/icons-material/Category"
import CloudIcon from "@mui/icons-material/Cloud"
import ElevatorIcon from "@mui/icons-material/Elevator"
import MusicNoteIcon from "@mui/icons-material/MusicNote"
import PaletteIcon from "@mui/icons-material/Palette"
import PersonIcon from "@mui/icons-material/Person"
import RecordVoiceOverIcon from "@mui/icons-material/RecordVoiceOver"
import SearchIcon from "@mui/icons-material/Search"
import SignpostIcon from "@mui/icons-material/Signpost"
import TuneIcon from "@mui/icons-material/Tune"
import { CONTENT_KINDS, contentCount, contentOne } from "@beepm/core/kinds"
import { api } from "../api.js"

/**
 * What's in packages (the registry reads it from their files): counts and search matches on
 * search results, and the full list in package details.
 */

const KIND_ICONS = {
    item: CategoryIcon,
    style: PaletteIcon,
    music: MusicNoteIcon,
    signage: SignpostIcon,
    voice: RecordVoiceOverIcon,
    skybox: CloudIcon,
    elevator: ElevatorIcon,
    stylevar: TuneIcon,
    playermodel: PersonIcon,
}
const SHOWN_AT_FIRST = 39 // tiles of one kind before "+N" shows the rest
const TILE = 72 // px
const smallChip = { height: 22, fontSize: 12 }

/** How many of each kind the latest version has: an icon and a number each. */
export function ContentCounts({ counts }) {
    const kinds = CONTENT_KINDS.filter((k) => counts?.[k.kind])
    if (!kinds.length) return null
    return kinds.map(({ kind }) => {
        const Icon = KIND_ICONS[kind]
        return (
            <Tooltip key={kind} title={contentCount(kind, counts[kind])}>
                <Box component="span" sx={{ display: "flex", alignItems: "center", gap: 0.5 }}>
                    <Icon sx={{ fontSize: 14 }} />
                    {counts[kind]}
                </Box>
            </Tooltip>
        )
    })
}

/** What in a search result matched the search: "Item: Laser Relay", and how many more. */
export function FoundChips({ found }) {
    if (!found?.matches.length) return null
    const more = found.count - found.matches.length
    return (
        <Box sx={{ display: "flex", alignItems: "center", gap: 0.5, flexWrap: "wrap", mt: 0.75 }}>
            {found.matches.map((match) => {
                const Icon = KIND_ICONS[match.kind]
                return (
                    <Chip
                        key={`${match.kind}:${match.name}`}
                        size="small"
                        variant="outlined"
                        color="primary"
                        icon={Icon ? <Icon sx={{ fontSize: 14 }} /> : undefined}
                        label={`${contentOne(match.kind)}: ${match.name}`}
                        sx={smallChip}
                    />
                )
            })}
            {more > 0 && (
                <Typography component="span" sx={{ fontSize: 12, color: "#888", ml: 0.5 }}>
                    +{more} more
                </Typography>
            )}
        </Box>
    )
}

// BEE2's descriptions use a little Markdown: **bold**, __bold__, "* " lists
const plainText = (text) =>
    text
        .replace(/(\*\*|__)(.+?)\1/g, "$2")
        .replace(/^\s*[*-] /gm, "• ")
        .trim()

/** What the hover over a tile shows: the name, what it is and who made it, its description. */
function TileInfo({ object }) {
    return (
        <Box sx={{ py: 0.25 }}>
            <Typography sx={{ fontSize: 13, fontWeight: 600, color: "#fff" }}>
                {object.name}
            </Typography>
            <Typography sx={{ fontSize: 11, color: "#999" }}>
                {contentOne(object.kind)}
                {object.authors ? ` · by ${object.authors}` : ""}
            </Typography>
            {object.description && (
                <Typography
                    sx={{
                        fontSize: 12,
                        color: "#ccc",
                        mt: 0.75,
                        whiteSpace: "pre-line",
                        overflow: "hidden",
                        display: "-webkit-box",
                        WebkitLineClamp: 8,
                        WebkitBoxOrient: "vertical",
                    }}
                >
                    {plainText(object.description)}
                </Typography>
            )}
            {object.aliases.length > 0 && (
                <Typography sx={{ fontSize: 11, color: "#999", mt: 0.75 }}>
                    Also: {object.aliases.join(", ")}
                </Typography>
            )}
        </Box>
    )
}

/**
 * One thing in a package, like BEE2's palette (and BeePEE's browser): its icon in a tile, and
 * what it is when hovered. Without an icon, its kind and name.
 */
function ContentTile({ object }) {
    const [broken, setBroken] = useState(false)
    const Icon = KIND_ICONS[object.kind]
    const icon = object.icon && !broken
    return (
        <Tooltip
            title={<TileInfo object={object} />}
            placement="top"
            arrow
            slotProps={{
                tooltip: {
                    sx: {
                        maxWidth: 320,
                        backgroundColor: "#2a2d30",
                        border: "1px solid #444",
                        boxShadow: 4,
                        px: 1.5,
                        py: 1,
                    },
                },
                arrow: { sx: { color: "#2a2d30", "&::before": { border: "1px solid #444" } } },
            }}
        >
            <Box
                aria-label={object.name}
                sx={{
                    width: TILE,
                    height: TILE,
                    flexShrink: 0,
                    borderRadius: 1,
                    border: "1px solid #444",
                    backgroundColor: "#1f2122",
                    overflow: "hidden",
                    display: "flex",
                    flexDirection: "column",
                    alignItems: "center",
                    justifyContent: "center",
                    gap: 0.5,
                    transition: "border-color 0.15s, filter 0.15s",
                    "&:hover": { borderColor: "primary.main", filter: "brightness(1.15)" },
                }}
            >
                {icon ? (
                    <Box
                        component="img"
                        src={object.icon}
                        alt=""
                        loading="lazy"
                        onError={() => setBroken(true)}
                        sx={{ width: "100%", height: "100%", objectFit: "contain" }}
                    />
                ) : (
                    <>
                        <Icon sx={{ fontSize: 20, color: "#666" }} />
                        <Typography
                            sx={{
                                fontSize: 10.5,
                                lineHeight: 1.2,
                                color: "#aaa",
                                textAlign: "center",
                                px: 0.5,
                                overflow: "hidden",
                                display: "-webkit-box",
                                WebkitLineClamp: 2,
                                WebkitBoxOrient: "vertical",
                                overflowWrap: "anywhere",
                            }}
                        >
                            {object.name}
                        </Typography>
                    </>
                )}
            </Box>
        </Tooltip>
    )
}

/** One kind's tiles, the first SHOWN_AT_FIRST until "+N" (all of them with showAll). */
function KindList({ kind, objects, showAll = false }) {
    const [more, setMore] = useState(false)
    const all = showAll || more
    const Icon = KIND_ICONS[kind.kind]
    const shown = all ? objects : objects.slice(0, SHOWN_AT_FIRST)
    return (
        <Box sx={{ mb: 2 }}>
            <Box sx={{ display: "flex", alignItems: "center", gap: 0.75, mb: 1, color: "#aaa" }}>
                <Icon sx={{ fontSize: 16 }} />
                <Typography sx={{ fontSize: 13, color: "#ccc", fontWeight: 600 }}>
                    {kind.label}
                </Typography>
                <Typography sx={{ fontSize: 13, color: "#777" }}>{objects.length}</Typography>
            </Box>
            <Box sx={{ display: "flex", gap: 1, flexWrap: "wrap" }}>
                {shown.map((object) => (
                    <ContentTile key={object.id} object={object} />
                ))}
                {objects.length > shown.length && (
                    <Button
                        onClick={() => setMore(true)}
                        sx={{
                            width: TILE,
                            height: TILE,
                            border: "1px dashed #444",
                            borderRadius: 1,
                        }}
                    >
                        +{objects.length - shown.length}
                    </Button>
                )}
            </Box>
        </Box>
    )
}

/**
 * Package details: "View contents", which opens what the latest version contains in a window of
 * its own (ContentsWindow). Not shown until the registry has found something in it.
 */
export function ContentsLink({ name, version, title, counts }) {
    if (!CONTENT_KINDS.some((k) => counts?.[k.kind])) return null
    return (
        <Box sx={{ mt: 1.5 }}>
            <Link
                component="button"
                underline="hover"
                onClick={() => api.app.openContents(name, version, title)}
                sx={{ fontSize: 14 }}
            >
                View contents
            </Link>
        </Box>
    )
}

/**
 * "View contents" (backend/main.js showContents): everything in a version, how many of each
 * kind, and each one as a tile that says what it is when hovered. A box finds things by name.
 */
export function ContentsWindow({ name, version, title }) {
    const [state, setState] = useState({ loading: true })
    const [find, setFind] = useState("")

    useEffect(() => {
        let cancelled = false
        api.registry.contents(name, version).then((res) => {
            if (!cancelled) setState({ loading: false, ...res })
        })
        return () => {
            cancelled = true
        }
    }, [name, version])

    const objects = state.contents ?? []
    const q = find.trim().toLowerCase()
    const found = q
        ? objects.filter((o) => [o.name, ...o.aliases].some((n) => n.toLowerCase().includes(q)))
        : objects
    const kinds = CONTENT_KINDS.filter((k) => objects.some((o) => o.kind === k.kind))

    let body
    if (state.loading) {
        body = <CircularProgress size={20} />
    } else if (!state.ok) {
        body = <Typography sx={{ color: "#888" }}>Couldn't load it: {state.error}</Typography>
    } else if (!state.read) {
        body = (
            <Typography sx={{ color: "#888" }}>
                BeePM hasn't looked inside this version yet. Check again in a few minutes.
            </Typography>
        )
    } else if (state.error) {
        body = (
            <Typography sx={{ color: "#888" }}>
                BeePM couldn't look inside it: {state.error}
            </Typography>
        )
    } else if (!objects.length) {
        body = (
            <Typography sx={{ color: "#888" }}>
                No items, styles, music or other things to pick in BEE2.
            </Typography>
        )
    } else if (!found.length) {
        body = <Typography sx={{ color: "#888" }}>Nothing here is called that.</Typography>
    } else {
        body = kinds.map((kind) => {
            const ofKind = found.filter((o) => o.kind === kind.kind)
            return ofKind.length ? (
                <KindList key={kind.kind} kind={kind} objects={ofKind} showAll={Boolean(q)} />
            ) : null
        })
    }

    return (
        <Box
            sx={{
                height: "100vh",
                display: "flex",
                flexDirection: "column",
                backgroundColor: "#1d1e1f",
            }}
        >
            <Box sx={{ px: 3, pt: 2.5, pb: 2, borderBottom: "1px solid #3a3a3a" }}>
                <Typography variant="h6" sx={{ fontWeight: 600, color: "#fff", lineHeight: 1.3 }}>
                    {title || name}
                </Typography>
                <Typography sx={{ fontFamily: "monospace", fontSize: 13, color: "#888" }}>
                    {name} {version}
                </Typography>
                {kinds.length > 0 && (
                    <Box
                        sx={{
                            display: "grid",
                            gridTemplateColumns: "repeat(auto-fill, minmax(110px, 1fr))",
                            gap: 1.5,
                            mt: 2,
                            p: 1.5,
                            borderRadius: 1,
                            backgroundColor: "#1f2122",
                            border: "1px solid #333",
                        }}
                    >
                        {kinds.map((kind) => {
                            const Icon = KIND_ICONS[kind.kind]
                            return (
                                <Box key={kind.kind}>
                                    <Box
                                        sx={{
                                            display: "flex",
                                            alignItems: "center",
                                            gap: 0.5,
                                            fontSize: 11,
                                            color: "#777",
                                            textTransform: "uppercase",
                                            letterSpacing: 0.5,
                                        }}
                                    >
                                        <Icon sx={{ fontSize: 13 }} />
                                        {kind.label}
                                    </Box>
                                    <Typography sx={{ color: "#ddd", fontSize: 18 }}>
                                        {objects.filter((o) => o.kind === kind.kind).length}
                                    </Typography>
                                </Box>
                            )
                        })}
                    </Box>
                )}
                {objects.length > 0 && (
                    <TextField
                        size="small"
                        placeholder="Find an item, song, sign…"
                        value={find}
                        onChange={(event) => setFind(event.target.value)}
                        fullWidth
                        sx={{ mt: 2 }}
                        slotProps={{
                            input: {
                                startAdornment: (
                                    <InputAdornment position="start">
                                        <SearchIcon sx={{ color: "#666", fontSize: 20 }} />
                                    </InputAdornment>
                                ),
                            },
                        }}
                    />
                )}
            </Box>
            <Box sx={{ flex: 1, overflowY: "auto", px: 3, py: 2 }}>{body}</Box>
        </Box>
    )
}
