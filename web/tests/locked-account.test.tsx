import assert from "node:assert/strict"
import test from "node:test"
import { readFileSync } from "node:fs"
import { renderToStaticMarkup } from "react-dom/server"

import {
  LockedAccountScreen,
  lockedPasswordIssue,
  lockedPasswordMessage,
  submitLockedPassword,
} from "../src/app/locked-account-screen"
import { loadAuthState, refusalRetiresSession } from "../src/app/App"
import { handleFactorySignInError } from "../src/factory/login/factory-login-screen"

const LOCKED_SOURCE = readFileSync(
  new URL("../src/app/locked-account-screen.tsx", import.meta.url),
  "utf8",
)

/** The exact shape `@/api/client` produces for a 403 with a body code. */
const lockedRefusal = Object.assign(
  new Error("请先修改密码"),
  { code: "cloud_password_change_required", status: 403, serverCode: "PASSWORD_CHANGE_REQUIRED" },
)

test("the boot probe turns a locked account into the locked phase without retrying", async () => {
  let calls = 0
  const readOverview = async (): Promise<never> => {
    calls += 1
    throw lockedRefusal
  }
  assert.deepEqual(await loadAuthState(readOverview), { phase: "locked" })
  // One request, not the two the transient-failure loop makes: a gate refusal
  // is a state, and a second identical refusal only delays the form.
  assert.equal(calls, 1)
  // A 401 from the password write is the Cookie dying under the form, not the
  // gate refusing — re-probing then lands on the sign-in page instead of
  // leaving the operator stuck on a form that can never succeed.
  assert.equal(refusalRetiresSession("locked"), true)
})

test("the locked screen paints no shell: no nav, sidebar, or workspace chrome", () => {
  const html = renderToStaticMarkup(<LockedAccountScreen />)
  assert.doesNotMatch(html, /<nav/)
  assert.doesNotMatch(html, /data-slot="sidebar"/)
  assert.doesNotMatch(html, /data-slot="sidebar-inset"/)
  assert.doesNotMatch(html, /Workspace/)
  assert.doesNotMatch(html, /工作台/)
  // It is its own page, and it says why it exists.
  assert.match(html, /请先修改密码/)
  assert.match(html, /当前密码/)
  assert.match(html, /新密码/)
  assert.match(html, /确认新密码/)
  assert.match(html, /保存新密码/)
  assert.match(html, /for="locked-current-password"/)
  assert.match(html, /for="locked-new-password"/)
  assert.match(html, /for="locked-confirm-password"/)
  // No native required: the form owns the empty-submit verdict, like sign-in.
  assert.doesNotMatch(html, /^\s+required$/m)
  assert.doesNotMatch(html, /role="alert"/)
})

