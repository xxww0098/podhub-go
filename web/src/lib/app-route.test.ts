import assert from "node:assert/strict"
import test from "node:test"

import { adminScreens, defaultAdminScreen } from "./admin-surface"
import { addressableScreens, spaceScreens } from "./app-navigation"
import { resolveRoute, routeAudienceFor, type RouteAudience } from "./app-route"

const PLAIN: RouteAudience = {
  authenticated: true,
  isStaff: false,
  isAgent: false,
  hasWorkspace: true,
}
const AGENT: RouteAudience = { ...PLAIN, isAgent: true }

test("catalogue grants address maintenance independently of workspace and staff roles", () => {
  const manager = routeAudienceFor({ authenticated: true, role: "user", accountMode: "unaffiliated", isCatalogManager: true })
  assert.deepEqual(resolveRoute({ pathname: "/", search: "?screen=supplier-catalog" }, manager), { kind: "workbench", screen: "supplier-catalog" })
  assert.deepEqual(resolveRoute({ pathname: "/admin", search: "?screen=supplier-catalog" }, manager), { kind: "admin-denied" })
})
const STAFF: RouteAudience = { ...PLAIN, isStaff: true }
const ANONYMOUS: RouteAudience = {
  authenticated: false,
  isStaff: false,
  isAgent: false,
  hasWorkspace: false,
}

const at = (pathname: string, search = "") => ({ pathname, search })

test("an anonymous caller gets a public page or the login screen", () => {
  assert.deepEqual(resolveRoute(at("/"), ANONYMOUS), { kind: "public" })
  assert.deepEqual(resolveRoute(at("/login"), ANONYMOUS), { kind: "login" })
  assert.deepEqual(resolveRoute(at("/register"), ANONYMOUS), { kind: "login" })
  // A staff address survives sign-in instead of falling through to the site.
  assert.deepEqual(resolveRoute(at("/admin", "?screen=supplier-dbs"), ANONYMOUS), {
    kind: "login",
  })
  // The unmatched catch-all is the homepage, never a refusal.
  assert.deepEqual(resolveRoute(at("/download"), ANONYMOUS), {
    kind: "public",
  })
})

test("the workbench addresses only the screens this account may reach", () => {
  assert.deepEqual(resolveRoute(at("/"), PLAIN), { kind: "workbench", screen: "home" })
  for (const screen of addressableScreens("workbench", PLAIN)) {
    assert.deepEqual(
      resolveRoute(at("/", "?screen=" + screen), PLAIN),
      { kind: "workbench", screen },
      screen,
    )
  }
  // The staff-only module and the Agent-only destination are not addressable
  // here: a URL must not reach a screen the nav withholds.
  for (const screen of ["supplier-dbs", "agent", "bogus", ""]) {
    assert.deepEqual(
      resolveRoute(at("/", "?screen=" + screen), PLAIN),
      { kind: "workbench", screen: "home" },
      screen,
    )
  }
})

test("an Agent account addresses 代理中心; a plain account does not", () => {
  assert.deepEqual(resolveRoute(at("/", "?screen=agent"), AGENT), {
    kind: "workbench",
    screen: "agent",
  })
  assert.deepEqual(resolveRoute(at("/", "?screen=supplier-dbs"), AGENT), {
    kind: "workbench",
    screen: "home",
  })
})

test("the admin surface addresses admin screens only", () => {
  assert.deepEqual(resolveRoute(at("/admin"), STAFF), {
    kind: "admin",
    screen: defaultAdminScreen(),
    settings: null,
  })
  assert.deepEqual(resolveRoute(at("/admin/"), STAFF), {
    kind: "admin",
    screen: defaultAdminScreen(),
    settings: null,
  })
  assert.deepEqual(resolveRoute(at("/admin", "?screen=supplier-dbs&settings=payment"), STAFF), {
    kind: "admin",
    screen: "supplier-dbs",
    settings: "payment",
  })
  // A known pane this rank may not open still reaches the sheet, which refuses
  // it by name; an unknown id opens nothing.
  assert.deepEqual(resolveRoute(at("/admin", "?settings=payment"), STAFF), {
    kind: "admin",
    screen: defaultAdminScreen(),
    settings: "payment",
  })
  assert.deepEqual(resolveRoute(at("/admin", "?settings=unknown"), STAFF), {
    kind: "admin",
    screen: defaultAdminScreen(),
    settings: null,
  })
  // Every platform destination requires its /admin address, including for staff.
  assert.deepEqual(resolveRoute(at("/", "?screen=supplier-dbs"), STAFF), {
    kind: "workbench",
    screen: "home",
  })
  assert.deepEqual(resolveRoute(at("/admin", "?screen=console"), STAFF), {
    kind: "admin",
    screen: defaultAdminScreen(),
    settings: null,
  })
})

test("platform delegate orders require the staff surface and keep seller orders separate", () => {
  assert.deepEqual(resolveRoute(at("/admin", "?screen=admin-delegate-orders"), STAFF), {
    kind: "admin", screen: "admin-delegate-orders", settings: null,
  })
  assert.deepEqual(resolveRoute(at("/", "?screen=admin-delegate-orders"), STAFF), {
    kind: "workbench", screen: "home",
  })
  assert.deepEqual(resolveRoute(at("/admin", "?screen=admin-delegate-orders"), PLAIN), { kind: "admin-denied" })
  assert.deepEqual(resolveRoute(at("/", "?screen=delegate-orders"), STAFF), {
    kind: "workbench", screen: "delegate-orders",
  })
})

