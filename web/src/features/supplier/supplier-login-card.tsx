/**
 * 厂家登录卡 (ADR-0100)：`/supplier` 面的未登录态内嵌登录卡。
 *
 * 只邮箱 + 密码，无注册模式——厂家账号由平台管理员在管理面开通。底层同一
 * `accountLogin`（同一会话），入口是页面分流不是第二套鉴权。
 * 失败文案走一次性 toast，不进 DOM。
 */
import { useState } from "react"
import type {
  AccountLoginRequest,
  AccountOverview,
} from "@/bindings/commands"
import { accountHttp } from "@/bindings/http-account"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Spinner } from "@/components/ui/spinner"
import { emptyAccessCheck } from "@/features/account/login-screen"
import { notifyCommandError, notifyError } from "@/lib/notify"

export function SupplierLoginCard({
  onSignedIn,
}: {
  onSignedIn: (overview: AccountOverview) => void
}) {
  const [email, setEmail] = useState("")
  const [password, setPassword] = useState("")
  const [emailInvalid, setEmailInvalid] = useState(false)
  const [passwordInvalid, setPasswordInvalid] = useState(false)
  const [busy, setBusy] = useState(false)

  async function submit() {
    const empty = emptyAccessCheck(email, password)
    setEmailInvalid(empty.emailMissing)
    setPasswordInvalid(empty.passwordMissing)
    if (empty.message) {
      notifyError(empty.message)
      return
    }
    setBusy(true)
    try {
      const request: AccountLoginRequest = { email, password }
      const overview = await accountHttp.accountLogin(request)
      setPassword("")
      onSignedIn(overview)
    } catch (reason) {
      notifyCommandError(reason, "登录失败。请检查邮箱和密码。")
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card className="w-full max-w-sm">
      <CardHeader className="items-center text-center">
        <CardTitle>工厂登录</CardTitle>
        <CardDescription>
          用管理员给你的邮箱和密码登录。
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form
          className="flex flex-col gap-6"
          onSubmit={(event) => {
            event.preventDefault()
            void submit()
          }}
        >
          <FieldGroup>
            <Field data-invalid={emailInvalid || undefined}>
              <FieldLabel htmlFor="supplier-login-email">邮箱</FieldLabel>
              <Input
                id="supplier-login-email"
                type="email"
                autoComplete="email"
                value={email}
                aria-invalid={emailInvalid}
                onChange={(event) => setEmail(event.target.value)}
              />
            </Field>
            <Field data-invalid={passwordInvalid || undefined}>
              <FieldLabel htmlFor="supplier-login-password">密码</FieldLabel>
              <Input
                id="supplier-login-password"
                type="password"
                autoComplete="current-password"
                value={password}
                aria-invalid={passwordInvalid}
                onChange={(event) => setPassword(event.target.value)}
              />
            </Field>
          </FieldGroup>
          <Button type="submit" disabled={busy}>
            {busy ? <Spinner data-icon="inline-start" /> : null}
            登录
          </Button>
        </form>
      </CardContent>
    </Card>
  )
}
