import { useCallback, useEffect, useRef, useState, type ReactNode } from "react"
import type { AccountOverview } from "@/bindings/commands"
import { accountHttp } from "@/bindings/http-account"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Spinner } from "@/components/ui/spinner"
import { getFactoryMe, type FactoryMe } from "@/factory/api"
import { FactoryLoginScreen } from "@/factory/login/factory-login-screen"
import { FactoryWorkspace } from "@/factory/factory-workspace"
import { commandErrorCode } from "@/lib/error-message"
import { notifyCommandError } from "@/lib/notify"

export async function signOutFactory(onSignedOut?: () => void): Promise<void> {
  await accountHttp.accountLogout()
  if (onSignedOut) onSignedOut()
  else if (typeof window !== "undefined") window.location.assign("/supplier")
}

type Membership =
  | { phase: "probing" }
  | { phase: "member"; me: FactoryMe }
  | { phase: "not-member" }
  | { phase: "error" }

export function FactoryApp({
  overview,
  onSignedIn,
  onSignedOut,
  onPasswordChangeRequired,
  fallback,
}: {
  overview?: AccountOverview
  onSignedIn?: (overview: AccountOverview) => void
  onSignedOut?: () => void
  onPasswordChangeRequired?: () => void
  fallback?: ReactNode
}) {
  const [membership, setMembership] = useState<Membership>(overview ? { phase: "probing" } : { phase: "not-member" })
  const [attempt, setAttempt] = useState(0)
  const signingOut = useRef(false)
  const signOut = useCallback(() => {
    if (signingOut.current) return
    signingOut.current = true
    void signOutFactory(onSignedOut).catch((reason: unknown) => {
      signingOut.current = false
      notifyCommandError(reason, "无法退出登录，请稍后重试。")
    })
  }, [onSignedOut])

  useEffect(() => {
    if (!overview) {
      setMembership({ phase: "not-member" })
      return
    }
    let cancelled = false
    setMembership({ phase: "probing" })
    getFactoryMe().then((me) => {
      if (!cancelled) setMembership({ phase: "member", me })
    }).catch((reason: unknown) => {
      if (cancelled) return
      const code = commandErrorCode(reason)
      setMembership(code === "cloud_forbidden" ? { phase: "not-member" } : { phase: "error" })
    })
    return () => { cancelled = true }
  }, [overview, attempt])

  if (!overview) {
    return <FactoryLoginScreen onSignedIn={onSignedIn ?? (() => {})} onPasswordChangeRequired={onPasswordChangeRequired} />
  }
  if (membership.phase === "probing") {
    return <div className="flex min-h-svh items-center justify-center bg-background">
      <Spinner className="size-5" aria-label="正在确认工厂工作空间" />
    </div>
  }
  if (membership.phase === "error") {
    return <div className="flex min-h-svh items-center justify-center bg-background px-6">
      <Card className="w-full max-w-md">
        <CardHeader><CardTitle>无法读取工厂工作空间</CardTitle><CardDescription>请检查网络后重试。</CardDescription></CardHeader>
        <CardContent><Button onClick={() => setAttempt((value) => value + 1)}>重试</Button></CardContent>
      </Card>
    </div>
  }
  if (membership.phase === "member") {
    if (!membership.me.sources.length) return <div className="flex min-h-svh items-center justify-center bg-background px-6">
      <Card className="w-full max-w-md">
        <CardHeader><CardTitle>工厂账号已开通</CardTitle><CardDescription>商品库绑定并授予履约权限后，可在这里处理订单。</CardDescription></CardHeader>
        <CardContent><Button type="button" variant="outline" onClick={signOut}>退出登录</Button></CardContent>
      </Card>
    </div>
    return <FactoryWorkspace
      sources={membership.me.sources}
      accountName={overview.session.name?.trim() || overview.session.email?.trim() || ""}
      accountEmail={overview.session.email ?? undefined}
      onSignedOut={signOut}
    />
  }
  if (fallback) return <>{fallback}</>
  return <div className="flex min-h-svh items-center justify-center bg-background px-6">
    <Card className="w-full max-w-md">
      <CardHeader>
        <CardTitle>这不是工厂账号</CardTitle>
        <CardDescription>这个账号看不到订单。工厂账号由管理员开通。</CardDescription>
      </CardHeader>
      <CardContent className="flex gap-2">
        <Button nativeButton={false} render={<a href="/">进入工作台</a>} />
        <Button type="button" variant="outline" onClick={signOut}>退出登录</Button>
      </CardContent>
    </Card>
  </div>
}