test("the seller dashboard and products are addressable on the workbench", () => {
  for (const audience of [PLAIN, STAFF]) {
    assert.deepEqual(resolveRoute(at("/", "?screen=console"), audience), {
      kind: "workbench", screen: "console",
    })
    assert.deepEqual(resolveRoute(at("/", "?screen=products"), audience), {
      kind: "workbench", screen: "products",
    })
  }
})

test("平台管理员 runs the main-menu platform surface; only super_admin configures it", () => {
  const platformAdmin = routeAudienceFor({
    authenticated: true,
    role: "admin",
    accountMode: "owner",
  })
  // The main-menu 平台 mode is staff-wide: 平台管理员 reaches 平台商品库管理.
  assert.equal(platformAdmin.isStaff, true)
  assert.deepEqual(resolveRoute(at("/admin"), platformAdmin), {
    kind: "admin",
    screen: defaultAdminScreen(),
    settings: null,
  })
  // The platform-management panes are not a route decision — the resolver
  // passes the id through for both staff ranks and the settings sheet refuses
  // it by rank. What the route owns is that the address itself stays reachable.
  const operator = routeAudienceFor({
    authenticated: true,
    role: "super_admin",
    accountMode: "owner",
  })
  for (const audience of [platformAdmin, operator]) {
    assert.deepEqual(resolveRoute(at("/admin", "?settings=payment"), audience), {
      kind: "admin",
      screen: defaultAdminScreen(),
      settings: "payment",
    })
  }
  // A plain account never sees the surface at all.
  assert.deepEqual(resolveRoute(at("/admin"), PLAIN), { kind: "admin-denied" })
})

test("a non-staff caller is refused the admin surface instead of painted a shell", () => {
  for (const audience of [PLAIN, AGENT]) {
    assert.deepEqual(resolveRoute(at("/admin"), audience), { kind: "admin-denied" })
    assert.deepEqual(resolveRoute(at("/admin", "?screen=supplier-dbs"), audience), {
      kind: "admin-denied",
    })
  }
})

test("removed public pages use the same catch-all as other unknown addresses", () => {
  for (const page of ["catalog", "pricing", "help", "privacy", "terms"] as const) {
    assert.deepEqual(resolveRoute(at("/" + page + "/"), ANONYMOUS), { kind: "public" })
    for (const audience of [PLAIN, STAFF]) {
      assert.deepEqual(resolveRoute(at("/" + page + "/"), audience), {
        kind: "workbench",
        screen: "home",
      })
    }
  }
})

test("the workbench front door and catch-all need Workspace standing", () => {
  const unaffiliated: RouteAudience = { ...PLAIN, hasWorkspace: false }
  for (const path of ["/", "/login", "/download", "/catalog/", "/pricing/", "/help/", "/privacy/", "/terms/"]) {
    assert.deepEqual(resolveRoute(at(path), unaffiliated), { kind: "workspace-required" }, path)
  }
  assert.deepEqual(resolveRoute(at("/admin"), unaffiliated), { kind: "admin-denied" })
})

test("Workspace standing never decides the admin surface", () => {
  for (const role of ["admin", "super_admin"]) {
    const staff = routeAudienceFor({
      authenticated: true,
      role,
      accountMode: "unaffiliated",
    })
    assert.equal(staff.hasWorkspace, role === "super_admin")
    assert.deepEqual(
      resolveRoute(at("/admin"), staff),
      { kind: "admin", screen: defaultAdminScreen(), settings: null },
      role,
    )
  }
})

test("Workspace standing is read from the account mode, with the operator exempt", () => {
  assert.equal(
    routeAudienceFor({ authenticated: true, role: "user", accountMode: "owner" }).hasWorkspace,
    true,
  )
  assert.equal(
    routeAudienceFor({ authenticated: true, role: "user", accountMode: "member" }).hasWorkspace,
    true,
  )
  assert.equal(
    routeAudienceFor({ authenticated: true, role: "user", accountMode: "unaffiliated" })
      .hasWorkspace,
    false,
  )
  assert.equal(
    routeAudienceFor({ authenticated: true, role: "admin", accountMode: "unaffiliated" })
      .hasWorkspace,
    false,
  )
  assert.equal(
    routeAudienceFor({ authenticated: true, role: "super_admin", accountMode: "unaffiliated" })
      .hasWorkspace,
    true,
  )
  assert.equal(
    routeAudienceFor({ authenticated: false, role: "user", accountMode: "owner" }).hasWorkspace,
    false,
  )
})

test("staff and Agent standing come from the two exact reads", () => {
  for (const role of ["admin", "super_admin"]) {
    assert.equal(routeAudienceFor({ authenticated: true, role }).isStaff, true, role)
  }
  assert.equal(routeAudienceFor({ authenticated: true, role: "user" }).isStaff, false)
  assert.equal(routeAudienceFor({ authenticated: true, role: null }).isStaff, false)
  assert.equal(
    routeAudienceFor({ authenticated: true, role: "user", isAgent: true }).isAgent,
    true,
  )
  assert.equal(routeAudienceFor({ authenticated: true, role: "user" }).isAgent, false)
})

test("the admin screen list carries everything the staff nav paints", () => {
  // The nav paints the core admin set; the addressable list may extend it with
  // registered URL-only screens (厂家账号, ADR-0100 §E.19).
  for (const painted of addressableScreens("admin", PLAIN)) {
    assert.ok(adminScreens().includes(painted), painted)
  }
  assert.ok(adminScreens().includes("supplier-dbs"))
  assert.ok(spaceScreens().includes("stores"))
})

test("removed R2 settings cannot open a frontend pane", () => {
  assert.deepEqual(resolveRoute(at("/admin", "?settings=media"), STAFF), {
    kind: "admin",
    screen: defaultAdminScreen(),
    settings: null,
  })
})
