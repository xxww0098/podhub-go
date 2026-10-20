/**
 * `/supplier` 面 (ADR-0100)：厂家登录卡 → 排单屏的分流壳。
 *
 * - 匿名访问：内嵌厂家登录卡（只邮箱+密码，无注册模式）。
 * - 已登录：探一次 `/api/supplier/me`——有 active 成员行 → 排单屏；无 →
 *   画 `fallback`（无 Workspace 的普通账号回落到既有 NoWorkspaceGate，
 *   其他访问者看到拒入门）。探错与成员判定逐请求走服务端，停用即刻生效。
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react"
import type { AccountOverview } from "@/bindings/commands"
import { accountHttp } from "@/bindings/http-account"
import {
  getSupplierMe,
  type SupplierMeData,
} from "@/bindings/http-supplier-portal"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Spinner } from "@/components/ui/spinner"
import { notifyCommandError } from "@/lib/notify"

import { SupplierLoginCard } from "./supplier-login-card"
import { accountLabel, SupplierQueue } from "./supplier-queue"

/**
 * 先退出会话，再让壳重新探登录态。
 *
 * `onSignedOut` 只重探当前 Cookie。只调它，会话还在，`/supplier` 停在同一个账号。
 * 和工作台一样先 `accountLogout`：下一次探询是匿名，这面回到厂家登录卡。
 */
export async function signOutSupplier(onSignedOut: () => void): Promise<void> {
  await accountHttp.accountLogout()
  onSignedOut()
}

type Membership =
  | { phase: "probing" }
  | { phase: "member"; me: SupplierMeData }
  | { phase: "not-member" }

export function SupplierApp({
  overview,
  onSignedIn,
  onSignedOut,
  fallback,
}: {
  /** `undefined` = anonymous: the embedded factory login card paints. */
  overview?: AccountOverview
  onSignedIn?: (overview: AccountOverview) => void
  onSignedOut?: () => void
  /** Painted when signed in but the account holds no active membership. */
  fallback?: ReactNode
}) {
  const [membership, setMembership] = useState<Membership>(
    overview ? { phase: "probing" } : { phase: "not-member" },
  )
  const signingOut = useRef(false)
  const signOut = useCallback(() => {
    if (!onSignedOut || signingOut.current) return
    signingOut.current = true
    void signOutSupplier(onSignedOut).catch((reason: unknown) => {
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
    getSupplierMe()
      .then((me) => {
        if (!cancelled) setMembership({ phase: "member", me })
      })
      .catch(() => {
        // 401 由全局会话探针接管（发表即被踢回登录卡）；403/其余 = 非成员。
        if (!cancelled) setMembership({ phase: "not-member" })
      })
    return () => {
      cancelled = true
    }
  }, [overview])

  if (!overview) {
    return (
      <div className="flex min-h-svh items-center justify-center bg-background px-6">
        <div className="flex w-full max-w-sm flex-col items-center gap-6">
          <SupplierLoginCard onSignedIn={onSignedIn ?? (() => {})} />
          <Button
            variant="ghost"
            size="sm"
            nativeButton={false}
            render={
              <a href="/" aria-label="返回首页">
                返回首页
              </a>
            }
          />
        </div>
      </div>
    )
  }

  if (membership.phase === "probing") {
    return (
      <div className="flex min-h-svh items-center justify-center bg-background">
        <Spinner className="size-5" aria-label="正在确认账号" />
      </div>
    )
  }

  if (membership.phase === "member") {
    return (
      <SupplierQueue
        supplierNames={membership.me.sources.map((source) => source.name)}
        accountName={accountLabel(overview?.session.name, overview?.session.email)}
        onSignedOut={onSignedOut ? signOut : undefined}
      />
    )
  }

  if (fallback) return <>{fallback}</>
  return (
    <div className="flex min-h-svh items-center justify-center bg-background px-6">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle>这不是工厂账号</CardTitle>
          <CardDescription>
            这个账号看不到订单。工厂账号由管理员开通。卖家请去工作台。
          </CardDescription>
        </CardHeader>
        <CardContent className="flex gap-2">
          <Button nativeButton={false} render={<a href="/">进入工作台</a>} />
          {onSignedOut ? (
            <Button type="button" variant="outline" onClick={signOut}>
              退出登录
            </Button>
          ) : null}
        </CardContent>
      </Card>
    </div>
  )
}
