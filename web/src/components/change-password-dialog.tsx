import { useState } from "react"
import { Eye, EyeOff, KeyRound } from "lucide-react"

import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
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
import { notifyError } from "@/lib/notify"

export function ChangePasswordDialog({
  open,
  busy,
  onOpenChange,
  onSubmit,
}: {
  open: boolean
  busy: boolean
  onOpenChange: (open: boolean) => void
  onSubmit: (currentPassword: string, newPassword: string) => void
}) {
  const [current, setCurrent] = useState("")
  const [next, setNext] = useState("")
  const [confirm, setConfirm] = useState("")
  const [showPassword, setShowPassword] = useState(false)
  const [currentError, setCurrentError] = useState<string>()
  const [nextError, setNextError] = useState<string>()
  const [confirmError, setConfirmError] = useState<string>()

  function reset() {
    setCurrent("")
    setNext("")
    setConfirm("")
    setShowPassword(false)
    setCurrentError(undefined)
    setNextError(undefined)
    setConfirmError(undefined)
  }

  function submit() {
    if (!current) {
      setCurrentError("请输入当前密码")
      notifyError("请输入当前密码")
      return
    }
    if (Array.from(next).length < 8) {
      setNextError("密码至少需要 8 个字符")
      notifyError("密码至少需要 8 个字符")
      return
    }
    if (next === current) {
      setNextError("新密码不能与当前密码相同")
      notifyError("新密码不能与当前密码相同")
      return
    }
    if (next !== confirm) {
      setConfirmError("两次输入的密码不一致")
      notifyError("两次输入的密码不一致")
      return
    }
    onSubmit(current, next)
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) reset()
        onOpenChange(nextOpen)
      }}
    >
      <DialogContent className="max-h-5/6 overflow-y-auto sm:max-w-sm">
        <DialogHeader>
          <DialogTitle className="text-md font-semibold">修改密码</DialogTitle>
          <DialogDescription className="text-compact text-muted-foreground">
            修改后其他设备需要重新登录。
          </DialogDescription>
        </DialogHeader>
        <form
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault()
            submit()
          }}
        >
          <PasswordField
            id="account-current-password"
            label="当前密码"
            autoComplete="current-password"
            value={current}
            visible={showPassword}
            error={currentError}
            onToggle={() => setShowPassword((visible) => !visible)}
            onChange={(value) => {
              setCurrent(value)
              setCurrentError(undefined)
            }}
          />
          <PasswordField
            id="account-new-password"
            label="新密码"
            autoComplete="new-password"
            value={next}
            visible={showPassword}
            error={nextError}
            placeholder="至少 8 个字符"
            onToggle={() => setShowPassword((visible) => !visible)}
            onChange={(value) => {
              setNext(value)
              setNextError(undefined)
              setConfirmError(undefined)
            }}
          />
          <PasswordField
            id="account-confirm-password"
            label="确认新密码"
            autoComplete="new-password"
            value={confirm}
            visible={showPassword}
            error={confirmError}
            placeholder="再输入一次"
            onToggle={() => setShowPassword((visible) => !visible)}
            onChange={(value) => {
              setConfirm(value)
              setConfirmError(undefined)
            }}
          />
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => onOpenChange(false)}
              disabled={busy}
            >
              取消
            </Button>
            <Button type="submit" size="sm" disabled={busy}>
              {busy ? <Spinner data-icon="inline-start" /> : <KeyRound data-icon="inline-start" />}
              确认修改
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

function PasswordField({
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
