import { forwardRef, useState, type ComponentProps, type ReactNode } from "react"
import { motion, useReducedMotion } from "motion/react"
import { ArrowLeft, Eye, EyeOff, LogIn, UserPlus } from "lucide-react"
import type { AccountLoginRequest, AccountOverview, AccountRegisterRequest } from "@/bindings/commands"
import { accountHttp } from "@/bindings/http-account"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field"
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from "@/components/ui/input-group"
import { Input } from "@/components/ui/input"
import { Spinner } from "@/components/ui/spinner"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { commandErrorCode } from "@/lib/error-message"
import { notifyCommandError, notifyError, notifySuccess } from "@/lib/notify"
import { productVersionLabel } from "@/lib/product-version"

const EASE_SETTLE = [0.16, 1, 0.3, 1] as const

type LoginEnterProps = {
  delay?: number
  children?: ReactNode
  className?: string
} & (
  | { as?: "div" }
  | { as: "p" }
  | ({ as: "img" } & Pick<ComponentProps<"img">, "src" | "alt" | "width" | "height">)
)

/**
 * Staggered entrance for the sign-in story. Reduced motion paints in place.
 * `as` renders the motion element itself so a direct-child selector still matches.
 */
function LoginEnter({
  as = "div",
  delay = 0,
  children,
  className,
  ...rest
}: LoginEnterProps) {
  const reduced = useReducedMotion()
  const motionProps = reduced
    ? {}
    : {
        initial: { opacity: 0, y: 10 },
        animate: { opacity: 1, y: 0 },
        transition: { duration: 0.42, delay, ease: EASE_SETTLE },
      }
  if (as === "p") {
    const Tag = reduced ? "p" : motion.p
    return (
      <Tag className={className} {...motionProps}>
        {children}
      </Tag>
    )
  }
  if (as === "img") {
    const Tag = reduced ? "img" : motion.img
    const { src, alt, width, height } = rest as Extract<LoginEnterProps, { as: "img" }>
    return <Tag className={className} src={src} alt={alt} width={width} height={height} {...motionProps} />
  }
  const Tag = reduced ? "div" : motion.div
  return (
    <Tag className={className} {...motionProps}>
      {children}
    </Tag>
  )
}

/**
 * Forwards the motion ref onto `Card`, so the card stays a direct child of
 * `main` and `.login-screen main > [data-slot="card"]` still matches.
 */
const LoginCard = motion.create(
  forwardRef<HTMLDivElement, ComponentProps<typeof Card>>(function LoginCard(
    { className, ...props },
    ref,
  ) {
    return <Card {...props} ref={ref} className={className} />
  }),
)

type LoginScreenProps = {
  onSignedIn: (overview: AccountOverview) => void
  /**
   * Present when the account switcher sent a signed-in operator here to add
   * another account: the card offers a way back, and a successful sign-in
   * stacks the new session on this browser instead of replacing it.
   */
  onCancel?: () => void
}

type AccessMode = "login" | "register" | "forgot"

export type RegistrationPasswordIssue = {
  field: "password" | "confirmation"
  message: string
}

export function registrationPasswordIssue(
  password: string,
  confirmation: string,
): RegistrationPasswordIssue | undefined {
  if (Array.from(password).length < 8) {
    return { field: "password", message: "密码至少需要 8 个字符" }
  }
  if (password !== confirmation) {
    return { field: "confirmation", message: "两次输入的密码不一致" }
  }
  return undefined
}

/**
 * Empty-submit verdict for both access modes. The inputs carry no native
 * `required` (its bubble is invisible in some embedded environments), so the
 * form's submit handler owns the check: missing fields get one toast plus
 * `aria-invalid` on exactly the empty inputs — no error text enters the DOM.
 */
export function emptyAccessCheck(
  email: string,
  password: string,
): { emailMissing: boolean; passwordMissing: boolean; message?: string } {
  const emailMissing = email.trim() === ""
  const passwordMissing = password === ""
  const message =
    emailMissing && passwordMissing
      ? "请输入邮箱与密码"
      : emailMissing
        ? "请输入邮箱"
        : passwordMissing
          ? "请输入密码"
          : undefined
  return { emailMissing, passwordMissing, message }
}

