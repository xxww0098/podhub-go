import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react"
import { AlertTriangle } from "lucide-react"
import type { AccountOverview } from "@/bindings/commands"
import { accountHttp } from "@/bindings/http-account"
import { Button } from "@/components/ui/button"
import { Empty, EmptyContent, EmptyMedia } from "@/components/ui/empty"
import { Spinner } from "@/components/ui/spinner"
import { LoginScreen } from "@/features/account/login-screen"
import {
  invalidateAccountOverview,
  rememberAccountOverview,
} from "@/features/account/account-overview-cache"
import { PublicSite } from "@/features/site/public-site"
import { SupplierApp } from "@/features/supplier/supplier-app"
import { UNAUTHENTICATED_EVENT } from "@/api/client"
import { useAddress } from "@/hooks/use-address"
import { replaceAddress } from "@/lib/address"
import { resolveRoute, routeAudienceFor } from "@/lib/app-route"
import type { PageKey } from "@/lib/public-pages"
import { commandErrorCode, errorMessage } from "@/lib/error-message"
import { clearLive, notifyLive } from "@/lib/notify"
import { isSupplierPath } from "@/lib/supplier-surface"
import { invalidateAllSessionCaches } from "@/lib/session-cache"
import { useInvitationCredential } from "@/lib/invitation-link"

/**
 * Anonymous first paint is the marketing homepage. Login lives at `/login`
 * (top-right nav). The signed-in shell stays behind one `lazy()` so an
 * anonymous session never downloads AppShell / 上架.
 */
const AuthenticatedApp = lazy(async () => ({
  default: (await import("@/app/authenticated-app")).AuthenticatedApp,
}))

type AuthState =
  | { phase: "loading" }
  | { phase: "anonymous" }
  | { phase: "failed"; message: string; reason?: unknown }
  | { phase: "authenticated"; overview: AccountOverview }

/**
 * First paint asks Cloud who the caller is. There is no local session file to
 * restore from any more — the `sid` Cookie is the whole credential, so a 401
 * is the answer "anonymous", not a failure to retry.
 */
export async function loadAuthState(
  readOverview: () => Promise<AccountOverview> = accountHttp.accountGetOverview,
): Promise<AuthState> {
  let failure: unknown
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      return authStateForOverview(await readOverview())
    } catch (reason) {
      if (commandErrorCode(reason) === "unauthenticated") {
        return { phase: "anonymous" }
      }
      failure = reason
    }
  }
  return {
    phase: "failed",
    reason: failure,
    message: errorMessage(
      failure,
      "暂时无法检查会话，请检查网络或云端服务后重试。",
    ),
  }
}

export function authStateForOverview(overview: AccountOverview): AuthState {
  return overview.session.authenticated
    ? { phase: "authenticated", overview }
    : { phase: "anonymous" }
}

/**
 * A 401 may only retire a shell that was painted from a live session.
 *
 * The startup probe (`loadAuthState`) is itself an `account-overview` call, and
 * the fetch client reports every 401 on `window`. Re-probing on the probe's own
 * refusal made an anonymous visitor refetch forever — one more 401 per attempt
 * (measured: hundreds per second while a stale Cookie stayed in the browser).
 * While loading, already anonymous, or failed, the 401 is the probe's own
 * answer and must not schedule another one.
 */
export function refusalRetiresSession(
  phase: "loading" | "anonymous" | "failed" | "authenticated",
): boolean {
  return phase === "authenticated"
}

function publishAuthOverview(overview: AccountOverview): AuthState {
  const next = authStateForOverview(overview)
  if (next.phase === "authenticated") rememberAccountOverview(overview)
  else invalidateAccountOverview()
  return next
}

const SESSION_CHECK_LIVE = "session-check"

/** The persistent "session probe failed" notice; hosts the retry, clears on unmount. */
function useSessionCheckNotice(message: string, onRetry: () => void, reason?: unknown) {
  // Failure copy lives in the toast host, never in the page; the persistent
  // row carries the retry and clears when this screen unmounts. The ref keeps
  // an inline parent callback from re-firing the notice on unrelated renders.
  const onRetryRef = useRef(onRetry)
  onRetryRef.current = onRetry

  useEffect(() => {
    notifyLive({
      id: SESSION_CHECK_LIVE,
      type: "error",
      reason,
      title: message,
      action: { label: "重试", onClick: () => onRetryRef.current() },
    })
    return () => clearLive(SESSION_CHECK_LIVE)
  }, [message, reason])
}

export function SessionCheckFailed({
  message,
  onRetry,
  reason,
}: {
  message: string
  onRetry: () => void
  reason?: unknown
}) {
  useSessionCheckNotice(message, onRetry, reason)

  return (
    <main className="flex min-h-svh items-center justify-center bg-background px-6">
      <Empty className="max-w-md flex-none">
        <EmptyMedia variant="icon">
          <AlertTriangle />
        </EmptyMedia>
        <EmptyContent>
          <Button variant="outline" onClick={onRetry}>
            重试
          </Button>
        </EmptyContent>
      </Empty>
    </main>
  )
}

/** A public page that still paints while the session probe is down. */
function PublicSiteSessionDown({
  page,
  message,
  onRetry,
}: {
  page: PageKey
  message: string
  onRetry: () => void
}) {
  useSessionCheckNotice(message, onRetry)
  return <PublicSite page={page} />
}

