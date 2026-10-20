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
  type NavAudience,
} from "./app-navigation"
import { defaultAdminScreen } from "./admin-surface"
import { SCREEN_LABELS } from "./app-screens"

const PLAIN_ACCOUNT: NavAudience = { isAgent: false, isStaff: false }
const STAFF_ACCOUNT: NavAudience = { isAgent: false, isStaff: true }

test("平台管理 is a staff-only mode: hidden from plain accounts, last for staff", () => {
  const plain = navModesFor(PLAIN_ACCOUNT)
  assert.deepEqual(plain, ["workbench", "ops"])
  assert.ok(!plain.includes("admin"), "plain accounts must not see 平台管理")

  const staff = navModesFor(STAFF_ACCOUNT)
  assert.deepEqual(staff, [...NAV_MODES])
  assert.ok(staff.includes("admin"), "platform staff must see 平台管理")
  assert.equal(staff.at(-1), "admin", "平台管理 is the last mode")
})

test("平台管理 paints 列表管理 only for platform staff", () => {
  assert.deepEqual(navItemsFor("admin", PLAIN_ACCOUNT), [])
  const ids = navItemsFor("admin", STAFF_ACCOUNT).map((item) => item.id)
  assert.deepEqual(ids, ["supplier-dbs"])
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
  assert.equal(SCREEN_LABELS["supplier-dbs"], "货源管理")
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

test("the addressable workbench set is exactly what the nav paints", () => {
  const audiences: NavAudience[] = [
    PLAIN_ACCOUNT,
    STAFF_ACCOUNT,
    { isAgent: true, isStaff: false },
  ]
  for (const audience of audiences) {
    // The 平台 mode is part of the unified main nav, so for staff its 货源管理
    // row is addressable on "/" too — not just on the admin surface.
    const painted = navModesFor(audience)
      .flatMap((mode) => navItemsFor(mode, audience))
      .map((item) => item.id)
      .concat(spaceScreens())
    const addressable = addressableScreens("workbench", audience)
    assert.deepEqual([...addressable].sort(), [...new Set(painted)].sort())
    assert.equal(defaultScreenFor("workbench", audience), "console")
  }
})

test("staff-only and Agent-only screens are addressable only where they belong", () => {
  // 平台管理 is one tab of the unified main nav: staff reach 货源管理 from "/"
  // in place the moment that tab is picked; a plain account never can.
  assert.ok(addressableScreens("workbench", STAFF_ACCOUNT).includes("supplier-dbs"))
  assert.ok(!addressableScreens("workbench", PLAIN_ACCOUNT).includes("supplier-dbs"))
  // Per-screen rank is part of addressability, not only the outer surface gate.
  assert.deepEqual(addressableScreens("admin", PLAIN_ACCOUNT), [])
  assert.deepEqual(addressableScreens("admin", STAFF_ACCOUNT), ["supplier-dbs", ...ADMIN_URL_ONLY_SCREENS])
  assert.equal(defaultScreenFor("admin", STAFF_ACCOUNT), defaultAdminScreen())
  assert.ok(isAddressableScreen("stores", "workbench", PLAIN_ACCOUNT))
  assert.ok(!isAddressableScreen("agent", "workbench", PLAIN_ACCOUNT))
  assert.ok(isAddressableScreen("agent", "workbench", { isAgent: true, isStaff: false }))
  assert.ok(!isAddressableScreen("console", "admin", STAFF_ACCOUNT))
})

test("workbench space screens have an address even without a nav row", () => {
  const addressable = addressableScreens("workbench", PLAIN_ACCOUNT)
  for (const screen of ["stores", "usage", "notifications"] as const) {
    assert.ok(addressable.includes(screen), screen)
    assert.equal(modeOfScreen(screen), undefined, screen)
  }
})
