/**
 * The route table: one pure function turns "what the address says" plus "who
 * the caller is" into the single surface, screen and sheet a render may paint.
 *
 * React-free and DOM-free on purpose — the shell owns `window.location`, and
 * every guard is a branch below, so the decision is testable in Node and the
 * painted screen can never drift from the address that names it.
 */
import {
  adminScreenFromSearch,
  isAdminPath,
  settingsFromSearch,
} from "./admin-surface"
import { addressableScreens, defaultScreenFor } from "./app-navigation"
import type { AppScreen } from "./app-screens"
import { isPlatformStaffRole, isPlatformSuperAdminRole } from "./platform-role"
import { pageFromPath, type PageKey } from "./public-pages"
import type { SettingsSection } from "./settings-sections"

/** What the caller's standing allows, in the terms the guards ask about. */
export type RouteAudience = {
  authenticated: boolean
  isStaff: boolean
  isSuperAdmin?: boolean
  isAgent: boolean
  /** Workspace standing: an unaffiliated account may not enter the workbench. */
  hasWorkspace: boolean
}

/** The part of the address a route can be resolved from. */
export type RouteAddress = { pathname: string; search: string }

export type AppRoute =
  | { kind: "login" }
  | { kind: "public"; page: PageKey }
  | { kind: "workbench"; screen: AppScreen }
  | { kind: "admin"; screen: AppScreen; settings: SettingsSection | null }
  | { kind: "admin-denied" }
  | { kind: "workspace-required" }

/**
 * The session snapshot, read once per render. Only PlatformRole `super_admin`
 * escapes Workspace standing, which is how Cloud's overview defines it: an
 * account with no Workspace is `unaffiliated` unless it is the operator.
 */
export function routeAudienceFor(input: {
  authenticated: boolean
  role?: string | null
  accountMode?: string | null
  isAgent?: boolean
}): RouteAudience {
  return {
    authenticated: input.authenticated,
    isStaff: input.authenticated && isPlatformStaffRole(input.role),
    isSuperAdmin: input.authenticated && isPlatformSuperAdminRole(input.role),
    isAgent: input.isAgent === true,
    hasWorkspace:
      input.authenticated &&
      (input.accountMode !== "unaffiliated" || isPlatformSuperAdminRole(input.role)),
  }
}

/**
 * The ordered guard list. The order is the contract:
 *
 * 1. Session — an anonymous caller gets a public page or the login screen.
 *    `/admin…` resolves to login, so a staff address survives sign-in.
 * 2. Admin refusal — a non-staff caller is told the URL is not theirs instead
 *    of being painted a shell they may not use.
 * 3. Admin surface — `/admin` addresses admin screens only. Workspace standing
 *    does not apply: the URL is the boundary, not the account's Workspace.
 * 4. Public — a signed-in caller may still read the public pages.
 * 5. Workbench landing — `/`, `/login`, `/register` and the unmatched catch-all
 *    are the workbench once there is a session: the homepage address is the
 *    front door, not a marketing page to re-enter.
 * 6. Workspace — without standing the workbench cannot be entered.
 * 7. Screen — `?screen=` is honoured only when this audience may address it;
 *    anything else lands on the surface's first screen. A staff-only or
 *    Agent-only module is therefore unreachable by URL for the wrong account,
 *    which is the difference between a painted nav and a real guard.
 */
export function resolveRoute(address: RouteAddress, audience: RouteAudience): AppRoute {
  if (!audience.authenticated) {
    const page = pageFromPath(address.pathname)
    return page === "login" ? { kind: "login" } : { kind: "public", page }
  }

  if (isAdminPath(address.pathname)) {
    if (!audience.isStaff) return { kind: "admin-denied" }
    return {
      kind: "admin",
      screen: adminScreenFromSearch(address.search, audience),
      // A known `settings` id this rank may not open still reaches the sheet,
      // which refuses it by name; an unknown id opens nothing at all.
      settings: settingsFromSearch(address.search) ?? null,
    }
  }

  const page = pageFromPath(address.pathname)
  // `product` is `/` and the catch-all path: for a signed-in caller that
  // address is the workbench, never the marketing page.
  if (page !== "product" && page !== "login") {
    return { kind: "public", page }
  }

  if (!audience.hasWorkspace) return { kind: "workspace-required" }

  const requested = new URLSearchParams(address.search).get("screen")
  return {
    kind: "workbench",
    screen:
      addressableScreens("workbench", audience).find((id) => id === requested) ??
      defaultScreenFor("workbench", audience),
  }
}
