import { createContext, useContext } from 'react'

/** Explicit editor navigation within one workbench, preserving its saved view. */
export const EditorNavigationContext = createContext<() => void>(() => {})
export const useShowEditor = () => useContext(EditorNavigationContext)
