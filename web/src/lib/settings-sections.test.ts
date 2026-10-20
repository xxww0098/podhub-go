import assert from "node:assert/strict"
import test from "node:test"

import {
  ADMIN_SETTINGS_ROWS,
  SETTINGS_ROWS,
  SETTINGS_SECTIONS,
  adminSettingsRowsFor,
  isSettingsSection,
  resolveSettingsPane,
  settingsRowsFor,
  type SettingsSectionRow,
} from "./settings-sections"

test("section ids stay unique, known and fully described", () => {
  const ids = SETTINGS_SECTIONS.map((section) => section.id)
  assert.equal(new Set(ids).size, ids.length)
  assert.equal(SETTINGS_ROWS.length, SETTINGS_SECTIONS.length)
  for (const row of SETTINGS_ROWS) {
    assert.equal(isSettingsSection(row.id), true)
    assert.ok(
      row.label.length > 0 &&
        row.title.length > 0 &&
        (row.description?.length ?? 0) > 0,
    )
    assert.equal(SETTINGS_ROWS.filter((other) => other.id === row.id).length, 1)
  }
  assert.equal(isSettingsSection("agent"), false)
  assert.equal(SETTINGS_ROWS.find((row) => row.id === "account")?.account, true)
})

test("platform management panes are one super_admin group", () => {
  assert.deepEqual(
    ADMIN_SETTINGS_ROWS.map((row) => row.id),
    ["users", "supplier-accounts", "ocr", "ai-accounts", "media", "payment", "proxy", "prompts", "banned-tags", "categories", "redeem-codes", "agents", "admin-logs", "plan-orders"],
  )
  assert.equal(new Set(ADMIN_SETTINGS_ROWS.map((row) => row.group)).size, 1)
  assert.equal(ADMIN_SETTINGS_ROWS[0].group, "平台管理")
  for (const row of ADMIN_SETTINGS_ROWS) assert.equal(row.account, false)
})

test("平台管理员 runs the main-menu platform screens but opens no 平台管理 pane", () => {
  const managed = ADMIN_SETTINGS_ROWS.map((row) => row.id)
  const open = (rows: readonly SettingsSectionRow[]) => rows.map((row) => row.id)
  const openToEveryone = SETTINGS_ROWS.filter((row) => !row.admin).map((row) => row.id)

  // Every non-super rank — 平台管理员 included — sees the sheet minus 平台管理…
  for (const role of ["admin", "user", "owner", "manager", "", null, undefined, " admin "]) {
    const ids = open(settingsRowsFor(role))
    for (const id of managed) assert.ok(!ids.includes(id), `${role} must not open ${id}`)
    assert.ok(ids.includes("account"), String(role))
    assert.deepEqual(adminSettingsRowsFor(role), [], String(role))
  }
  // …while the operator sees every pane, and the admin rail is its own list.
  assert.deepEqual(open(settingsRowsFor("admin")), openToEveryone)
  assert.deepEqual(open(settingsRowsFor("super_admin")), open(SETTINGS_ROWS))
  assert.deepEqual(
    adminSettingsRowsFor("super_admin").map((row) => row.id),
    managed,
  )
})

test("no platform-management pane can be painted for a non-super_admin actor", () => {
  for (const role of ["admin", "user", "owner", null, undefined]) {
    const available = settingsRowsFor(role)
    for (const row of ADMIN_SETTINGS_ROWS) {
      assert.deepEqual(
        resolveSettingsPane({ requested: row.id, available, adminSurface: true }),
        { kind: "refused", section: row.id },
        `${role}/${row.id}`,
      )
      // The workbench keeps its 账号 fallback for a control that cannot offer
      // the pane; only the addressed surface may refuse.
      assert.deepEqual(
        resolveSettingsPane({ requested: row.id, available, adminSurface: false }),
        { kind: "pane", section: "account" },
        `${role}/${row.id}`,
      )
    }
  }
  const operator = settingsRowsFor("super_admin")
  for (const row of ADMIN_SETTINGS_ROWS) {
    assert.deepEqual(
      resolveSettingsPane({ requested: row.id, available: operator, adminSurface: true }),
      { kind: "pane", section: row.id },
      row.id,
    )
  }
  /* The sheet's "no pane" sentinel must never collide with a real section id. */
  assert.equal(isSettingsSection(""), false)
})

test("the admin surface refuses an unavailable pane instead of repainting one", () => {
  const available: readonly SettingsSectionRow[] = SETTINGS_ROWS.filter(
    (row) => !row.admin,
  )
  assert.deepEqual(
    resolveSettingsPane({ requested: "media", available, adminSurface: true }),
    { kind: "refused", section: "media" },
  )
  assert.deepEqual(
    resolveSettingsPane({ requested: "media", available, adminSurface: false }),
    { kind: "pane", section: "account" },
  )
  const all: readonly SettingsSectionRow[] = SETTINGS_ROWS
  assert.deepEqual(
    resolveSettingsPane({ requested: "media", available: all, adminSurface: true }),
    { kind: "pane", section: "media" },
  )
})
