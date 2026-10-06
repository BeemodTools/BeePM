import { useEffect, useState } from "react"
import { Alert, Box, Button, CircularProgress, Typography } from "@mui/material"
import ExploreIcon from "@mui/icons-material/Explore"
import { api } from "../api.js"
import EmptyState from "../components/EmptyState.jsx"
import ErrorAlert from "../components/ErrorAlert.jsx"
import PackageCard from "../components/PackageCard.jsx"
import { useApp } from "../state/context.js"

/** Registry search (on the server, as you type). */
export default function BrowseView({ query, reloadKey, onNavigate }) {
    const { registryVersion, bee2 } = useApp()
    const [results, setResults] = useState({ loading: true, packages: [], total: 0, error: null })
    const [retry, setRetry] = useState(0)
    const q = query.trim()

    useEffect(() => {
        let cancelled = false
        setResults((current) => ({ ...current, loading: true }))
        const timer = setTimeout(
            async () => {
                const res = await api.registry.search(q)
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
    }, [q, reloadKey, registryVersion, retry])

    const { loading, packages, total, error } = results

    return (
        <Box sx={{ display: "flex", flexDirection: "column", gap: 1 }}>
            {bee2 && !bee2.error && !bee2.bee2?.version && (
                <Alert
                    severity="info"
                    sx={{ mb: 1 }}
                    action={
                        <Button color="inherit" size="small" onClick={() => onNavigate("settings")}>
                            Set up BEE2
                        </Button>
                    }
                >
                    BeePM doesn't know your BEE2 version yet, so it can't tell which packages work
                    with it.
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
                        q
                            ? `Nothing matches "${q}". Try another search.`
                            : "The registry has no packages yet."
                    }
                />
            ) : (
                <>
                    <Box sx={{ display: "flex", alignItems: "center", gap: 1, mb: 0.5 }}>
                        <Typography variant="subtitle2" sx={{ color: "#888" }}>
                            {q
                                ? `${total} result${total === 1 ? "" : "s"}`
                                : `${total} package${total === 1 ? "" : "s"}`}
                        </Typography>
                        {loading && <CircularProgress size={14} />}
                    </Box>
                    {packages.map((pkg) => (
                        <PackageCard key={pkg.name} pkg={pkg} />
                    ))}
                    {total > packages.length && (
                        <Typography
                            variant="body2"
                            sx={{ color: "#777", textAlign: "center", py: 2 }}
                        >
                            Showing the first {packages.length}. Search to narrow it down.
                        </Typography>
                    )}
                </>
            )}
        </Box>
    )
}
