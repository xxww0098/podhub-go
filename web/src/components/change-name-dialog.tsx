import { useState } from "react"
import { PencilLine } from "lucide-react"

import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogBody,
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
      <DialogContent layout="panel" className="sm:max-w-sm">
        <DialogHeader variant="panel">
          <DialogTitle>修改名字</DialogTitle>
          <DialogDescription>
            每 24 小时可修改一次，最长 {ACCOUNT_NAME_MAX_CHARS} 个字符，不能包含违法违规内容。
          </DialogDescription>
        </DialogHeader>
        <form
          className="flex min-h-0 flex-1 flex-col"
          onSubmit={(event) => {
            event.preventDefault()
            submit()
          }}
        >
          <DialogBody>
            <Field data-invalid={invalid}>
              <FieldLabel htmlFor="account-display-name">名字</FieldLabel>
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
          </DialogBody>
          <DialogFooter variant="panel">
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
