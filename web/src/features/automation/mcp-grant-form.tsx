import { useId, useState } from "react"
import type { AccountOverview } from "@/bindings/commands"
import type { GrantInput, GrantScopeKind } from "@/bindings/http-automation-grants"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Spinner } from "@/components/ui/spinner"
import { availableGrantActions, defaultGrantActions, grantActionLabel } from "./grant-options"

export function McpGrantForm({ scope, overview, busy, onCreate }: {
  scope: GrantScopeKind
  overview?: AccountOverview
  busy: boolean
  onCreate: (input: GrantInput) => Promise<void>
}) {
  const id = useId()
  const [name, setName] = useState("")
  const [days, setDays] = useState("30")
  const [actions, setActions] = useState(defaultGrantActions(scope))
  const availableActions = availableGrantActions(scope, overview)
  const selectedActions = actions.filter((action) => availableActions.includes(action))
  return (
    <form className="flex flex-col gap-4" onSubmit={(event) => {
      event.preventDefault()
      if (busy || !name.trim() || selectedActions.length === 0) return
      void onCreate({ name: name.trim(), actions: selectedActions, expiresInDays: Number(days), sourceIds: null })
    }}>
      <div className="flex flex-col gap-2">
        <label className="text-sm font-medium" htmlFor={`${id}-name`}>令牌名称</label>
        <Input id={`${id}-name`} value={name} onChange={(event) => setName(event.target.value)} maxLength={120} required disabled={busy} placeholder="例如：采购助手" autoComplete="off" />
      </div>
      <div className="flex flex-col gap-2">
        <label className="text-sm font-medium" htmlFor={`${id}-expiry`}>有效期</label>
        <Select value={days} onValueChange={(value) => { if (value) setDays(value) }} disabled={busy}>
          <SelectTrigger id={`${id}-expiry`}><SelectValue>{(value) => `${value} 天`}</SelectValue></SelectTrigger>
          <SelectContent>{["7", "30", "90"].map((value) => <SelectItem key={value} value={value}>{value} 天</SelectItem>)}</SelectContent>
        </Select>
      </div>
      <fieldset disabled={busy} className="flex flex-col gap-2">
        <legend className="mb-2 text-sm font-medium">允许的操作</legend>
        {availableActions.map((action) => <label key={action} className="flex cursor-pointer items-center gap-2 py-1">
          <Checkbox checked={selectedActions.includes(action)} disabled={busy} onCheckedChange={(checked) => setActions((previous) => checked ? [...previous, action] : previous.filter((value) => value !== action))} />
          <span className="text-sm">{grantActionLabel(action)}</span>
        </label>)}
      </fieldset>
      <Button type="submit" disabled={busy || !name.trim() || selectedActions.length === 0}>
        {busy ? <Spinner data-icon="inline-start" /> : null}申请令牌
      </Button>
    </form>
  )
}
