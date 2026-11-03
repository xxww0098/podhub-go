import assert from "node:assert/strict"
import test from "node:test"

import {
  ADMIN_SURFACE_PATH,
  adminScreenFromSearch,
  adminScreens,
  defaultAdminScreen,
  isAdminPath,
  isAdminScreen,
  settingsFromSearch,
  withScreen,
  withSettings,
  withoutForeignSearch,
  withoutSettings,
} from "./admin-surface"

test("only /admin and its descendants are the admin surface", () => {
  for (const path of ["/admin", "/admin/", "/admin//", "/admin/users"]) {
    assert.equal(isAdminPath(path), true, path)
  }
  for (const path of ["/", "/login", "/administrator", "/adminx", "/admins"]) {
    assert.equal(isAdminPath(path), false, path)
  }
  assert.equal(ADMIN_SURFACE_PATH, "/admin")
})

test("the admin surface addresses exactly the staff-only screens", () => {
  const screens = adminScreens()
  assert.ok(screens.includes("supplier-dbs"), "supplier-dbs is the staff screen")
  for (const screen of ["console", "listing", "stores", "ops-shipping", "catalog"]) {
    assert.ok(!screens.includes(screen as never), screen)
  }
  assert.equal(defaultAdminScreen(), "supplier-dbs")
})

test("?screen= under /admin accepts a staff screen and falls back otherwise", () => {
  assert.equal(adminScreenFromSearch("?screen=supplier-dbs"), "supplier-dbs")
  assert.equal(adminScreenFromSearch("?open=src_1&screen=supplier-dbs"), "supplier-dbs")
  for (const search of ["", "?screen=console", "?screen=bogus", "?screen="]) {
    assert.equal(adminScreenFromSearch(search), defaultAdminScreen(), search)
  }
})

test("?settings= accepts a known section id and ignores anything else", () => {
  assert.equal(settingsFromSearch("?settings=payment"), "payment")
  assert.equal(settingsFromSearch("?settings=ai-accounts"), "ai-accounts")
  assert.equal(settingsFromSearch("?screen=supplier-dbs&settings=plan-orders"), "plan-orders")
  for (const search of ["", "?settings=", "?settings=agent", "?settings=unknown", "?settings=media", "?settings=ocr", "?screen=users"]) {
    assert.equal(settingsFromSearch(search), undefined, search)
  }
})

test("the surface knows which screens are its own", () => {
  assert.equal(isAdminScreen("supplier-dbs"), true)
  assert.equal(isAdminScreen("admin-delegate-orders"), true)
  assert.equal(isAdminScreen("delegate-orders"), false)
  for (const screen of ["home", "listing", "stores", "usage", "notifications"] as const) {
    assert.equal(isAdminScreen(screen), false, screen)
  }
})

test("search rewriting preserves unrelated parameters", () => {
  assert.equal(withScreen("?open=src_1&screen=console", "supplier-dbs"), "?screen=supplier-dbs")
  assert.equal(withScreen("", "supplier-dbs"), "?screen=supplier-dbs")
  assert.equal(withSettings("?screen=supplier-dbs&open=src_1", "payment"), "?screen=supplier-dbs&open=src_1&settings=payment")
  assert.equal(withoutSettings("?screen=supplier-dbs&settings=payment&invite=AB12"), "?screen=supplier-dbs&invite=AB12")
  assert.equal(withoutSettings("?settings=payment"), "")
  // Catalog product is an in-module drill: a sidebar jump must not restore it.
  assert.equal(
    withScreen("?screen=catalog&product=scp_1&q=hat", "home"),
    "?screen=home",
  )
  assert.equal(withScreen("?screen=catalog&product=scp_1", "catalog"), "?screen=catalog")
  assert.equal(
    withScreen("?screen=catalog&product=scp_1&q=hat", "listing"),
    "?screen=listing",
  )
  // cardId is 批量上架's drill the same way: leaving the screen drops it, so a
  // nav jump lands on the card library — never back inside the last runner.
  assert.equal(
    withScreen("?screen=listing&cardId=card-1&product=scp_1", "listing"),
    "?screen=listing",
  )
  assert.equal(
    withScreen("?screen=listing&cardId=card-1", "home"),
    "?screen=home",
  )
  // A cardId injected on another screen (the progress chip) rides
  // into listing on purpose and survives.
  assert.equal(
    withScreen("?screen=home&cardId=card-1", "listing"),
    "?screen=listing&cardId=card-1",
  )
})

test("the painted screen drops leftover module params without changing itself", () => {
  assert.equal(
    withoutForeignSearch("?screen=listing&product=scp_1&q=hat&pick=1", "listing"),
    "?screen=listing",
  )
  assert.equal(
    withoutForeignSearch("?screen=listing&cardId=card-1&product=scp_1", "listing"),
    "?screen=listing&cardId=card-1",
  )
  assert.equal(
    withoutForeignSearch("?screen=catalog&product=scp_1&q=hat", "catalog"),
    "?screen=catalog&product=scp_1&q=hat",
  )
  assert.equal(withoutForeignSearch("", "listing"), "")
})
