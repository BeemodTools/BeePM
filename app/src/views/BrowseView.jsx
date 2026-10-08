import { useEffect, useState } from "react"
import {
    Alert,
    Box,
    Button,
    ButtonBase,
    CircularProgress,
    Collapse,
    Typography,
} from "@mui/material"
import ExpandMoreIcon from "@mui/icons-material/ExpandMore"
import ExploreIcon from "@mui/icons-material/Explore"
import { contentLabel } from "@beepm/core/kinds"
import { api } from "../api.js"
import EmptyState from "../components/EmptyState.jsx"
import ErrorAlert from "../components/ErrorAlert.jsx"
import PackageCard from "../components/PackageCard.jsx"
import { useApp } from "../state/context.js"

/**
 * Registry search (on the server, as you type), also by what's in packages; kind: only packages
 * with that kind of thing in them (items, music...), named like the search.
 */
export default function BrowseView({ query, kind = "", reloadKey, onNavigate }) {
    const { registryVersion, bee2 } = useApp()
    const [results, setResults] = useState({ loading: true, packages: [], total: 0, error: null })
    const [retry, setRetry] = useState(0)
    const [showRemoved, setShowRemoved] = useState(false)
    const q = query.trim()

    useEffect(() => {
        let cancelled = false
        setResults((current) => ({ ...current, loading: true }))
        const timer = setTimeout(
            async () => {
                const res = await api.registry.search(q, { kind: kind || undefined })
                if (cancelled) return
                setResults(
                    res.ok
                        ? { loading: false, packages: res.packages, total: res.total, error: null }
                        : {
                              loading: false,
                              packages: [],
                              total: 0,
                              error: res.error,
                              offline: res.offline,
                          },
                )
            },
            q ? 300 : 0,
        )
        return () => {
            cancelled = true
            clearTimeout(timer)
        }
    }, [q, kind, reloadKey, registryVersion, retry])

    const { loading, packages, error } = results
    // Removed packages (only admins get them) go in their own section at the bottom, closed
    const live = packages.filter((pkg) => !pkg.removed)
    const removed = packages.filter((pkg) => pkg.removed)
    const total = results.total - removed.length

    return (
        <Box sx={{ display: "flex", flexDirection: "column", gap: 1 }}>
            {bee2 && !bee2.error && !bee2.dir && (
                <Alert
                    severity="warning"
                    sx={{ mb: 1 }}
                    action={
                        <Button color="inherit" size="small" onClick={() => onNavigate("settings")}>
                            Settings
                        </Button>
                    }
                >
                    Choose where BEE2 is installed to install packages.
                </Alert>
            )}
            {bee2?.dir && bee2.found !== false && !bee2.version && (
                <Alert severity="info" sx={{ mb: 1 }}>
                    Open BEE2 once so BeePM knows its version and which packages work with it.
                </Alert>
            )}

            {error ? (
                <ErrorAlert
                    error={
                        results.offline
                            ? "Can't reach the BeePM registry. Check your internet connection."
                            : error
                    }
                    action={
                        <Button color="inherit" size="small" onClick={() => setRetry((n) => n + 1)}>
                            Retry
                        </Button>
                    }
                />
            ) : loading && !packages.length ? (
                <Box sx={{ display: "flex", justifyContent: "center", py: 10 }}>
                    <CircularProgress />
                </Box>
            ) : !packages.length ? (
                <EmptyState
                    icon={ExploreIcon}
                    title="No packages found"
                    text={
                        kind
                            ? `No packages have ${contentLabel(kind).toLowerCase()}${q ? ` matching "${q}"` : ""}.`
                            : q
                              ? `Nothing matches "${q}". Try another search.`
                              : "The registry has no packages yet."
                    }
                />
            ) : (
                <>
                    <Box sx={{ display: "flex", alignItems: "center", gap: 1, mb: 0.5 }}>
                        <Typography variant="subtitle2" sx={{ color: "#888" }}>
                            {q || kind
                                ? `${total} result${total === 1 ? "" : "s"}`
                                : `${total} package${total === 1 ? "" : "s"}`}
                        </Typography>
                        {loading && <CircularProgress size={14} />}
                    </Box>
                    {live.map((pkg) => (
                        <PackageCard key={pkg.name} pkg={pkg} />
                    ))}
                    {total > live.length && (
                        <Typography
                            variant="body2"
                            sx={{ color: "#777", textAlign: "center", py: 2 }}
                        >
                            Showing the first {live.length}. Search to narrow it down.
                        </Typography>
                    )}
                    {removed.length > 0 && (
                        <>
                            <ButtonBase
                                onClick={() => setShowRemoved((open) => !open)}
                                aria-expanded={showRemoved}
                                sx={{
                                    alignSelf: "flex-start",
                                    gap: 0.5,
                                    mt: 2,
                                    mb: 0.5,
                                    px: 0.5,
                                    borderRadius: 1,
                                    color: "#888",
                                }}
                            >
                                <Typography variant="subtitle2">
                                    {removed.length} removed
                                </Typography>
                                <ExpandMoreIcon
                                    sx={{
                                        fontSize: 18,
                                        transform: showRemoved ? "rotate(180deg)" : "none",
                                        transition: "transform 0.15s",
                                    }}
                                />
                            </ButtonBase>
                            <Collapse in={showRemoved} unmountOnExit>
                                <Box sx={{ display: "flex", flexDirection: "column", gap: 1 }}>
                                    {removed.map((pkg) => (
                                        <PackageCard key={pkg.name} pkg={pkg} />
                                    ))}
                                </Box>
                            </Collapse>
                        </>
                    )}
                </>
            )}
        </Box>
    )
}
