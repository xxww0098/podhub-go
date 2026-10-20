/**
 * Rail width is an operator preference, not session state: whoever folds the
 * sidebar to win canvas back wants it folded the next time the page opens.
 *
 * shadcn's provider writes this to a cookie for a server to read back into the
 * first paint. This app renders the shell in the browser only, so that cookie
 * had no reader while riding along on every API call — and its week-long
 * max-age expired the choice. localStorage is where the other preferences live.
 */
const STORAGE_KEY = "podhub.sidebar-open"

/**
 * The remembered fold, or `fallback` when this browser has never chosen.
 *
 * Absent, unreadable or unparsable storage is not a choice, so it lands on the
 * fallback rather than on a guess: only an explicit "false" folds the rail, and
 * a corrupt value cannot strand someone in the icon rail.
 */
export function readSidebarOpen(fallback = true): boolean {
  if (typeof window === "undefined") return fallback
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY)
    return stored === null ? fallback : stored !== "false"
  } catch {
    return fallback
  }
}

export function writeSidebarOpen(open: boolean): void {
  if (typeof window === "undefined") return
  try {
    window.localStorage.setItem(STORAGE_KEY, open ? "true" : "false")
  } catch {
    /* a locked-down profile still gets a working rail for this session */
  }
}