export function App() {
  const invitationCredential = useInvitationCredential()
  const [auth, setAuth] = useState<AuthState>({ phase: "loading" })
  const [attempt, setAttempt] = useState(0)
  // The account switcher's "添加账号" routes the signed-in operator through
  // the login form again; Cloud stacks the fresh session on this browser.
  const [addingAccount, setAddingAccount] = useState(false)
  // The address is the only navigation state: the resolver below turns
  // (address + standing) into the surface this render paints.
  const address = useAddress()
  // The phase a refusal is judged against, render-synced so a probe that ends
  // authenticated re-arms the listener.
  const phaseRef = useRef(auth.phase)
  phaseRef.current = auth.phase
  // True from the moment a probe starts until it settles, so a burst of
  // concurrent 401s cannot stack one session check per refusal.
  const probingRef = useRef(false)

  useEffect(() => {
    let cancelled = false
    probingRef.current = true
    void loadAuthState().then((next) => {
      if (cancelled) return
      probingRef.current = false
      if (next.phase === "authenticated") rememberAccountOverview(next.overview)
      else invalidateAccountOverview()
      setAuth(next)
    })
    return () => {
      cancelled = true
    }
  }, [attempt])

  // "Signed out" now means "the presented session ended" — the browser's
  // session stack may still hold other accounts (Notion-style logout moves
  // to the next one), so re-probe instead of assuming anonymous.
  const signedOut = useCallback(() => {
    if (!refusalRetiresSession(phaseRef.current) || probingRef.current) return
    // Fence until the fresh probe settles: the stale Cookie may refuse many
    // in-flight requests before it answers.
    probingRef.current = true
    invalidateAllSessionCaches()
    setAttempt((current) => current + 1)
  }, [])

  // Any call can be the one that discovers the Cookie expired. The fetch
  // client says so once on `window`; the shell answers by falling back here
  // instead of every screen learning to recognise a 401.
  useEffect(() => {
    window.addEventListener(UNAUTHENTICATED_EVENT, signedOut)
    return () => window.removeEventListener(UNAUTHENTICATED_EVENT, signedOut)
  }, [signedOut])
  const overviewChanged = useCallback((overview: AccountOverview) => {
    setAuth(publishAuthOverview(overview))
  }, [])

  if (auth.phase === "loading") {
    return (
      <div className="flex min-h-svh items-center justify-center bg-background">
        <Spinner className="size-5" aria-label="正在检查会话" />
      </div>
    )
  }

  if (auth.phase === "failed") {
    const retry = () => {
      setAuth({ phase: "loading" })
      setAttempt((current) => current + 1)
    }
    // A dead Cloud must not take the marketing pages with it: they need no
    // session, so a public address still paints while the retry notice rides
    // the toast host. Only workbench and admin addresses get the retry wall.
    const route = resolveRoute(address, routeAudienceFor({ authenticated: false }))
    if (route.kind === "public") {
      return (
        <PublicSiteSessionDown
          page={route.page}
          message={auth.message}
          onRetry={retry}
        />
      )
    }
    return <SessionCheckFailed message={auth.message} onRetry={retry} reason={auth.reason} />
  }

  const signIn = (next: AccountOverview) => {
    // `/login` is the workbench's front door and leaves the address on `/`;
    // `/admin` is an address of its own and must survive sign-in, so only the
    // exact login path is rewritten — and the whole URL with it, because an
    // `?invite=` code was already spent by the form and must not come back as
    // a late claim.
    if (window.location.pathname === "/login") replaceAddress("/")
    setAuth(publishAuthOverview(next))
  }

  if (auth.phase === "anonymous") {
    if (invitationCredential) return <LoginScreen onSignedIn={signIn} />
    // Anonymous standing has exactly two outcomes: a public page, or the way
    // in. `/admin` resolves to the login page and keeps its address.
    // `/supplier` is the factory surface's own boundary: an anonymous visitor
    // gets the embedded 厂家登录卡 on the same address (ADR-0100 §E.20).
    if (isSupplierPath(address.pathname)) {
      return <SupplierApp onSignedIn={signIn} />
    }
    const route = resolveRoute(address, routeAudienceFor({ authenticated: false }))
    return route.kind === "public" ? (
      <PublicSite page={route.page} />
    ) : (
      <LoginScreen onSignedIn={signIn} />
    )
  }

  const overview = auth.overview
  const route = resolveRoute(
    address,
    routeAudienceFor({
      authenticated: true,
      role: overview.session.role,
      accountMode: overview.account_mode,
      isAgent: overview.is_agent,
    }),
  )

  // The public pages stay readable while signed in; only a workbench or admin
  // address gets the shell (and its gates).
  if (route.kind === "public" && !invitationCredential) {
    return <PublicSite page={route.page} signedIn />
  }

  // `/supplier` is the factory surface's own address boundary, like `/admin`:
  // a signed-in caller paints the queue face (members) or the refusal gate —
  // a signed-in seller keeps their workbench everywhere else, and reaches the
  // queue through the site nav's 厂家登录 entry.
  if (isSupplierPath(address.pathname)) {
    return (
      <SupplierApp
        overview={overview}
        onSignedOut={signedOut}
      />
    )
  }

  if (addingAccount) {
    // A fresh login swaps `sid` to the new account — reload so nothing
    // account-scoped stays mounted from the account we just left.
    return (
      <LoginScreen
        onCancel={() => setAddingAccount(false)}
        onSignedIn={() => window.location.assign("/")}
      />
    )
  }
  return (
    <Suspense
      fallback={(
        <div className="flex min-h-svh items-center justify-center bg-background">
          <Spinner className="size-5" aria-label="正在打开工作台" />
        </div>
      )}
    >
      <AuthenticatedApp
        overview={overview}
        onOverviewChange={overviewChanged}
        onSignedOut={signedOut}
        onAddAccount={() => setAddingAccount(true)}
      />
    </Suspense>
  )
}
