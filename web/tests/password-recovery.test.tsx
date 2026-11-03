import assert from "node:assert/strict"
import test from "node:test"
import { readFileSync } from "node:fs"
import { renderToStaticMarkup } from "react-dom/server"
import { accountHttp } from "../src/bindings/http-account"
import { FactoryLoginScreen } from "../src/factory/login/factory-login-screen"
import { PASSWORD_RECOVERY_ACCEPTED } from "../src/features/account/login-screen-password-recovery"

test("password recovery posts the email to the anonymous route", async () => {
  const originalFetch = globalThis.fetch
  const requests: { path: string; method: string; body: unknown }[] = []
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    requests.push({ path: String(input), method: init?.method ?? "GET", body: JSON.parse(String(init?.body)) })
    return new Response(JSON.stringify({ data: null }), { status: 200, headers: { "content-type": "application/json" } })
  }) as typeof fetch
  try {
    await accountHttp.accountForgotPassword("person@example.invalid")
    assert.deepEqual(requests, [{ path: "/api/auth/forgot", method: "POST", body: { email: "person@example.invalid" } }])
  } finally {
    globalThis.fetch = originalFetch
  }
})

test("acceptance copy does not promise mail delivery and factory sign-in has the shared entry", () => {
  assert.equal(PASSWORD_RECOVERY_ACCEPTED, "若该邮箱可用于找回，你将收到重置邮件。未收到可稍后重试或联系管理员。")
  assert.match(renderToStaticMarkup(<FactoryLoginScreen onSignedIn={() => undefined} />), /忘记密码/)
})

test("a confirmed reset survives session probe refusal or network loss", async () => {
  const originalFetch = globalThis.fetch
  try {
    for (const probe of ["active", "revoked", "offline"] as const) {
      const requests: string[] = []
      globalThis.fetch = (async (path: string | URL | Request) => {
        requests.push(String(path))
        if (String(path) === "/api/auth/reset") return new Response(JSON.stringify({ data: null }), { status: 200 })
        if (probe === "offline") throw new TypeError("fixture offline")
        return probe === "active"
          ? new Response(JSON.stringify({ data: { session: { authenticated: true } } }), { status: 200 })
          : new Response(JSON.stringify({ code: "AUTH_REQUIRED", error: "请重新登录。" }), { status: 401 })
      }) as typeof fetch
      await assert.doesNotReject(accountHttp.accountResetPassword("private-reset-token", "new-password"))
      assert.deepEqual(requests, ["/api/auth/reset", "/api/view/account-overview"])
    }
  } finally {
    globalThis.fetch = originalFetch
  }
})

test("a refused password reset does not start a session probe", async () => {
  const originalFetch = globalThis.fetch
  const requests: string[] = []
  globalThis.fetch = (async (path: string | URL | Request) => {
    requests.push(String(path))
    return new Response(JSON.stringify({ code: "INVALID_TOKEN", error: "重置链接已失效，请重新申请。" }), { status: 400 })
  }) as typeof fetch
  try {
    await assert.rejects(accountHttp.accountResetPassword("expired-reset-token", "new-password"))
    assert.deepEqual(requests, ["/api/auth/reset"])
  } finally {
    globalThis.fetch = originalFetch
  }
})

test("email reset remains globally mounted outside every login route", () => {
  const main = readFileSync(new URL("../src/main.tsx", import.meta.url), "utf8")
  assert.match(main, /<App \/>\s*<EmailLinkHost \/>/)
})