test("the locked screen stays reachable from the app entry", () => {
  const app = readFileSync(new URL("../src/app/App.tsx", import.meta.url), "utf8")
  assert.match(app, /import \{ LockedAccountScreen \} from "@\/app\/locked-account-screen"/)
  assert.match(app, /if \(auth\.phase === "locked"\) \{\s*return <LockedAccountScreen \/>/)
  assert.match(app, /commandErrorCode\(reason\) === "cloud_password_change_required"/)
  // The lock check must sit before the failure fallthrough, so the 403 never
  // reaches the retry loop.
  const lockedAt = app.indexOf('commandErrorCode(reason) === "cloud_password_change_required"')
  const failureAt = app.indexOf("failure = reason")
  assert.ok(lockedAt > 0 && failureAt > lockedAt)
})

test("the form validates locally before it spends a request", () => {
  assert.deepEqual(lockedPasswordIssue("", "new-password", "new-password"), {
    field: "current",
    message: "请输入当前密码",
  })
  assert.deepEqual(lockedPasswordIssue("old-password", "short", "short"), {
    field: "password",
    message: "密码至少需要 8 个字符",
  })
  assert.deepEqual(lockedPasswordIssue("old-password", "old-password", "old-password"), {
    field: "password",
    message: "新密码不能与当前密码相同",
  })
  assert.deepEqual(lockedPasswordIssue("old-password", "new-password", "other-password"), {
    field: "confirmation",
    message: "两次输入的密码不一致",
  })
  assert.equal(lockedPasswordIssue("old-password", "new-password", "new-password"), undefined)
  // 8 characters counted as code points, not UTF-16 units.
  assert.equal(lockedPasswordIssue("old-password", "八个字符的新密码", "八个字符的新密码"), undefined)
})

test("a refused change keeps the operator on the form and never reloads", async () => {
  let reloads = 0
  const result = await submitLockedPassword({
    current: "old-password",
    next: "new-password",
    confirmation: "new-password",
    changePassword: async () => {
      throw Object.assign(new Error("当前密码不正确"), { code: "VALIDATION", status: 400 })
    },
    reload: () => {
      reloads += 1
    },
  })
  assert.deepEqual(result, { ok: false, message: "当前密码不正确" })
  assert.equal(reloads, 0)

  const invalid = await submitLockedPassword({
    current: "old-password",
    next: "short",
    confirmation: "short",
    changePassword: async () => {
      throw new Error("must not be called")
    },
    reload: () => {
      reloads += 1
    },
  })
  assert.deepEqual(invalid, { ok: false, message: "密码至少需要 8 个字符" })
  assert.equal(reloads, 0)
})

test("a saved password reloads the document, which re-runs the boot probe", async () => {
  const calls: Array<[string, string]> = []
  let reloads = 0
  const result = await submitLockedPassword({
    current: "old-password",
    next: "new-password",
    confirmation: "new-password",
    changePassword: async (current, next) => {
      calls.push([current, next])
    },
    reload: () => {
      reloads += 1
    },
  })
  assert.deepEqual(result, { ok: true })
  assert.deepEqual(calls, [["old-password", "new-password"]])
  // A full reload, not a re-probe: the password change revoked this browser's
  // other sessions and issued a fresh one, so every cached read in memory is
  // stale and `loadAuthState` must run against a clean document.
  assert.equal(reloads, 1)
})

test("refusals read as Chinese operator copy, never a raw cloud_ code", () => {
  assert.equal(
    lockedPasswordMessage(Object.assign(new Error("当前密码不正确"), { code: "VALIDATION" })),
    "当前密码不正确",
  )
  assert.equal(
    lockedPasswordMessage(
      Object.assign(new Error("密码至少 8 位，且不超过 72 字节"), { code: "VALIDATION" }),
    ),
    "密码至少 8 位，且不超过 72 字节",
  )
  assert.equal(
    lockedPasswordMessage(Object.assign(new Error(""), { code: "unauthenticated" })),
    "登录已失效，请重新登录后再试。",
  )
  assert.equal(
    lockedPasswordMessage(Object.assign(new Error(""), { code: "cloud_unavailable" })),
    "云端服务暂时不可用，请稍后重试。",
  )
  const fallback = lockedPasswordMessage(Object.assign(new Error(""), { code: "cloud_mystery" }))
  assert.equal(fallback, "无法修改密码，请稍后重试。")
  assert.doesNotMatch(fallback, /cloud_/)
  assert.match(LOCKED_SOURCE, /notifyError\(result\.message\)/)
})

const SUPPLIER_CARD_SOURCE = readFileSync(
  new URL("../src/factory/login/factory-login-screen.tsx", import.meta.url),
  "utf8",
)

test("a provisioned factory account is handed to the password form, never told its password is wrong", () => {
  const notified: string[] = []
  let handovers = 0
  handleFactorySignInError(lockedRefusal,
    () => {
      handovers += 1
    },
    (_reason, fallback) => {
      notified.push(fallback)
    },
  )
  // The login call itself succeeded — the Cookie is already written — so the
  // 403 is the gate, not a rejected credential. The negative assertion is the
  // one that matters: a hand-over that ALSO toasts "check your email and
  // password" would still reach the form and pass a positive-only test.
  assert.equal(handovers, 1)
  assert.deepEqual(notified, [])
})

test("an ordinary refused sign-in still reports and stays on the card", () => {
  const notified: string[] = []
  let handovers = 0
  handleFactorySignInError(
    Object.assign(new Error("账号或密码不正确"), { code: "VALIDATION", status: 400 }),
    () => {
        handovers += 1
      },
    (_reason, fallback) => {
        notified.push(fallback)
      },
  )
  assert.equal(handovers, 0)
  assert.deepEqual(notified, ["登录失败。请检查邮箱和密码。"])
})

test("the factory sign-in card routes its only catch through that hand-over", () => {
  // One catch, one call site: the card cannot grow a second fallback branch
  // that reports the credential error for a locked account.
  assert.equal(SUPPLIER_CARD_SOURCE.split("} catch (reason) {").length - 1, 1)
  assert.match(SUPPLIER_CARD_SOURCE, /handleFactorySignInError\(reason,/)
  // The callback is only invoked when the host provided it.
  assert.match(SUPPLIER_CARD_SOURCE, /onPasswordChangeRequired &&/)
  // The spinner drops before the host swaps the tree.
  const handoverAt = SUPPLIER_CARD_SOURCE.indexOf("onPasswordChangeRequired &&")
  const busyAt = SUPPLIER_CARD_SOURCE.indexOf("setBusy(false)", handoverAt)
  const callbackAt = SUPPLIER_CARD_SOURCE.indexOf("onPasswordChangeRequired()", handoverAt)
  assert.ok(handoverAt > 0 && busyAt > handoverAt && callbackAt > busyAt)
})

test("both factory mounts, anonymous and signed-in, carry the hand-over", () => {
  const app = readFileSync(new URL("../src/app/App.tsx", import.meta.url), "utf8")
  const supplier = readFileSync(
    new URL("../src/factory/factory-app.tsx", import.meta.url),
    "utf8",
  )
  // Splitting on the tag opener counts the mounts without pinning line numbers.
  const mounts = app.split("<FactoryApp").slice(1)
  assert.equal(mounts.length, 2)
  for (const mount of mounts) {
    const element = mount.slice(0, mount.indexOf("/>"))
    assert.match(element, /onPasswordChangeRequired=\{lockAccount\}/)
  }
  // There is one account per browser, so `lockAccount` only swaps the phase.
  assert.match(app, /const lockAccount = \(\) => \{\s*setAuth\(\{ phase: "locked" \}\)/)
  assert.match(supplier, /onPasswordChangeRequired\?: \(\) => void/)
  assert.match(supplier, /onPasswordChangeRequired=\{onPasswordChangeRequired\}/)
})
