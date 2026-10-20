import assert from "node:assert/strict"
import test from "node:test"
import { renderToStaticMarkup } from "react-dom/server"
import { adminScreenFromSearch, adminScreens } from "@/lib/admin-surface"
import { addressableScreens, navItemsFor } from "@/lib/app-navigation"
import { resolveRoute, routeAudienceFor } from "@/lib/app-route"
import { ScreenCatalog } from "@/app/screen-catalog"
import type { AccountOverview } from "@/bindings/commands"

const screens = ["admin-console", "admin-products"] as const
function audience(role: string | null) {
  return routeAudienceFor({ authenticated: true, role, accountMode: "unaffiliated" })
}

test("direct observation URLs are rank-gated; a normal admin keeps the existing staff default", () => {
  for (const role of ["user", "admin", "super_admin", "manager", "SUPER_ADMIN", "", null]) {
    const standing = audience(role)
    for (const screen of screens) {
      const route = resolveRoute({ pathname: "/admin", search: "?screen=" + screen }, standing)
      if (role === "super_admin") assert.deepEqual(route, { kind: "admin", screen, settings: null })
      else if (role === "admin") assert.deepEqual(route, { kind: "admin", screen: "supplier-dbs", settings: null })
      else assert.deepEqual(route, { kind: "admin-denied" })
      assert.equal(adminScreens(standing).includes(screen), role === "super_admin")
      assert.equal(addressableScreens("admin", standing).includes(screen), role === "super_admin")
      assert.equal(navItemsFor("admin", standing).some((item) => item.id === screen), role === "super_admin")
      assert.equal(addressableScreens("workbench", standing).includes(screen), false)
      assert.equal(adminScreenFromSearch("?screen=" + screen, standing), role === "super_admin" ? screen : "supplier-dbs")
    }
  }
  const anonymous = routeAudienceFor({ authenticated: false, role: "super_admin" })
  assert.deepEqual(resolveRoute({ pathname: "/admin", search: "?screen=admin-products" }, anonymous), { kind: "login" })
  assert.equal(anonymous.isSuperAdmin, false)
})

test("ScreenCatalog never mounts observation from an injected visited set for admin, unknown rank, or /", () => {
  const globals = globalThis as unknown as Record<string, unknown>
  const prior = globals.window
  try {
    for (const [role, path] of [["admin", "/admin"], ["user", "/admin"], ["unknown", "/admin"], ["super_admin", "/"]]) {
      globals.window = { location: { href: "http://localhost" + path } }
      const overview = { session: { role }, account_mode: "unaffiliated" } as unknown as AccountOverview
      const markup = renderToStaticMarkup(<ScreenCatalog screen="admin-products" visited={[...screens]} overview={overview} onOverviewChange={() => {}} onSignedOut={() => {}} onNavigate={() => {}} onRefreshOverview={async () => {}} />)
      assert.equal(markup, "", role + " @ " + path)
    }
  } finally {
    if (prior === undefined) delete globals.window
    else globals.window = prior
  }
})
