import assert from "node:assert/strict"
import test from "node:test"

import {
  NAV_MODES,
  ADMIN_URL_ONLY_SCREENS,
  addressableScreens,
  defaultScreenFor,
  isAddressableScreen,
  modeOfScreen,
  navItemsFor,
  navModesFor,
  spaceScreens,
  sidebarGroupsFor,
  type NavAudience,
} from "./app-navigation"
import { defaultAdminScreen } from "./admin-surface"
import { SCREEN_LABELS } from "./app-screens"

const PLAIN_ACCOUNT: NavAudience = { isAgent: false, isStaff: false }
const STAFF_ACCOUNT: NavAudience = { isAgent: false, isStaff: true }

test("source maintenance appears only for an active catalogue manager", () => {
  const manager = { ...PLAIN_ACCOUNT, isCatalogManager: true }
  assert.ok(navItemsFor("workbench", manager).some((item) => item.id === "supplier-catalog"))
  assert.ok(isAddressableScreen("supplier-catalog", "workbench", manager))
  assert.ok(!isAddressableScreen("supplier-catalog", "workbench", PLAIN_ACCOUNT))
  assert.ok(!isAddressableScreen("supplier-catalog", "admin", manager))
})

test("sidebar shows all business groups in workflow order without duplicating or widening access", () => {
  const groups = sidebarGroupsFor(PLAIN_ACCOUNT)
  assert.deepEqual(groups.map((group) => group.label), ["总览", "商品经营", "订单履约", "客户服务"])
  assert.deepEqual(groups.map((group) => group.items.map((item) => item.id)), [
    ["home", "console"],
    ["catalog", "listing", "products", "task-records"],
    ["ops-shipping", "delegate-orders", "ops-returns", "ops-supply"],
    ["message-center", "ops-voice"],
  ])
  for (const audience of [PLAIN_ACCOUNT, STAFF_ACCOUNT, { isAgent: true, isStaff: true, isSuperAdmin: true }]) {
    const painted = sidebarGroupsFor(audience).flatMap((group) => group.items.map((item) => item.id))
    const allowed = navModesFor(audience).flatMap((mode) => navItemsFor(mode, audience)).map((item) => item.id)
    assert.deepEqual([...painted].sort(), [...allowed].sort())
    assert.equal(painted.length, new Set(painted).size)
  }
})

test("平台管理 is a staff-only mode: hidden from plain accounts, last for staff", () => {
  const plain = navModesFor(PLAIN_ACCOUNT)
  assert.deepEqual(plain, ["workbench", "ops"])
  assert.ok(!plain.includes("admin"), "plain accounts must not see 平台管理")

  const staff = navModesFor(STAFF_ACCOUNT)
  assert.deepEqual(staff, [...NAV_MODES])
  assert.ok(staff.includes("admin"), "platform staff must see 平台管理")
  assert.equal(staff.at(-1), "admin", "平台管理 is the last mode")
})

test("平台管理 paints staff destinations only for platform staff", () => {
  assert.deepEqual(navItemsFor("admin", PLAIN_ACCOUNT), [])
  const ids = navItemsFor("admin", STAFF_ACCOUNT).map((item) => item.id)
  assert.deepEqual(ids, ["supplier-dbs", "admin-delegate-orders"])
  const groups = sidebarGroupsFor(STAFF_ACCOUNT)
  assert.ok(groups.find((group) => group.label === "订单履约")?.items.some((item) => item.id === "delegate-orders"))
  assert.ok(groups.find((group) => group.label === "平台")?.items.some((item) => item.id === "admin-delegate-orders"))
})

test("列表管理 is no longer a workbench item for anyone", () => {
  const audiences: NavAudience[] = [
    PLAIN_ACCOUNT,
    STAFF_ACCOUNT,
    { isAgent: true, isStaff: true },
  ]
  for (const audience of audiences) {
    const ids = navItemsFor("workbench", audience).map((item) => item.id)
    assert.ok(!ids.includes("supplier-dbs"), "工作台 must not carry 列表管理")
  }
})

