import { ChevronDown } from "lucide-react"
import { useId, useState } from "react"
import type { AccountOverview } from "@/bindings/commands"
import type { GrantInput, GrantScopeKind } from "@/bindings/http-automation-grants"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { InputGroup, InputGroupAddon, InputGroupInput, InputGroupText } from "@/components/ui/input-group"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Spinner } from "@/components/ui/spinner"
import { availableGrantActions, grantActionLabel } from "./grant-options"

export function McpGrantForm({ scope, overview, busy, onCreate }: {
  scope: GrantScopeKind
  overview?: AccountOverview
  busy: boolean
  onCreate: (input: GrantInput) => Promise<void>
}) {
  const id = useId()
  const [name, setName] = useState("")
  const [days, setDays] = useState("30")
  const [actions, setActions] = useState<string[]>([])
  const availableActions = availableGrantActions(scope, overview)
  const selectedActions = actions.filter((action) => availableActions.includes(action))
  return (
    <form className="flex min-w-0 flex-col gap-4" onSubmit={(event) => {
      event.preventDefault()
      if (busy || !name.trim() || selectedActions.length === 0) return
      void onCreate({ name: name.trim(), actions: selectedActions, expiresInDays: Number(days), sourceIds: null })
    }} onReset={() => {
      setName("")
      setDays("30")
      setActions([])
    }}>
      <div className="flex min-w-0 flex-col gap-2">
        <label className="text-lg font-medium" htmlFor={`${id}-name`}>令牌名称</label>
        <InputGroup className="h-11">
          <InputGroupInput id={`${id}-name`} value={name} onChange={(event) => setName(event.target.value)} maxLength={120} required disabled={busy} placeholder="请输入令牌名称" autoComplete="off" />
          <InputGroupAddon align="inline-end"><InputGroupText aria-hidden>{name.length}/120</InputGroupText></InputGroupAddon>
        </InputGroup>
      </div>
      <div className="flex min-w-0 flex-col gap-2">
        <span id={`${id}-permissions`} className="text-lg font-medium">权限范围</span>
        <p className="text-lg text-muted-foreground">选择该令牌可执行的操作。</p>
        <Popover>
          <PopoverTrigger render={<Button type="button" variant="outline" size="lg" className="w-full justify-between" aria-labelledby={`${id}-permissions ${id}-selected`} disabled={busy} />}>
            <span id={`${id}-selected`} className="min-w-0 truncate">{selectedActions.length ? selectedActions.map(grantActionLabel).join("、") : "请选择权限范围"}</span>
            <ChevronDown aria-hidden />
          </PopoverTrigger>
          <PopoverContent aria-label="允许的操作" className="max-h-[min(24rem,calc(100dvh-2rem))] overflow-y-auto">
            <fieldset disabled={busy} className="grid gap-1">
              <legend className="sr-only">允许的操作</legend>
              {availableActions.map((action) => <label key={action} className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-2 hover:bg-muted">
                <Checkbox checked={selectedActions.includes(action)} disabled={busy} onCheckedChange={(checked) => setActions((previous) => checked ? [...previous, action] : previous.filter((value) => value !== action))} />
                <span className="text-compact">{grantActionLabel(action)}</span>
              </label>)}
            </fieldset>
          </PopoverContent>
        </Popover>
      </div>
      <div className="flex flex-wrap items-end gap-3">
        <div className="flex flex-col gap-1.5">
          <label className="text-compact font-medium" htmlFor={`${id}-expiry`}>有效期</label>
          <Select value={days} onValueChange={(value) => { if (value) setDays(value) }} disabled={busy}>
            <SelectTrigger id={`${id}-expiry`} className="w-28"><SelectValue>{(value) => `${value} 天`}</SelectValue></SelectTrigger>
            <SelectContent>{["7", "30", "90"].map((value) => <SelectItem key={value} value={value}>{value} 天</SelectItem>)}</SelectContent>
          </Select>
        </div>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <Button type="reset" variant="outline" size="lg" disabled={busy}>重置</Button>
          <Button type="submit" variant="brand" size="lg" disabled={busy || !name.trim() || selectedActions.length === 0}>
            {busy ? <Spinner data-icon="inline-start" /> : null}申请令牌
          </Button>
        </div>
      </div>
    </form>
  )
}
