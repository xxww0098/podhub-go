import { useCallback, useEffect, useState } from "react"

/**
 * Theme is a product constraint, not a preference toy: batches run late, beside
 * a dark Photoshop, and both themes are held to the same finish. `system`
 * follows the OS so the client matches the rest of the desktop.
 */
export type ThemePreference = "system" | "light" | "dark"

const STORAGE_KEY = "podhub.theme"

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

/** Called before the first paint so the window never flashes the wrong theme. */
export function initTheme() {
  paint(readThemePreference())
}

export function useTheme() {
  const [preference, setPreference] = useState<ThemePreference>(readThemePreference)

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

  const update = useCallback((next: ThemePreference) => {
    setPreference(next)
    try {
      window.localStorage.setItem(STORAGE_KEY, next)
    } catch {
      /* a locked-down profile still gets a working theme for this session */
    }
  }, [])

  return { preference, resolved: resolveTheme(preference), setPreference: update }
}
