/** Account writes use Cloud endpoints; Workspace entitlements are never assigned during creation. */
import { route } from "@/api/routes"
import assert from "node:assert/strict"
import test from "node:test"

import {
  canAssign,
  canMutate,
  parseRole,
  planUserUpdate,
  roleFromStored,
} from "@/bindings/admin-writes"
import { adminHttp } from "@/bindings/http-admin"

type Call = { url: string, method: string, body: unknown }

function recordFetch(reply: (call: Call) => unknown): { calls: Call[], restore: () => void } {
  const previous = globalThis.fetch
  const calls: Call[] = []
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const call: Call = {
      url: String(input),
      method: init?.method ?? "GET",
      body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
    }
    calls.push(call)
    return new Response(JSON.stringify({ data: reply(call) }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })
  }) as typeof globalThis.fetch
  return { calls, restore: () => { globalThis.fetch = previous } }
}

const person = {
  kind: "user",
  role_label: "用户",
  uuid: "u-1",
  email: "seller@example.invalid",
  name: "卖家",
  role: "user",
  is_admin: false,
  created_at: "2026-01-01T00:00:00Z",
  status: "active",
  disabled: false,
  manageable: true,
  editable: true,
}

function superAdminSession(call: Call): unknown {
  if (call.url === route("viewAccountOverview")) {
    return { session: { authenticated: true, role: "super_admin" }, workspaces: [], owned_count: 0, owned_limit: 3 }
  }
  if (call.url === route("adminUsers") && call.method === "GET") {
    return { workspaces: [], unaffiliated: [person], workspace_count: 0, user_count: 1 }
  }
  return { ok: true, user: { ...person, plan: "pro", seat_limit: 1, seats_used: 1, ai_tokens_used: 0, ai_tokens_monthly: 0 } }
}

test("nobody assigns super_admin, and an admin only ever mints plain users", () => {
  assert.equal(canAssign("super_admin", "admin"), true)
  assert.equal(canAssign("super_admin", "super_admin"), false)
  assert.equal(canAssign("admin", "admin"), false)
  assert.equal(canAssign("admin", "user"), true)
  assert.equal(canAssign("user", "user"), false)
  assert.equal(canMutate("super_admin", "admin"), true)
  assert.equal(canMutate("admin", "admin"), false)
  assert.equal(canMutate("admin", "user"), true)
  assert.equal(parseRole(" Super_Admin "), "super_admin")
  assert.throws(() => parseRole("owner"), /角色无效/)
  for (const raw of ["", "   ", "superadmin", "root"]) {
    assert.equal(roleFromStored(raw), "user")
  }
})

test("an edit writes only the fields that actually moved", () => {
  assert.deepEqual(
    planUserUpdate("super_admin", person, { role: "user", enabled: true }),
    [],
  )
  assert.deepEqual(
    planUserUpdate("super_admin", person, { role: "admin", enabled: false }),
    [
      { segment: "admin", body: { role: "admin" } },
      { segment: "status", body: { enabled: false } },
    ],
  )
  assert.throws(() => planUserUpdate("admin", person, { role: "admin" }), /无权分配该角色/)
})

test("editing a User reads the directory once and posts only the changed field", async () => {
  const stub = recordFetch(superAdminSession)
  try {
    await adminHttp.adminUpdateUser({
      uuid: "u-1",
      role: "user",
      enabled: false,
    })
    assert.deepEqual(
      stub.calls.map((call) => `${call.method} ${call.url}`),
      [
        "GET /api/view/account-overview",
        "GET /api/admin/users",
        "POST /api/admin/users/u-1/status",
      ],
    )
    assert.deepEqual(stub.calls[2].body, { enabled: false })
  } finally {
    stub.restore()
  }
})

test("an unchanged edit spends no write at all", async () => {
  const stub = recordFetch(superAdminSession)
  try {
    // Zero writes now refuse loudly instead of returning a fabricated view
    // with made-up plan/seat/token fields.
    await assert.rejects(
      () => adminHttp.adminUpdateUser({ uuid: "u-1", role: "user", enabled: true }),
      /没有需要更新的字段/,
    )
    assert.deepEqual(
      stub.calls.map((call) => call.method),
      ["GET", "GET"],
    )
  } finally {
    stub.restore()
  }
})

test("creating a User writes only the account, without assigning Workspace entitlements", async () => {
  const stub = recordFetch(superAdminSession)
  try {
    await adminHttp.adminCreateUser({
      email: " Seller@Example.invalid ",
      password: "hunter2hunter2",
      role: "user",
    })
    assert.deepEqual(
      stub.calls.map((call) => `${call.method} ${call.url}`),
      [
        "GET /api/view/account-overview",
        "POST /api/admin/users",
      ],
    )
    assert.deepEqual(stub.calls[1].body, {
      email: "seller@example.invalid",
      password: "hunter2hunter2",
      role: "user",
    })
  } finally {
    stub.restore()
  }
})

test("a short password never writes to Cloud", async () => {
  const stub = recordFetch(superAdminSession)
  try {
    await adminHttp.adminCreateUser({
      email: "lite@example.invalid",
      password: "hunter2hunter2",
      role: "user",
    })
    assert.deepEqual(
      stub.calls.map((call) => `${call.method} ${call.url}`),
      ["GET /api/view/account-overview", "POST /api/admin/users"],
    )
    await assert.rejects(
      adminHttp.adminCreateUser({
        email: "short@example.invalid",
        password: "hunter",
        role: "user",
      }),
      /密码至少 8 位/,
    )
    assert.equal(stub.calls.length, 3)
  } finally {
    stub.restore()
  }
})

test("admin tables put only the filters an operator set on the query string", async () => {
  const stub = recordFetch(() => ({ page: 1, page_size: 20, total_pages: 0, total_rows: 0, rows: [] }))
  try {
    await adminHttp.adminListAiRequests(2, 20, {
      query: " gpt ",
      status: "",
      api_format: "",
      operation: "",
    })
    await adminHttp.adminListErrorLogs(1, 50, { query: "", source: "desktop", since: "2026-01-01" })
    assert.deepEqual(stub.calls.map((call) => call.url), [
      `${route("adminAiRequests")}?page=2&page_size=20&q=gpt`,
      `${route("adminErrorLogs")}?page=1&page_size=50&source=desktop&since=2026-01-01`,
    ])
  } finally {
    stub.restore()
  }
})

test("deleting error logs carries its selection in the DELETE body", async () => {
  const stub = recordFetch(() => ({ deleted_count: 2 }))
  try {
    const events = [{ event_id: "e1", device_uid: "d1" }]
    await adminHttp.adminDeleteErrorLogs(events)
    assert.equal(stub.calls[0].method, "DELETE")
    assert.equal(stub.calls[0].url, route("adminErrorLogs"))
    assert.deepEqual(stub.calls[0].body, { events })
  } finally {
    stub.restore()
  }
})
