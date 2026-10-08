import { useEffect, useState } from "react"
import {
    Box,
    IconButton,
    InputAdornment,
    MenuItem,
    TextField,
    Tooltip,
    Typography,
} from "@mui/material"
import RefreshIcon from "@mui/icons-material/Refresh"
import SearchIcon from "@mui/icons-material/Search"
import { CONTENT_KINDS, contentLabel } from "@beepm/core/kinds"
import ConfirmDialog from "./components/ConfirmDialog.jsx"
import InstallDialog from "./components/InstallDialog.jsx"
import LoginDialog from "./components/LoginDialog.jsx"
import PackageDetails from "./components/PackageDetails.jsx"
import ReviewDialog from "./components/ReviewDialog.jsx"
import Sidebar from "./components/Sidebar.jsx"
import Toasts from "./components/Toasts.jsx"
import AppProvider from "./state/AppProvider.jsx"
import { useApp } from "./state/context.js"
import BrowseView from "./views/BrowseView.jsx"
import InstalledView from "./views/InstalledView.jsx"
import PublishView from "./views/PublishView.jsx"
import SettingsView from "./views/SettingsView.jsx"

const TITLES = {
    browse: "Browse Packages",
    installed: "Installed Packages",
    publish: "Publish Package",
    settings: "Settings",
}
const VIEWS = Object.keys(TITLES)
const SEARCHABLE = new Set(["browse", "installed"])

function Shell() {
    const app = useApp()
    const [view, setView] = useState("browse")
    // Views stay mounted after their first visit, so they keep their state (and scroll position)
    const [visited, setVisited] = useState(() => new Set(["browse"]))
    const [search, setSearch] = useState({ browse: "", installed: "" })
    const [kind, setKind] = useState("") // Browse: what to search in packages ("" for everything)
    const [reloadKey, setReloadKey] = useState(0)
    const [refreshing, setRefreshing] = useState(false)

    const navigate = (id) => {
        setView(id)
        setVisited((current) => (current.has(id) ? current : new Set(current).add(id)))
    }

    // beepm://publish?file=... opens Publish
    const { publishRequest, viewRequest } = app
    useEffect(() => {
        if (!publishRequest) return
        setView("publish")
        setVisited((current) =>
            current.has("publish") ? current : new Set(current).add("publish"),
        )
    }, [publishRequest])

    // app.goTo(view) opens a view from anywhere (e.g. Import, after hooking BEE2)
    useEffect(() => {
        const id = viewRequest?.view
        if (!id) return
        setView(id)
        setVisited((current) => (current.has(id) ? current : new Set(current).add(id)))
    }, [viewRequest])

    async function refresh() {
        setRefreshing(true)
        setReloadKey((key) => key + 1)
        await Promise.all([app.refreshAuth(), app.refreshBee2(), app.refreshInstalled()])
        setRefreshing(false)
    }

    const render = (id) => {
        switch (id) {
            case "browse":
                return (
                    <BrowseView
                        query={search.browse}
                        kind={kind}
                        reloadKey={reloadKey}
                        onNavigate={navigate}
                    />
                )
            case "installed":
                return <InstalledView query={search.installed} onNavigate={navigate} />
            case "publish":
                return <PublishView />
            default:
                return <SettingsView />
        }
    }

    return (
        <Box sx={{ display: "flex", height: "100vh" }}>
            <Sidebar view={view} onNavigate={navigate} />

            <Box
                component="main"
                sx={{ flex: 1, display: "flex", flexDirection: "column", minWidth: 0 }}
            >
                <Box
                    sx={{
                        px: 2.5,
                        height: 56,
                        flexShrink: 0,
                        borderBottom: "1px solid #3a3a3a",
                        display: "flex",
                        alignItems: "center",
                        gap: 2,
                    }}
                >
                    <Typography variant="h6" sx={{ fontWeight: 600 }}>
                        {TITLES[view]}
                    </Typography>
                    <Box sx={{ flex: 1 }} />
                    {view === "browse" && (
                        <TextField
                            select
                            size="small"
                            value={kind}
                            onChange={(event) => setKind(event.target.value)}
                            aria-label="What to search for"
                            sx={{ width: 150 }}
                            slotProps={{ select: { displayEmpty: true } }}
                        >
                            <MenuItem value="">Everything</MenuItem>
                            {CONTENT_KINDS.map((k) => (
                                <MenuItem key={k.kind} value={k.kind}>
                                    {k.label}
                                </MenuItem>
                            ))}
                        </TextField>
                    )}
                    {SEARCHABLE.has(view) && (
                        <TextField
                            size="small"
                            placeholder={
                                view !== "browse"
                                    ? "Filter installed…"
                                    : kind
                                      ? `Search ${contentLabel(kind).toLowerCase()}…`
                                      : "Search the registry…"
                            }
                            value={search[view]}
                            onChange={(event) =>
                                setSearch((current) => ({ ...current, [view]: event.target.value }))
                            }
                            sx={{ width: 260 }}
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
                    <Tooltip title="Refresh">
                        <span>
                            <IconButton
                                onClick={refresh}
                                disabled={refreshing}
                                size="small"
                                aria-label="Refresh"
                            >
                                <RefreshIcon />
                            </IconButton>
                        </span>
                    </Tooltip>
                </Box>

                <Box sx={{ flex: 1, position: "relative", minHeight: 0 }}>
                    {VIEWS.filter((id) => visited.has(id)).map((id) => (
                        <Box
                            key={id}
                            sx={{
                                position: "absolute",
                                inset: 0,
                                overflow: "auto",
                                p: 2,
                                display: view === id ? "block" : "none",
                            }}
                        >
                            {render(id)}
                        </Box>
                    ))}
                </Box>
            </Box>

            <LoginDialog />
            <InstallDialog />
            <PackageDetails />
            <ConfirmDialog />
            <ReviewDialog />
            <Toasts />
        </Box>
    )
}

export default function App() {
    return (
        <AppProvider>
            <Shell />
        </AppProvider>
    )
}
