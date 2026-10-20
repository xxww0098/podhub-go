/**
 * The public site's address vocabulary: which pathnames are public pages and
 * which one is the way in.
 *
 * Pure and React-free. "Which addresses mean the workbench" is the route
 * resolver's ([app-route](./app-route.ts)) decision, which composes this table
 * with the audience; this module only names the pages.
 */
import { isAdminPath } from "./admin-surface"

export type PageKey = "product" | "catalog" | "pricing" | "help" | "privacy" | "terms"

/** The public pages, plus the login screen an unauthorised address resolves to. */
export type PublicPage = PageKey | "login"

const PUBLIC_PAGES: Partial<Record<string, PageKey>> = {
  "/catalog": "catalog",
  "/pricing": "pricing",
  "/help": "help",
  "/privacy": "privacy",
  "/terms": "terms",
}

/**
 * One spelling of the public address table.
 *
 * `/` and every unmatched path are the product page: the marketing homepage is
 * what an unknown address paints (a soft landing is deliberate — there is no
 * 404 route). `/login` and `/register` are the way in, and `/admin…` resolves to
 * the login screen for an anonymous caller so a staff address survives sign-in
 * instead of falling through to the marketing site.
 */
export function pageFromPath(pathname: string): PublicPage {
  const path = pathname.replace(/\/+$/, "") || "/"
  if (path === "/login" || path === "/register") return "login"
  if (isAdminPath(path)) return "login"
  return PUBLIC_PAGES[path] ?? "product"
}
