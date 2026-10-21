import { useState } from "react"
import { Eye, EyeOff, KeyRound, ShieldAlert } from "lucide-react"

import { accountHttp } from "@/bindings/http-account"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Field, FieldLabel } from "@/components/ui/field"
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from "@/components/ui/input-group"
import { Spinner } from "@/components/ui/spinner"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { commandErrorCode, errorMessage } from "@/lib/error-message"
import { notifyError } from "@/lib/notify"
import { productVersionLabel } from "@/lib/product-version"

/**
 * The forced password change screen (doc §4.2).
 *
 * Cloud's deny-by-default gate answers every route with
 * 403 `PASSWORD_CHANGE_REQUIRED` while `must_change_password` is true, and
 * `/api/view/account-overview` — the boot probe — is deliberately not on the
 * whitelist. So the probe's own refusal is the signal this screen exists for:
 * `loadAuthState` maps `cloud_password_change_required` to `phase: "locked"`
 * instead of retrying, and this page takes over before any shell mounts.
 *
 * It therefore paints no sidebar, navigation, workspace switcher or any other
 * chrome of the signed-in shell: none of those routes could load while the gate
 * is closed, and promising them would only produce a frame full of refusals.
 * The one write this page makes is `POST /api/auth/password`, the single
 * self-service route the gate lets through.
 */

export type LockedPasswordField = "current" | "password" | "confirmation"

export type LockedPasswordIssue = {
  field: LockedPasswordField
  message: string
}

/**
 * Local verdict before the round trip. Cloud stays the authority — it also
 * bounds the byte length and rejects reuse of the stored hash — these checks
 * only spare the operator a request for the mistakes the form can see itself.
 */
export function lockedPasswordIssue(
  current: string,
  next: string,
  confirmation: string,
): LockedPasswordIssue | undefined {
  if (current === "") return { field: "current", message: "请输入当前密码" }
  if (Array.from(next).length < 8) {
    return { field: "password", message: "密码至少需要 8 个字符" }
  }
  if (next === current) {
    return { field: "password", message: "新密码不能与当前密码相同" }
  }
  if (next !== confirmation) {
    return { field: "confirmation", message: "两次输入的密码不一致" }
  }
  return undefined
}

/**
 * Operator copy for a refused password change.
 *
 * Cloud writes Chinese copy into `{error, code}` and `errorMessage` carries it
 * through unchanged ("当前密码不正确", "密码至少 8 位，且不超过 72 字节"), so the
 * server sentence always wins when it is operator text. The code branches below
 * only cover refusals whose body is a bare status. A `cloud_xxx` identifier
 * never reaches the operator.
 */
export function lockedPasswordMessage(reason: unknown): string {
  const copy = errorMessage(reason, "")
  if (copy !== "") return copy
  const code = commandErrorCode(reason)
  if (code === "unauthenticated" || code === "cloud_auth_invalid") {
    return "登录已失效，请重新登录后再试。"
  }
  if (code === "cloud_internal" || code === "cloud_unavailable") {
    return "云端服务暂时不可用，请稍后重试。"
  }
  return "无法修改密码，请稍后重试。"
}

export type LockedPasswordSubmit = {
  current: string
  next: string
  confirmation: string
  changePassword: (current: string, next: string) => Promise<void>
  reload: () => void
}

/**
 * The whole submit path, split out of the component so the order that matters
 * is testable without a DOM: validate, write, and only then reload. A refusal
 * returns its copy and never reloads — reloading a refused change would drop
 * the operator back onto the same locked probe with the typed password lost.
 */
export async function submitLockedPassword(
  input: LockedPasswordSubmit,
): Promise<{ ok: true } | { ok: false; message: string }> {
  const issue = lockedPasswordIssue(input.current, input.next, input.confirmation)
  if (issue) return { ok: false, message: issue.message }
  try {
    await input.changePassword(input.current, input.next)
  } catch (reason) {
    return { ok: false, message: lockedPasswordMessage(reason) }
  }
  input.reload()
  return { ok: true }
}

type LockedSubmitResult = Awaited<ReturnType<typeof submitLockedPassword>>

