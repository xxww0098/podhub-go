/**
 * Auth/account thunks are HTTP calls: the test stubs `globalThis.fetch` and
 * asserts the route, the method and the projection.
 */
import { route } from "@/api/routes"
import assert from "node:assert/strict"
import test from "node:test"

import { accountHttp } from "@/bindings/http-account"

type Call = { url: string, method: string, body: unknown }

function recordFetch(reply: (call: Call) => unknown): { calls: Call[], restore: () => void } {
  const previous = globalThis.fetch
  const calls: Call[] = []
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const call: Call = {
      url: String(input),
      method: init?.method ?? "GET",
      body: init?.body === undefined ? undefined : typeof init.body === "string" ? JSON.parse(init.body) : init.body,
    }
    calls.push(call)
    return new Response(JSON.stringify({ data: reply(call) }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })
  }) as typeof globalThis.fetch
  return { calls, restore: () => { globalThis.fetch = previous } }
}

const overview = {
  session: { authenticated: true, email: "seller@example.invalid" },
  workspaces: [],
  owned_count: 0,
  owned_limit: 3,
}

test("signing in posts the credential and reads the composed overview back", async () => {
  const stub = recordFetch(() => overview)
  try {
    const result = await accountHttp.accountLogin({
      email: "seller@example.invalid",
      password: "hunter2hunter2",
    })
    assert.deepEqual(
      stub.calls.map((call) => `${call.method} ${call.url}`),
      ["POST /api/auth/login", "GET /api/view/account-overview"],
    )
    assert.deepEqual(stub.calls[0].body, {
      email: "seller@example.invalid",
      password: "hunter2hunter2",
    })
    assert.equal(result.session.email, "seller@example.invalid")
  } finally {
    stub.restore()
  }
})

test("a Workspace avatar write addresses that Workspace, then repaints from the overview", async () => {
  const stub = recordFetch(call => call.url.endsWith("/upload") ? {
    upload_ticket: "avatar-fixture-ticket", upload: { url: "https://private.example.invalid/avatar",
      headers: { content_type: "image/jpeg", if_none_match: "*" }, expires_at_ms: Date.now() + 600000 },
  } : overview)
  try {
    await accountHttp.accountSetAvatar({
      subject: { workspace: { workspace_id: 42 } },
      image: new Blob([Uint8Array.from([0xff, 0xd8, 0xff, 0x00])], { type: "image/jpeg" }),
    })
    assert.deepEqual(
      stub.calls.map((call) => `${call.method} ${call.url}`),
      ["POST /api/avatars/workspaces/42/upload", "PUT https://private.example.invalid/avatar", "PUT /api/avatars/workspaces/42", "GET /api/view/account-overview"],
    )
    assert.deepEqual(stub.calls[2].body, { upload_ticket: "avatar-fixture-ticket" })
  } finally {
    stub.restore()
  }
})

test("clearing the account avatar addresses self, then repaints from the overview", async () => {
  const stub = recordFetch(() => overview)
  try {
    await accountHttp.accountClearAvatar()
    assert.deepEqual(
      stub.calls.map((call) => `${call.method} ${call.url}`),
      ["DELETE /api/avatars/me", "GET /api/view/account-overview"],
    )
    assert.equal(stub.calls[0].body, undefined)
  } finally {
    stub.restore()
  }
})

test("a Workspace write is answered by the standing the switcher prints", async () => {
  const stub = recordFetch(() => ({
    ...overview,
    account_mode: "owner",
    owned_count: 1,
    workspaces: [{ id: 7, uuid: "u", name: "示例", plan: "pro", role: "owner", is_owned: true }],
  }))
  try {
    const standing = await accountHttp.accountCreateWorkspace("示例")
    assert.deepEqual(
      stub.calls.map((call) => `${call.method} ${call.url}`),
      ["POST /api/workspaces", "GET /api/view/account-overview"],
    )
    assert.equal(standing.account_mode, "owner")
    assert.equal(standing.workspaces.length, 1)
  } finally {
    stub.restore()
  }
})

