/**
 * The admin surface URL: `/admin?screen=<AppScreen>&settings=<SettingsSection>`.
 *
 * One pathname prefix is the whole boundary. The prefix decides *which surface*
 * (and therefore which gate and which nav); the query names the destination
 * inside it. `/admin` is staff-only (PlatformRole `admin` + `super_admin`);
 * every other screen, including the workbench, stays on `/`.
 *
 * Pure and React-free: parsing, validation and search rewriting are testable
 * without a DOM. `window.location` stays with the shell that owns navigation.
 */
import { addressableScreens, ADMIN_URL_ONLY_SCREENS, NAVIGATION, staffNavModes, type NavAudience } from "./app-navigation"
import type { AppScreen } from "./app-screens"
import { isSettingsSection, type SettingsSection } from "./settings-sections"

export const ADMIN_SURFACE_PATH = "/admin"

/**
 * `/admin`, `/admin/` and any deeper `/admin/…` are the same surface. Extra
 * path segments are not part of the vocabulary yet — the query is the
 * destination — but they must not fall through to the public site either.
 */
export function isAdminPath(pathname: string): boolean {
  const path = pathname.replace(/\/+$/, "") || "/"
  return path === ADMIN_SURFACE_PATH || path.startsWith(`${ADMIN_SURFACE_PATH}/`)
}

// No rank supplied means the least-privileged staff set, never super_admin.
const STAFF_AUDIENCE: NavAudience = { isStaff: true, isAgent: false }

/** Rank-filtered URL membership is the same list the platform nav paints. */
export function adminScreens(audience: NavAudience = STAFF_AUDIENCE): AppScreen[] {
  return addressableScreens("admin", audience)
}

/** The screen `/admin` opens when the URL names nothing — or nothing it may. */
export function defaultAdminScreen(audience: NavAudience = STAFF_AUDIENCE): AppScreen {
  return adminScreens(audience)[0] ?? "supplier-dbs"
}

/** `?screen=` under `/admin`: a staff screen, else the surface's default. */
export function adminScreenFromSearch(search: string, audience: NavAudience = STAFF_AUDIENCE): AppScreen {
  const raw = new URLSearchParams(search).get("screen")
  return (
    adminScreens(audience).find((candidate) => candidate === raw) ?? defaultAdminScreen(audience)
  )
}

/** `?settings=`: a known section id, else nothing to open. */
export function settingsFromSearch(search: string): SettingsSection | undefined {
  const raw = new URLSearchParams(search).get("settings")
  return raw !== null && isSettingsSection(raw) ? raw : undefined
}

function searchString(params: URLSearchParams): string {
  const query = params.toString()
  return query ? `?${query}` : ""
}

/** Query keys every surface may keep: the destination, an invite claim, the admin sheet. */
const SHARED_QUERY_KEYS = ["screen", "invite", "settings"] as const

/**
 * Query keys one screen owns. A shell jump keeps these plus the shared keys;
 * everything else is leftover from the previous pane.
 */
const SCREEN_QUERY_KEYS: Partial<Record<AppScreen, readonly string[]>> = {
  catalog: ["product", "db", "cat", "pmin", "pmax", "q", "tags", "pick"],
  listing: ["cardId"],
  "supplier-dbs": ["open"],
  "supplier-accounts": ["open"],
  "admin-delegate-orders": ["order"],
  "admin-console": ["workspaceId", "storeId"],
  "admin-products": ["workspaceId", "storeId"],
}

/** Drop keys the painted screen does not own. Drill-in state of that screen stays. */
export function withoutForeignSearch(search: string, screen: AppScreen): string {
  const owned = new Set<string>([...SHARED_QUERY_KEYS, ...(SCREEN_QUERY_KEYS[screen] ?? [])])
  const kept = new URLSearchParams()
  for (const [key, value] of new URLSearchParams(search)) {
    if (owned.has(key)) kept.append(key, value)
  }
  return searchString(kept)
}

/**
 * Rewrite `screen` and drop foreign module params. Catalog's in-module product
 * drill (`product=`) does not survive a shell jump — returning to 平台货源
 * must land on the gallery, not the last detail. `cardId` is 批量上架's own
 * drill: it survives a jump only when another screen's address already carried
 * it (the header progress chip — an injection a caller made on purpose).
 * Leaving 批量上架 or clicking its nav item again drops it, so a nav jump
 * lands on the card library, not the last runner.
 */
export function withScreen(search: string, screen: AppScreen): string {
  const params = new URLSearchParams(withoutForeignSearch(search, screen))
  const from = params.get("screen")
  params.set("screen", screen)
  params.delete("product")
  if (from === "listing") params.delete("cardId")
  return searchString(params)
}

/**
 * Whether the admin surface addresses this screen itself. It does not: the
 * workbench is another surface with its own address, so a request for one of
 * its screens navigates there instead of repainting `/admin`.
 */
export function isAdminScreen(screen: AppScreen): boolean {
  return staffNavModes().some((mode) => NAVIGATION[mode].items.some((item) => item.id === screen)) ||
    ADMIN_URL_ONLY_SCREENS.some((id) => id === screen)
}

/** Open the sheet at `section`; every other parameter keeps its place. */
export function withSettings(search: string, section: SettingsSection): string {
  const params = new URLSearchParams(search)
  params.set("settings", section)
  return searchString(params)
}

/** Close the sheet without touching the screen the URL names. */
export function withoutSettings(search: string): string {
  const params = new URLSearchParams(search)
  params.delete("settings")
  return searchString(params)
}