export function LockedAccountScreen({
  changePassword = (current, next) =>
    accountHttp.accountChangePassword({
      current_password: current,
      new_password: next,
    }),
  reload = () => window.location.reload(),
}: {
  changePassword?: (current: string, next: string) => Promise<void>
  reload?: () => void
} = {}) {
  const [current, setCurrent] = useState("")
  const [next, setNext] = useState("")
  const [confirmation, setConfirmation] = useState("")
  const [showPassword, setShowPassword] = useState(false)
  const [busy, setBusy] = useState(false)
  const [fields, setFields] = useState<Partial<Record<LockedPasswordField, string>>>({})

  const versionLabel = productVersionLabel()

  function clear(field: LockedPasswordField) {
    setFields((previous) => ({ ...previous, [field]: undefined }))
  }

  async function submit() {
    if (busy) return
    const issue = lockedPasswordIssue(current, next, confirmation)
    // Same shape the sign-in form uses: the message rides the toast host and
    // the field only carries aria-invalid. No error sentence enters this page's
    // DOM, which also keeps a password refusal out of any captured markup.
    setFields(issue ? { [issue.field]: issue.message } : {})
    if (issue) {
      notifyError(issue.message)
      return
    }
    setBusy(true)
    let result: LockedSubmitResult
    try {
      result = await submitLockedPassword({
        current,
        next,
        confirmation,
        changePassword,
        reload,
      })
    } finally {
      setBusy(false)
    }
    if (!result.ok) notifyError(result.message)
  }

  return (
    <main className="flex min-h-svh flex-col items-center justify-center gap-6 bg-background px-6 py-10">
      <header className="flex items-center gap-2">
        <img src="/app-icon.svg" alt="" width={26} height={26} />
        <span className="text-md font-medium tracking-[-0.01em]">PodHub</span>
        {versionLabel ? (
          <span
            className="text-compact text-muted-foreground"
            aria-label={`版本 ${versionLabel}`}
          >
            {versionLabel}
          </span>
        ) : null}
      </header>
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-lg">
            <ShieldAlert aria-hidden className="size-5 text-muted-foreground" />
            请先修改密码
          </CardTitle>
          <CardDescription>
            这个账号的密码由管理员创建或重置，设置新密码后才能继续使用。
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form
            className="flex flex-col gap-4"
            onSubmit={(event) => {
              event.preventDefault()
              void submit()
            }}
          >
            <LockedPasswordInput
              id="locked-current-password"
              label="当前密码"
              autoComplete="current-password"
              value={current}
              visible={showPassword}
              error={fields.current}
              onToggle={() => setShowPassword((visible) => !visible)}
              onChange={(value) => {
                setCurrent(value)
                clear("current")
              }}
            />
            <LockedPasswordInput
              id="locked-new-password"
              label="新密码"
              autoComplete="new-password"
              placeholder="至少 8 个字符"
              value={next}
              visible={showPassword}
              error={fields.password}
              onToggle={() => setShowPassword((visible) => !visible)}
              onChange={(value) => {
                setNext(value)
                clear("password")
                clear("confirmation")
              }}
            />
            <LockedPasswordInput
              id="locked-confirm-password"
              label="确认新密码"
              autoComplete="new-password"
              placeholder="再输入一次"
              value={confirmation}
              visible={showPassword}
              error={fields.confirmation}
              onToggle={() => setShowPassword((visible) => !visible)}
              onChange={(value) => {
                setConfirmation(value)
                clear("confirmation")
              }}
            />
            <Button type="submit" className="w-full" disabled={busy}>
              {busy ? (
                <Spinner data-icon="inline-start" />
              ) : (
                <KeyRound data-icon="inline-start" />
              )}
              保存新密码
            </Button>
          </form>
        </CardContent>
      </Card>
      <p className="text-compact max-w-sm text-center text-muted-foreground">
        新密码生效后，其他设备上的登录会失效。
      </p>
    </main>
  )
}

function LockedPasswordInput({
  id,
  label,
  autoComplete,
  value,
  visible,
  error,
  placeholder,
  onToggle,
  onChange,
}: {
  id: string
  label: string
  autoComplete: string
  value: string
  visible: boolean
  error?: string
  placeholder?: string
  onToggle: () => void
  onChange: (value: string) => void
}) {
  return (
    <Field data-invalid={Boolean(error)} className="gap-1.5">
      <FieldLabel htmlFor={id} className="text-compact">
        {label}
      </FieldLabel>
      <InputGroup>
        <InputGroupInput
          id={id}
          type={visible ? "text" : "password"}
          autoComplete={autoComplete}
          value={value}
          placeholder={placeholder}
          aria-invalid={Boolean(error)}
          onChange={(event) => onChange(event.target.value)}
        />
        <InputGroupAddon align="inline-end">
          <Tooltip>
            <TooltipTrigger
              render={
                <InputGroupButton
                  size="icon-xs"
                  aria-label={visible ? "隐藏密码" : "显示密码"}
                  aria-pressed={visible}
                  onClick={onToggle}
                />
              }
            >
              {visible ? <EyeOff aria-hidden /> : <Eye aria-hidden />}
            </TooltipTrigger>
            <TooltipContent>{visible ? "隐藏密码" : "显示密码"}</TooltipContent>
          </Tooltip>
        </InputGroupAddon>
      </InputGroup>
    </Field>
  )
}
