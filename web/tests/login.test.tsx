import assert from "node:assert/strict"
import test from "node:test"
import { readFileSync } from "node:fs"
import { renderToStaticMarkup } from "react-dom/server"
import {
  LoginScreen,
  emptyAccessCheck,
  registrationPasswordIssue,
} from "../src/features/account/login-screen"
import {
  authStateForOverview,
  loadAuthState,
  refusalRetiresSession,
  SessionCheckFailed,
} from "../src/app/App"
import { productVersionLabel } from "../src/lib/product-version"

const anonymousOverview = {
  session: { authenticated: false },
  workspaces: [],
  owned_count: 0,
  owned_limit: 3,
}

test("login screen is a standalone sign-in surface without workspace chrome", () => {
  const html = renderToStaticMarkup(
    <LoginScreen onSignedIn={() => undefined} />,
  )
  assert.match(html, /登录/)
  assert.match(html, /PodHub/)
  assert.match(html, /app-icon\.svg/)
  assert.match(html, /一张图要走的路/)
  assert.match(html, /按需印刷，上架到送达/)
  assert.doesNotMatch(html, /桌面端/)
  assert.match(html, /site\/hero-tote\.jpg/)
  assert.match(html, /选品/)
  assert.match(html, /导图/)
  assert.match(html, /上架/)
  assert.doesNotMatch(html, /login-cycle/)
  assert.match(html, /for="access-email"/)
  assert.match(html, /for="access-password"/)
  assert.match(html, /创建账户/)
  assert.match(html, /还没有账户/)
  assert.match(html, /lg:grid-cols-\[minmax\(0,1\.05fr\)_minmax\(0,0\.95fr\)\]/)
  assert.doesNotMatch(html, /使用本机工作区/)
  assert.doesNotMatch(html, /不登录云端/)
  assert.doesNotMatch(html, /Workspace/)
  assert.doesNotMatch(html, /data-slot="sidebar"/)
  assert.doesNotMatch(html, /已登录/)
})