test("列表管理 belongs to the admin mode and carries its label", () => {
  assert.equal(modeOfScreen("supplier-dbs"), "admin")
  assert.equal(SCREEN_LABELS["supplier-dbs"], "平台商品库管理")
})

test("agentOnly still filters the Agent destination by account type", () => {
  const plain = navItemsFor("workbench", PLAIN_ACCOUNT).map((item) => item.id)
  assert.ok(!plain.includes("agent"))
  assert.ok(!plain.includes("supplier-dbs"))

  const agent = navItemsFor("workbench", { isAgent: true, isStaff: false }).map(
    (item) => item.id,
  )
  assert.ok(agent.includes("agent"))
})

test("search parity: staff see 列表管理; plain accounts see neither it nor the Agent entry", () => {
  const searchable = (audience: NavAudience) =>
    navModesFor(audience)
      .flatMap((mode) => navItemsFor(mode, audience))
      .map((item) => item.id)

  const staff = searchable(STAFF_ACCOUNT)
  assert.ok(staff.includes("supplier-dbs"))
  assert.ok(!staff.includes("agent"), "search must still hide Agent-only entries")

  const plain = searchable(PLAIN_ACCOUNT)
  assert.ok(!plain.includes("supplier-dbs"))
  assert.ok(!plain.includes("agent"))
})

test("the workbench excludes every platform destination from its routes", () => {
  const audiences: NavAudience[] = [
    PLAIN_ACCOUNT,
    STAFF_ACCOUNT,
    { isAgent: true, isStaff: false },
    { isAgent: false, isStaff: true, isSuperAdmin: true },
  ]
  for (const audience of audiences) {
    const painted = navModesFor(audience)
      .filter((mode) => mode !== "admin")
      .flatMap((mode) => navItemsFor(mode, audience))
      .map((item) => item.id)
      .concat(spaceScreens())
    const addressable = addressableScreens("workbench", audience)
    assert.deepEqual([...addressable].sort(), [...new Set(painted)].sort())
    assert.equal(defaultScreenFor("workbench", audience), "home")
  }
})

test("staff-only and Agent-only screens are addressable only where they belong", () => {
  assert.ok(!addressableScreens("workbench", STAFF_ACCOUNT).includes("supplier-dbs"))
  assert.ok(!addressableScreens("workbench", PLAIN_ACCOUNT).includes("supplier-dbs"))
  // Per-screen rank is part of addressability, not only the outer surface gate.
  assert.deepEqual(addressableScreens("admin", PLAIN_ACCOUNT), [])
  assert.deepEqual(addressableScreens("admin", STAFF_ACCOUNT), ["supplier-dbs", "admin-delegate-orders", ...ADMIN_URL_ONLY_SCREENS])
  assert.ok(!isAddressableScreen("admin-delegate-orders", "workbench", STAFF_ACCOUNT))
  assert.ok(isAddressableScreen("delegate-orders", "workbench", STAFF_ACCOUNT))
  assert.ok(!isAddressableScreen("admin-delegate-orders", "admin", PLAIN_ACCOUNT))
  assert.equal(defaultScreenFor("admin", STAFF_ACCOUNT), defaultAdminScreen())
  assert.ok(isAddressableScreen("stores", "workbench", PLAIN_ACCOUNT))
  assert.ok(!isAddressableScreen("agent", "workbench", PLAIN_ACCOUNT))
  assert.ok(isAddressableScreen("agent", "workbench", { isAgent: true, isStaff: false }))
})

test("workbench space screens have an address even without a nav row", () => {
  const addressable = addressableScreens("workbench", PLAIN_ACCOUNT)
  for (const screen of ["stores", "usage", "notifications"] as const) {
    assert.ok(addressable.includes(screen), screen)
    assert.equal(modeOfScreen(screen), undefined, screen)
  }
})
