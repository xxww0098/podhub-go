import { useRef, useState } from "react"
import { Eye, EyeOff } from "lucide-react"
import { motion, useReducedMotion } from "motion/react"
import type { AccountOverview } from "@/bindings/commands"
import { accountHttp } from "@/bindings/http-account"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from "@/components/ui/input-group"
import { Spinner } from "@/components/ui/spinner"
import { commandErrorCode } from "@/lib/error-message"
import { notifyCommandError, notifyError } from "@/lib/notify"
import { PasswordRecoveryButton } from "@/features/account/login-screen-password-recovery"

import "./factory-login-screen.css"

export function factoryLoginMissing(email: string, password: string) {
  const emailMissing = email.trim() === ""
  const passwordMissing = password === ""
  return {
    emailMissing,
    passwordMissing,
    message: emailMissing && passwordMissing
      ? "请输入邮箱与密码"
      : emailMissing
        ? "请输入邮箱"
        : passwordMissing
          ? "请输入密码"
          : undefined,
  }
}

export function handleFactorySignInError(
  reason: unknown,
  handover: (() => void) | undefined,
  notify: (reason: unknown, fallback: string) => void,
) {
  if (commandErrorCode(reason) === "cloud_password_change_required") {
    if (handover) handover()
    else notify(reason, "请先修改初始密码。")
    return
  }
  notify(reason, "登录失败。请检查邮箱和密码。")
}

export function FactoryLoginScreen({
  onSignedIn,
  onPasswordChangeRequired,
}: {
  onSignedIn: (overview: AccountOverview) => void
  onPasswordChangeRequired?: () => void
}) {
  const emailInput = useRef<HTMLInputElement>(null)
  const passwordInput = useRef<HTMLInputElement>(null)
  const [email, setEmail] = useState("")
  const [password, setPassword] = useState("")
  const [emailInvalid, setEmailInvalid] = useState(false)
  const [passwordInvalid, setPasswordInvalid] = useState(false)
  const [showPassword, setShowPassword] = useState(false)
  const [busy, setBusy] = useState(false)
  const reducedMotion = useReducedMotion()

  async function submit() {
    if (busy) return
    const missing = factoryLoginMissing(email, password)
    setEmailInvalid(missing.emailMissing)
    setPasswordInvalid(missing.passwordMissing)
    if (missing.message) {
      notifyError(missing.message)
      const firstInvalid = missing.emailMissing ? emailInput : passwordInput
      firstInvalid.current?.focus()
      return
    }
    setBusy(true)
    try {
      const overview = await accountHttp.accountLogin({ email, password })
      setPassword("")
      onSignedIn(overview)
    } catch (reason) {
      handleFactorySignInError(reason, onPasswordChangeRequired && (() => {
        setBusy(false)
        onPasswordChangeRequired()
      }), notifyCommandError)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="factory-login-screen grid min-h-svh lg:grid-cols-[minmax(0,1.05fr)_minmax(0,0.95fr)]">
      <aside className="flex flex-col overflow-hidden border-b border-border px-6 pt-6 sm:px-10 lg:min-h-svh lg:border-r lg:border-b-0 lg:px-12 lg:pt-10 lg:pb-8">
        <header className="flex items-center gap-2.5 border-b border-border pb-5">
          <img src="/app-icon.svg" alt="" width={28} height={28} />
          <a href="/" className="text-lg font-bold tracking-[-0.02em]">PodHub</a>
        </header>
        <div className="flex flex-1 flex-col pt-10 lg:pt-19">
          <h1 className="factory-login-statement font-extrabold tracking-[-0.045em]">
            让每一单有序生产
          </h1>
          <p className="factory-login-subtitle mt-6">接单 · 生产 · 发货</p>
          <img
            className="mt-8 hidden h-[min(51vh,34rem)] w-[calc(100%+3rem)] max-w-none object-cover object-right lg:mt-auto lg:block"
            src="/site/hero-tote.jpg"
            alt="印有植物图案的帆布包"
          />
        </div>
      </aside>

      <main className="flex items-center justify-center px-6 py-12 sm:px-10 lg:px-16">
        <motion.div
          className="w-full max-w-[28.75rem]"
          {...(reducedMotion ? {} : {
            initial: { opacity: 0, x: 12 },
            animate: { opacity: 1, x: 0 },
            transition: { duration: 0.4, ease: [0.16, 1, 0.3, 1] as const },
          })}
        >
          <Card>
            <CardHeader className="gap-1">
              <CardTitle><h2>工厂登录</h2></CardTitle>
              <CardDescription>账号由平台管理员开通</CardDescription>
            </CardHeader>
            <CardContent>
              <form className="flex flex-col gap-6" onSubmit={(event) => { event.preventDefault(); void submit() }}>
                <FieldGroup>
                  <Field data-invalid={emailInvalid || undefined}>
                    <FieldLabel htmlFor="factory-login-email">邮箱</FieldLabel>
                    <Input
                      ref={emailInput}
                      id="factory-login-email"
                      type="email"
                      autoComplete="email"
                      className="h-11"
                      value={email}
                      aria-invalid={emailInvalid}
                      onChange={(event) => { setEmail(event.target.value); setEmailInvalid(false) }}
                    />
                  </Field>
                  <Field data-invalid={passwordInvalid || undefined}>
                    <div className="flex items-center justify-between gap-3">
                      <FieldLabel htmlFor="factory-login-password">密码</FieldLabel>
                      <PasswordRecoveryButton email={email} disabled={busy} />
                    </div>
                    <InputGroup className="h-11">
                      <InputGroupInput
                        ref={passwordInput}
                        id="factory-login-password"
                        type={showPassword ? "text" : "password"}
                        autoComplete="current-password"
                        className="h-full"
                        value={password}
                        aria-invalid={passwordInvalid}
                        onChange={(event) => { setPassword(event.target.value); setPasswordInvalid(false) }}
                      />
                      <InputGroupAddon align="inline-end">
                        <InputGroupButton
                          type="button"
                          size="icon-sm"
                          aria-label={showPassword ? "隐藏密码" : "显示密码"}
                          aria-pressed={showPassword}
                          onClick={() => setShowPassword((shown) => !shown)}
                        >
                          {showPassword ? <EyeOff aria-hidden /> : <Eye aria-hidden />}
                        </InputGroupButton>
                      </InputGroupAddon>
                    </InputGroup>
                  </Field>
                </FieldGroup>
                <Button type="submit" variant="brand" size="lg" className="h-12 w-full" disabled={busy}>
                  {busy ? <Spinner data-icon="inline-start" /> : null}
                  登录
                </Button>
                <div className="border-t border-border pt-4 text-center">
                  <a href="/" className="text-sm font-medium text-brand hover:underline">返回首页</a>
                </div>
              </form>
            </CardContent>
          </Card>
        </motion.div>
      </main>
    </div>
  )
}
