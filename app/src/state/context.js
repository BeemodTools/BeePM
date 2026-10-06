import { createContext, useContext } from "react"

export const AppContext = createContext(null)

/** Shared state and actions (see AppProvider.jsx). */
export const useApp = () => useContext(AppContext)
