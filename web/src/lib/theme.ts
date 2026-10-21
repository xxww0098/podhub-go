import { useEffect } from "react"
import { create } from "zustand"

/**
 * Theme is a product constraint, not a preference toy: batches run late, beside
 * a dark Photoshop, and both themes are held to the same finish. `system`
 * follows the OS so the client matches the rest of the desktop.
 *
 * One store, not a hook-local useState: the rail toggle and the settings
 * appearance pane have to move together.
 */
export type ThemePreference = "system" | "light" | "dark"

const STORAGE_KEY = "podhub.theme"

type ThemeState = {
  preference: ThemePreference
  setPreference: (next: ThemePreference) => void
}

function isPreference(value: unknown): value is ThemePreference {
  return value === "system" || value === "light" || value === "dark"
}

export function readThemePreference(): ThemePreference {
  if (typeof window === "undefined") return "system"
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY)
    return isPreference(stored) ? stored : "system"
  } catch {
    return "system"
  }
}

export function resolveTheme(preference: ThemePreference): "light" | "dark" {
  if (preference !== "system") return preference
  if (typeof window === "undefined") return "light"
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"
}

function paint(preference: ThemePreference) {
  if (typeof document === "undefined") return
  const resolved = resolveTheme(preference)
  document.documentElement.classList.toggle("dark", resolved === "dark")
  document.documentElement.dataset.theme = resolved
}

function persist(next: ThemePreference) {
  try {
    window.localStorage.setItem(STORAGE_KEY, next)
  } catch {
    /* a locked-down profile still gets a working theme for this session */
  }
}

const useThemeStore = create<ThemeState>((set) => ({
  preference: readThemePreference(),
  setPreference: (next) => {
    persist(next)
    paint(next)
    set({ preference: next })
  },
}))

/** Called before the first paint so the window never flashes the wrong theme. */
export function initTheme() {
  const preference = readThemePreference()
  useThemeStore.setState({ preference })
  paint(preference)
}

export function useTheme() {
  const preference = useThemeStore((state) => state.preference)
  const setPreference = useThemeStore((state) => state.setPreference)

  useEffect(() => {
    paint(preference)
  }, [preference])

  useEffect(() => {
    if (preference !== "system" || typeof window === "undefined") return
    const query = window.matchMedia("(prefers-color-scheme: dark)")
    const onChange = () => paint("system")
    query.addEventListener("change", onChange)
    return () => query.removeEventListener("change", onChange)
  }, [preference])

  return { preference, resolved: resolveTheme(preference), setPreference }
}