/**
 * `/login?invite=CODE` is an Agent's invite link (`docs/agent-rebate.md`): the
 * code is prefilled and the form opens on 创建账户. Anything else in the
 * parameter is still just typed text the server judges.
 */
export function inviteCodeFromSearch(search: string): string {
  return new URLSearchParams(search).get("invite")?.trim().toUpperCase() ?? ""
}

export function LoginScreen({ onSignedIn, onCancel }: LoginScreenProps) {
  const [inviteCode, setInviteCode] = useState(() =>
    typeof window === "undefined" ? "" : inviteCodeFromSearch(window.location.search),
  )
  const [mode, setMode] = useState<AccessMode>(inviteCode ? "register" : "login")
  const [name, setName] = useState("")
  const [email, setEmail] = useState("")
  const [password, setPassword] = useState("")
  const [passwordConfirmation, setPasswordConfirmation] = useState("")
  const [passwordError, setPasswordError] = useState<string>()
  const [confirmationError, setConfirmationError] = useState<string>()
  const [emailError, setEmailError] = useState<string>()
  const [showPassword, setShowPassword] = useState(false)
  const [totpCode, setTotpCode] = useState("")
  const [totpNeeded, setTotpNeeded] = useState(false)
  const [busy, setBusy] = useState(false)
  let cardTitle = "创建账户"
  if (mode === "login") cardTitle = "登录"
  if (mode === "forgot") cardTitle = "重置密码"
  if (onCancel) cardTitle = "添加账号"

  function switchMode(nextMode: AccessMode) {
    setMode(nextMode)
    setPassword("")
    setPasswordConfirmation("")
    setPasswordError(undefined)
    setConfirmationError(undefined)
    setEmailError(undefined)
    setShowPassword(false)
  }

  async function submitAccess() {
    const empty = emptyAccessCheck(email, mode === "forgot" ? "present" : password)
    if (empty.message) {
      // 空提交反馈不依赖原生 required 气泡（部分嵌入环境不可见）：一次性
      // toast + 只在空字段上打 aria-invalid，错误文案不进 DOM。
      setEmailError(empty.emailMissing ? "请输入邮箱" : undefined)
      setPasswordError(empty.passwordMissing ? "请输入密码" : undefined)
      notifyError(empty.message)
      return
    }
    setEmailError(undefined)
    if (mode === "register") {
      const issue = registrationPasswordIssue(password, passwordConfirmation)
      setPasswordError(issue?.field === "password" ? issue.message : undefined)
      setConfirmationError(
        issue?.field === "confirmation" ? issue.message : undefined,
      )
      if (issue) {
        notifyError(issue.message)
        return
      }
    }

    if (mode === "forgot") {
      setBusy(true)
      try {
        await accountHttp.accountForgotPassword(email.trim())
        notifySuccess("如果该邮箱已注册，我们已发送重置说明。")
        switchMode("login")
      } catch (reason) {
        notifyCommandError(reason, "无法发送重置说明，请稍后重试。")
      } finally {
        setBusy(false)
      }
      return
    }

    setBusy(true)
    try {
      const trimmedInvite = inviteCode.trim()
      const request: AccountLoginRequest | AccountRegisterRequest =
        mode === "login"
          ? { email, password, ...(totpNeeded && totpCode.trim() ? { totpCode: totpCode.trim() } : {}) }
          : {
              email,
              password,
              name,
              ...(trimmedInvite ? { inviteCode: trimmedInvite } : {}),
            }
      const overview =
        mode === "login"
          ? await accountHttp.accountLogin(request as AccountLoginRequest)
          : await accountHttp.accountRegister(request as AccountRegisterRequest)
      setPassword("")
      setPasswordConfirmation("")
      onSignedIn(overview)
    } catch (reason) {
      if (mode === "login" && commandErrorCode(reason) === "cloud_totp_required") {
        setTotpNeeded(true)
      }
      const message =
        mode === "login"
          ? "无法登录。请检查邮箱、密码和网络后重试。"
          : "无法创建账户。请检查填写内容后重试。"
      notifyCommandError(reason, message)
    } finally {
      setBusy(false)
    }
  }

  const versionLabel = productVersionLabel()
  const reducedMotion = useReducedMotion()

  return (
    <div className="login-screen relative grid min-h-svh bg-background lg:grid-cols-[minmax(0,1.05fr)_minmax(0,0.95fr)]">
      <aside className="c-login-aside flex flex-col border-b border-border bg-card lg:border-b-0 lg:border-r">
        <div className="flex flex-1 flex-col px-6 py-6 sm:px-10 lg:px-12 lg:py-10">
          <LoginEnter>
          <header className="login-masthead">
            <div className="login-mark">
              <img
                className="login-mark-icon"
                src="/app-icon.svg"
                alt=""
                width={28}
                height={28}
              />
              <a className="login-mark-name" href="/" aria-label="返回首页">
                PodHub
              </a>
            </div>
            {versionLabel ? (
              <span className="login-mark-version" aria-label={`版本 ${versionLabel}`}>
                {versionLabel}
              </span>
            ) : null}
          </header>
          </LoginEnter>

          <div className="login-thesis c-login-story">
            <LoginEnter delay={0.07}>
              <h1 className="login-statement">一张图要走的路</h1>
            </LoginEnter>
            <LoginEnter
              as="p"
              delay={0.14}
              className="login-statement-end"
            >
              按需印刷，上架到送达
            </LoginEnter>
            <LoginEnter delay={0.21}>
              <ol className="c-login-steps">
                <li>选品</li>
                <li>导图</li>
                <li>上架</li>
              </ol>
            </LoginEnter>
            <LoginEnter
              as="img"
              delay={0.28}
              className="c-login-photo"
              src="/site/hero-tote.jpg"
              alt="植物图案从设计稿应用到帆布包的商品效果"
            />
          </div>
        </div>
      </aside>

      <main className="relative flex items-center justify-center px-6 py-8 sm:px-10 sm:py-12 lg:px-16 lg:py-10">
        {onCancel ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="absolute left-6 top-6 sm:left-10"
            onClick={onCancel}
          >
            <ArrowLeft data-icon="inline-start" />
            返回
          </Button>
        ) : null}
        <LoginCard
          className="w-full max-w-sm"
          {...(reducedMotion
            ? {}
            : {
                initial: { opacity: 0, x: 14, filter: "blur(2px)" },
                animate: { opacity: 1, x: 0, filter: "blur(0px)" },
                transition: { duration: 0.56, delay: 0.12, ease: EASE_SETTLE },
              })}
        >
          <CardHeader className="items-center text-center">
            <CardTitle className="text-xl tracking-[-0.02em]">
              {cardTitle}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <form
              className="flex flex-col gap-6"
              onSubmit={(event) => {
                event.preventDefault()
                void submitAccess()
              }}
            >
              <FieldGroup>
                {mode === "register" ? (
                  <Field>
                    <FieldLabel htmlFor="register-name">姓名（可选）</FieldLabel>
                    <Input
                      id="register-name"
                      type="text"
                      autoComplete="name"
                      value={name}
                      onChange={(event) => setName(event.target.value)}
                    />
                  </Field>
                ) : null}
                <Field data-invalid={Boolean(emailError)}>
                  <FieldLabel htmlFor="access-email">邮箱</FieldLabel>
                  <Input
                    id="access-email"
                    type="email"
                    autoComplete="username"
                    autoFocus
                    aria-invalid={Boolean(emailError)}
                    value={email}
                    onChange={(event) => {
                      setEmail(event.target.value)
                      setEmailError(undefined)
                    }}
                  />
                </Field>
                {mode === "login" && totpNeeded ? (
                  <Field>
                    <FieldLabel htmlFor="access-totp">验证器验证码</FieldLabel>
                    <Input
                      id="access-totp"
                      type="text"
                      inputMode="numeric"
                      autoComplete="one-time-code"
                      value={totpCode}
                      onChange={(event) => setTotpCode(event.target.value)}
                    />
                  </Field>
                ) : null}
                {mode === "forgot" ? null : (
                <>
                <Field data-invalid={Boolean(passwordError)}>
                  <FieldLabel htmlFor="access-password">密码</FieldLabel>
                  <InputGroup>
                    <InputGroupInput
                      id="access-password"
                      type={showPassword ? "text" : "password"}
                      autoComplete={
                        mode === "login" ? "current-password" : "new-password"
                      }
                      aria-invalid={Boolean(passwordError)}
                      aria-describedby={
                        mode === "register" ? "register-password-help" : undefined
                      }
                      value={password}
                      onChange={(event) => {
                        setPassword(event.target.value)
                        setPasswordError(undefined)
                        setConfirmationError(undefined)
                      }}
                    />
                    <InputGroupAddon align="inline-end">
                      <Tooltip>
                        <TooltipTrigger
                          render={
                            <InputGroupButton
                              size="icon-xs"
                              aria-label={showPassword ? "隐藏密码" : "显示密码"}
                              aria-pressed={showPassword}
                              onClick={() => setShowPassword((visible) => !visible)}
                            />
                          }
                        >
                          {showPassword ? <EyeOff aria-hidden /> : <Eye aria-hidden />}
                        </TooltipTrigger>
                        <TooltipContent>{showPassword ? "隐藏密码" : "显示密码"}</TooltipContent>
                      </Tooltip>
                    </InputGroupAddon>
                  </InputGroup>
                  {mode === "register" ? (
                    <FieldDescription id="register-password-help">
                      至少 8 个字符
                    </FieldDescription>
                  ) : null}
                </Field>
                {mode === "register" ? (
                  <Field data-invalid={Boolean(confirmationError)}>
                    <FieldLabel htmlFor="register-password-confirmation">
                      确认密码
                    </FieldLabel>
                    <Input
                      id="register-password-confirmation"
                      type={showPassword ? "text" : "password"}
                      autoComplete="new-password"
                      aria-invalid={Boolean(confirmationError)}
                      value={passwordConfirmation}
                      onChange={(event) => {
                        setPasswordConfirmation(event.target.value)
                        setConfirmationError(undefined)
                      }}
                    />
                  </Field>
                ) : null}
                {mode === "register" ? (
                  <Field>
                    <FieldLabel htmlFor="register-invite-code">邀请码（可选）</FieldLabel>
                    <Input
                      id="register-invite-code"
                      type="text"
                      autoComplete="off"
                      autoCapitalize="characters"
                      spellCheck={false}
                      maxLength={32}
                      className="font-mono uppercase tracking-wider"
                      aria-describedby="register-invite-code-help"
                      value={inviteCode}
                      onChange={(event) => setInviteCode(event.target.value.toUpperCase())}
                    />
                    <FieldDescription id="register-invite-code-help">
                      有代理邀请码就填在这里；没有也可以直接注册
                    </FieldDescription>
                  </Field>
                ) : null}
                </>
                )}
              </FieldGroup>

              {mode === "login" ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={busy}
                  onClick={() => switchMode("forgot")}
                >
                  忘记密码
                </Button>
              ) : null}

              <Button type="submit" disabled={busy} className="w-full" size="lg" variant="brand">
                {busy ? (
                  <Spinner data-icon="inline-start" />
                ) : mode === "login" ? (
                  <LogIn data-icon="inline-start" />
                ) : (
                  <UserPlus data-icon="inline-start" />
                )}
                {mode === "login" ? "登录" : mode === "forgot" ? "发送重置邮件" : "创建账户"}
              </Button>
            </form>
            <div className="mt-5 flex items-center justify-center gap-1 border-t border-border pt-4 text-sm text-muted-foreground">
              <span>
                {mode === "login" ? "还没有账户？" : mode === "forgot" ? "想起密码了？" : "已经有账户？"}
              </span>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={busy}
                onClick={() =>
                  switchMode(mode === "login" ? "register" : "login")
                }
              >
                {mode === "login" ? "创建账户" : "返回登录"}
              </Button>
            </div>
          </CardContent>
        </LoginCard>
      </main>
    </div>
  )
}