test("the Workspace directory keeps the snake_case wire through to the screen", async () => {
  const stub = recordFetch(() => ({
    members: [
      {
        id: 1,
        name: "运营",
        email: "ops@example.invalid",
        role: "member",
        status: "active",
        joined_at_ms: 1_700_000_000_000,
        permissions: { remove: true },
      },
    ],
    invitations: [
      {
        id: 2,
        uuid: "8f0a3f5e-6c1d-4a5f-9a3e-6d2c8b7f4a11",
        email: "new@example.invalid",
        role: "member",
        invited_by_email: "owner@example.invalid",
        created_at_ms: 1_700_000_000_000,
        expires_at_ms: 1_760_000_000_000,
      },
    ],
    seats_used: 1,
    pending_used: 1,
    pending_limit: 5,
    permissions: { invite_roles: ["member"], revoke_invitation: true, edit_profile: false, dissolve: false, leave: true },
  }))
  try {
    const directory = await accountHttp.accountGetWorkspaceDirectory()
    assert.deepEqual(
      stub.calls.map((call) => `${call.method} ${call.url}`),
      ["GET /api/workspaces/members"],
    )
    assert.equal(directory.members[0].joined_at_ms, 1_700_000_000_000)
    assert.equal(directory.invitations[0].invited_by_email, "owner@example.invalid")
    assert.equal(directory.seats_used, 1)
    assert.equal(directory.pending_limit, 5)
    assert.deepEqual(directory.permissions.invite_roles, ["member"])
    assert.equal(directory.members[0].permissions.remove, true)
  } finally {
    stub.restore()
  }
})

test("a redeemed code flattens Cloud's nested plan and defaults its optional counts", async () => {
  const stub = recordFetch(() => ({
    ok: true,
    plan: { key: "pro", name: "专业版" },
    member_seats: 3,
  }))
  try {
    const result = await accountHttp.accountRedeemCode({
      code: "ABC-123",
      expected_workspace_uuid: "8f0a3f5e-6c1d-4a5f-9a3e-6d2c8b7f4a11",
    })
    assert.deepEqual(stub.calls[0].body, {
      code: "ABC-123",
      expected_workspace_uuid: "8f0a3f5e-6c1d-4a5f-9a3e-6d2c8b7f4a11",
    })
    assert.equal(result.plan_key, "pro")
    assert.equal(result.plan_name, "专业版")
    assert.equal(result.ocr_credits, 0)
    assert.equal(result.wallet_cents, 0)
    assert.equal(result.plan_expires_at, undefined)
  } finally {
    stub.restore()
  }
})

test("opening a payment order sends the operator to the provider's own page", async () => {
  const stub = recordFetch(() => ({
    order: {
      public_id: "po_1",
      plan: "pro",
      member_seats: 1,
      months: 1,
      unit_month_cents: 100,
      duration_days: 30,
      amount_cents: 100,
      currency: "CNY",
      provider: "alipay",
      status: "pending",
      remittance: null,
      pay_url: "https://pay.example/checkout/po_1",
      created_at: "2026-09-02T00:00:00Z",
      paid_at: null,
      canceled_at: null,
    },
  }))
  const scope = globalThis as unknown as { window?: { open: (...args: unknown[]) => unknown } }
  const previousWindow = scope.window
  const opened: unknown[][] = []
  scope.window = { open: (...args: unknown[]) => opened.push(args) }
  try {
    await accountHttp.accountOpenPaymentOrder("po_1")
    assert.deepEqual(
      stub.calls.map((call) => `${call.method} ${call.url}`),
      ["GET /api/orders/po_1"],
    )
    assert.deepEqual(opened, [["https://pay.example/checkout/po_1", "_blank", "noopener"]])
  } finally {
    scope.window = previousWindow
    stub.restore()
  }
})

test("switching accounts promotes the stacked session, then repaints", async () => {
  const stub = recordFetch(() => overview)
  try {
    await accountHttp.accountSwitchAccount("acc-uuid-2")
    assert.deepEqual(
      stub.calls.map((call) => `${call.method} ${call.url}`),
      ["POST /api/auth/switch", "GET /api/view/account-overview"],
    )
    assert.deepEqual(stub.calls[0].body, { uuid: "acc-uuid-2" })
  } finally {
    stub.restore()
  }
})

test("signing a stacked account out deletes its session slot", async () => {
  const stub = recordFetch(() => ({}))
  try {
    await accountHttp.accountLogoutAccount("acc-uuid-2")
    assert.deepEqual(
      stub.calls.map((call) => `${call.method} ${call.url}`),
      ["DELETE /api/auth/accounts/acc-uuid-2"],
    )
  } finally {
    stub.restore()
  }
})

test("paging notifications puts the cursor on the query string", async () => {
  const stub = recordFetch(() => ({ notifications: [], unread: 0, total: 0 }))
  try {
    await accountHttp.accountListNotifications("abc def")
    await accountHttp.accountListNotifications()
    assert.deepEqual(
      stub.calls.map((call) => call.url),
      [`${route("notifications")}?cursor=abc%20def`, route("notifications")],
    )
  } finally {
    stub.restore()
  }
})
