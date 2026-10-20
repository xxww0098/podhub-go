import { useState } from "react"
import { PencilLine } from "lucide-react"

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
import { Input } from "@/components/ui/input"
import { Spinner } from "@/components/ui/spinner"
import { accountNameProblem, ACCOUNT_NAME_MAX_CHARS } from "@/features/account/name-rules"
import { notifyError } from "@/lib/notify"

export function ChangeNameDialog({
  open,
  busy,
  currentName,
  onOpenChange,
  onSubmit,
}: {
  open: boolean
  busy: boolean
  currentName: string
  onOpenChange: (open: boolean) => void
  onSubmit: (name: string) => void
}) {
  const [name, setName] = useState(currentName)
  const [invalid, setInvalid] = useState(false)

  function reset() {
    setName(currentName)
    setInvalid(false)
  }

  function submit() {
    const problem = accountNameProblem(name, currentName)
    if (problem) {
      setInvalid(true)
      notifyError(problem)
      return
    }
    onSubmit(name.trim())
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (nextOpen) {
          reset()
        }
        onOpenChange(nextOpen)
      }}
    >
      <DialogContent className="gap-0 overflow-hidden p-0 sm:max-w-sm rounded-xl border border-border/80 shadow-overlay">
        <DialogHeader className="border-b border-border/60 bg-muted/20 px-5 py-3.5 pr-12">
          <DialogTitle className="text-base font-semibold">修改名字</DialogTitle>
          <DialogDescription className="text-xs text-muted-foreground">
            每 24 小时可修改一次，最长 {ACCOUNT_NAME_MAX_CHARS} 个字符，不能包含违法违规内容。
          </DialogDescription>
        </DialogHeader>
        <form
          className="flex flex-col gap-3.5 p-5"
          onSubmit={(event) => {
            event.preventDefault()
            submit()
          }}
        >
          <Field data-invalid={invalid} className="gap-1.5">
            <FieldLabel htmlFor="account-display-name" className="text-xs">
              名字
            </FieldLabel>
            <Input
              id="account-display-name"
              value={name}
              maxLength={ACCOUNT_NAME_MAX_CHARS}
              autoComplete="nickname"
              aria-invalid={invalid}
              onChange={(event) => {
                setName(event.target.value)
                setInvalid(false)
              }}
            />
          </Field>
          <DialogFooter className="m-0 -mx-5 -mb-5 gap-2 border-t border-border/50 bg-muted/10 px-5 py-3 sm:justify-end">
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
              {busy ? <Spinner data-icon="inline-start" /> : <PencilLine data-icon="inline-start" />}
              确认修改
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
