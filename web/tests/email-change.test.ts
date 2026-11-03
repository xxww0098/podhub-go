import assert from "node:assert/strict"
import test from "node:test"
import { accountHttp } from "../src/bindings/http-account"

test("邮箱换绑申请提交新地址和当前密码", async () => {
  const originalFetch = globalThis.fetch
  const calls: { path: string; body: unknown }[] = []
  globalThis.fetch = (async (input, init) => {
    calls.push({ path: String(input), body: JSON.parse(String(init?.body)) })
    return new Response(JSON.stringify({ data: { ok: true } }), { status: 200 })
  }) as typeof fetch
  try {
    await accountHttp.accountRequestEmailChange("new@example.invalid", "current-password")
    assert.deepEqual(calls, [{ path: "/api/auth/email/change", body: { email: "new@example.invalid", current_password: "current-password" } }])
  } finally {
    globalThis.fetch = originalFetch
  }
})

test("确认成功和失败都只发送一次确认请求", async () => {
  const originalFetch = globalThis.fetch
  const calls: string[] = []
  let confirmStatus = 200
  globalThis.fetch = (async (input) => {
    const path = String(input)
    calls.push(path)
    if (path === "/api/auth/email/confirm") {
      return new Response(JSON.stringify(confirmStatus === 200 ? { data: { ok: true } } : { code: "VALIDATION", error: "链接已失效" }), { status: confirmStatus })
    }
    throw new TypeError("offline")
  }) as typeof fetch
  try {
    await assert.doesNotReject(accountHttp.accountConfirmEmailChange("confirmation-token"))
    assert.deepEqual(calls, ["/api/auth/email/confirm"])
    calls.length = 0
    confirmStatus = 400
    await assert.rejects(accountHttp.accountConfirmEmailChange("expired-token"))
    assert.deepEqual(calls, ["/api/auth/email/confirm"])
  } finally {
    globalThis.fetch = originalFetch
  }
})