test("the anonymous entry graph never pulls AppShell or production screens", () => {
  const source = readFileSync(new URL("../src/app/App.tsx", import.meta.url), "utf8")
  assert.match(source, /import\("@\/app\/authenticated-app"\)/)
  assert.match(source, /PublicSite/)
  assert.doesNotMatch(source, /from ["']@\/app\/app-shell["']/)
  assert.doesNotMatch(source, /from ["']@\/features\/workflow\/workflow-screen["']/)
  assert.doesNotMatch(source, /from ["']@\/features\/console\/console-screen["']/)
})

test("session startup failures stay out of Login and remain retryable", async () => {
  let attempts = 0
  const reason = {
    code: "cloud_unavailable",
    message: "云端服务暂时不可用。",
    remediation: "请检查网络。",
  }
  const authenticated = {
    ...anonymousOverview,
    session: { authenticated: true, email: "seller@example.invalid" },
  }
  const readOverview = async () => {
    attempts += 1
    if (attempts <= 2) {
      throw reason
    }
    return authenticated
  }
  const failed = await loadAuthState(readOverview)
  assert.deepEqual(failed, {
    phase: "failed",
    reason,
    message: "云端服务暂时不可用。 请检查网络。",
  })
  assert.equal(failed.reason, reason)

  const html = renderToStaticMarkup(
    <SessionCheckFailed message={failed.message} reason={failed.reason} onRetry={() => undefined} />,
  )
  // Failure copy rides the persistent live toast, never the page DOM; the
  // screen keeps only the retry affordance.
  assert.doesNotMatch(html, /role="alert"/)
  assert.doesNotMatch(html, /云端服务暂时不可用/)
  assert.match(html, />重试<\/button>/)
  assert.doesNotMatch(html, /邮箱|密码|创建账户/)

  const app = readFileSync(new URL("../src/app/App.tsx", import.meta.url), "utf8")
  assert.match(app, /notifyLive\(/)
  assert.match(app, /SESSION_CHECK_LIVE/)

  assert.deepEqual(await loadAuthState(readOverview), {
    phase: "authenticated",
    overview: authenticated,
  })
})

test("session startup recovers from one transient Cloud failure", async () => {
  let attempts = 0
  const authenticated = {
    ...anonymousOverview,
    session: { authenticated: true, email: "seller@example.invalid" },
  }
  const readOverview = async () => {
    attempts += 1
    if (attempts === 1) throw new Error("云端服务暂时不可用")
    return authenticated
  }

  assert.deepEqual(await loadAuthState(readOverview), {
    phase: "authenticated",
    overview: authenticated,
  })
  assert.equal(attempts, 2)
})

test("a confirmed anonymous session still opens the public homepage", async () => {
  assert.deepEqual(await loadAuthState(async () => anonymousOverview), {
    phase: "anonymous",
  })
  assert.deepEqual(authStateForOverview(anonymousOverview), {
    phase: "anonymous",
  })
})

test("a 401 retires only a painted shell and never re-probes itself", () => {
  // The startup probe is an account-overview call of its own, and the fetch
  // client reports every 401 on `window`. Treating the probe's own refusal as
  // "someone signed out" re-ran it once per 401 — a stale Cookie made an
  // anonymous tab refetch hundreds of times per second.
  assert.equal(refusalRetiresSession("authenticated"), true)
  assert.equal(refusalRetiresSession("loading"), false)
  assert.equal(refusalRetiresSession("anonymous"), false)
  assert.equal(refusalRetiresSession("failed"), false)

  const source = readFileSync(new URL("../src/app/App.tsx", import.meta.url), "utf8")
  assert.match(source, /refusalRetiresSession\(phaseRef\.current\)/)
  assert.match(source, /const probingRef = useRef\(false\)/)
})

test("product version label is vX.Y.Z from root VERSION", () => {
  assert.equal(productVersionLabel("0.0.14"), "v0.0.14")
  assert.equal(productVersionLabel("0.0.13"), "v0.0.13")
  assert.equal(productVersionLabel(" 0.0.13 "), "v0.0.13")
  assert.equal(productVersionLabel(""), "")
  const login = readFileSync(
    new URL("../src/features/account/login-screen.tsx", import.meta.url),
    "utf8",
  )
  const identity = readFileSync(
    new URL("../src/lib/product-version.ts", import.meta.url),
    "utf8",
  )
  assert.match(login, /productVersionLabel/)
  assert.match(login, /login-mark-version/)
  assert.match(identity, /PODHUB_VERSION/)
  assert.doesNotMatch(login, /v0\.0\.\d+/)
  assert.doesNotMatch(identity, /v0\.0\.\d+/)
})

test("the authenticator field stays hidden until the server asks for a code", () => {
  const html = renderToStaticMarkup(
    <LoginScreen onSignedIn={() => undefined} />,
  )
  assert.doesNotMatch(html, /验证器验证码/)
  const source = readFileSync(
    new URL("../src/features/account/login-screen.tsx", import.meta.url),
    "utf8",
  )
  assert.match(source, /commandErrorCode\(reason\) === "cloud_totp_required"/)
  assert.match(source, /htmlFor="access-totp"/)
  assert.match(source, /autoComplete="one-time-code"/)
})

test("login form keeps failures in the toast host and labelled fields", () => {
  const source = readFileSync(
    new URL("../src/features/account/login-screen.tsx", import.meta.url),
    "utf8",
  )
  // No error text renders into the page: no summary banner, no FieldError;
  // failures surface through notifyError/notifyCommandError and fields only
  // carry the invalid mark.
  assert.doesNotMatch(source, /role="alert"/)
  assert.doesNotMatch(source, /FieldError/)
  assert.doesNotMatch(source, /errorSummaryRef/)
  assert.match(source, /notifyCommandError\(reason, message\)/)
  assert.match(source, /notifyError\(issue\.message\)/)
  assert.match(source, /aria-invalid/)
  assert.match(source, /htmlFor="access-email"/)
  assert.match(source, /htmlFor="access-password"/)
  assert.doesNotMatch(source, /placeholder="邮箱"/)
})

test("registration password validation is local and actionable", () => {
  assert.deepEqual(registrationPasswordIssue("short", "short"), {
    field: "password",
    message: "密码至少需要 8 个字符",
  })
  assert.deepEqual(registrationPasswordIssue("password-123", "password-456"), {
    field: "confirmation",
    message: "两次输入的密码不一致",
  })
  assert.equal(
    registrationPasswordIssue("password-123", "password-123"),
    undefined,
  )
})

test("empty submit names the missing fields for the toast and aria-invalid", () => {
  // S9.6: 空提交反馈不依赖原生 required 气泡（部分嵌入环境不可见）。
  // 两缺给合并句，单缺点名——toast 说清缺什么，字段只打 aria-invalid。
  assert.deepEqual(emptyAccessCheck("", ""), {
    emailMissing: true,
    passwordMissing: true,
    message: "请输入邮箱与密码",
  })
  assert.deepEqual(emptyAccessCheck("", "pw"), {
    emailMissing: true,
    passwordMissing: false,
    message: "请输入邮箱",
  })
  assert.deepEqual(emptyAccessCheck("a@b.c", ""), {
    emailMissing: false,
    passwordMissing: true,
    message: "请输入密码",
  })
  assert.deepEqual(emptyAccessCheck("a@b.c", "pw"), {
    emailMissing: false,
    passwordMissing: false,
    message: undefined,
  })
  // 空白邮箱等同未填。
  assert.equal(emptyAccessCheck("   ", "pw").emailMissing, true)
})

test("empty submit feedback rides the toast host and never the page DOM", () => {
  const source = readFileSync(
    new URL("../src/features/account/login-screen.tsx", import.meta.url),
    "utf8",
  )
  // 邮箱字段与密码字段同样打 aria-invalid；失败文案只走 notifyError。
  assert.match(source, /notifyError\(empty\.message\)/)
  assert.match(source, /aria-invalid=\{Boolean\(emailError\)\}/)
  assert.match(source, /aria-invalid=\{Boolean\(passwordError\)\}/)
  // 不依赖原生 required：表单不再用它拦截空提交，浏览器气泡不可见的
  // 嵌入环境也能拿到 toast 反馈。（属性原是独立成行的 bare required。）
  assert.doesNotMatch(source, /^\s+required$/m)
  assert.doesNotMatch(source, /role="alert"/)
  assert.doesNotMatch(source, /FieldError/)

  const html = renderToStaticMarkup(
    <LoginScreen onSignedIn={() => undefined} />,
  )
  // 干净状态不带无效标记；错误文本不在 DOM。
  assert.doesNotMatch(html, /aria-invalid="true"/)
  assert.doesNotMatch(html, /请输入邮箱与密码/)
})
