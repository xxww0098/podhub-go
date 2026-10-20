import { useEffect, useState } from "react"
import { Check } from "lucide-react"

import type { AgentPayoutAccount } from "@/bindings/commands"
import { accountHttp } from "@/bindings/http-account"
import { Button } from "@/components/ui/button"
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Spinner } from "@/components/ui/spinner"
import { Tabs, TabsIndicator, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { payoutChannelLabel } from "@/features/agents/agent-labels"
import { notifyCommandError, notifySuccess } from "@/lib/notify"

/**
 * The account withdrawals pay out to. Either all three fields are present and
 * shaped, or the form is blank and the account clears — the API refuses every
 * in-between state (`AgentPayoutAccountRequest`).
 */
export function PayoutAccountForm({
  account,
  onSaved,
}: {
  account?: AgentPayoutAccount | null
  onSaved: (next: AgentPayoutAccount | null) => void
}) {
  const [editing, setEditing] = useState(!account)
  const [channel, setChannel] = useState<"alipay" | "wechat">(
    account?.channel === "wechat" ? "wechat" : "alipay",
  )
  const [value, setValue] = useState(account?.account ?? "")
  const [realName, setRealName] = useState(account?.real_name ?? "")
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    setChannel(account?.channel === "wechat" ? "wechat" : "alipay")
    setValue(account?.account ?? "")
    setRealName(account?.real_name ?? "")
    if (account) setEditing(false)
  }, [account])

  const canSubmit = value.trim() !== "" && realName.trim() !== ""

  async function save() {
    if (!canSubmit) return
    setSaving(true)
    try {
      const next = await accountHttp.agentSetPayoutAccount({
        channel,
        account: value.trim(),
        real_name: realName.trim(),
      })
      notifySuccess("收款方式已保存")
      onSaved(next)
    } catch (reason) {
      notifyCommandError(reason, "保存收款方式失败，请检查后重试。")
    } finally {
      setSaving(false)
    }
  }

  async function clear() {
    setSaving(true)
    try {
      await accountHttp.agentSetPayoutAccount({
        channel: null,
        account: null,
        real_name: null,
      })
      notifySuccess("收款方式已清除")
      onSaved(null)
    } catch (reason) {
      notifyCommandError(reason, "清除收款方式失败，请稍后重试。")
    } finally {
      setSaving(false)
    }
  }

  if (!editing && account) {
    return (
      <div className="flex flex-wrap items-center gap-2 px-4 py-3 text-sm">
        <span className="font-medium">{payoutChannelLabel(account.channel)}</span>
        <span className="min-w-0 break-all font-mono">{account.account}</span>
        <span className="text-muted-foreground">{account.real_name}</span>
        <span className="ml-auto flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => setEditing(true)}>
            修改
          </Button>
          <Button
            variant="ghost"
            size="sm"
            disabled={saving}
            onClick={() => void clear()}
          >
            清除
          </Button>
        </span>
      </div>
    )
  }

  return (
    <form
      className="flex flex-col gap-3 px-4 py-3"
      onSubmit={(event) => {
        event.preventDefault()
        void save()
      }}
    >
      <FieldGroup>
        <Field>
          <FieldLabel>提现渠道</FieldLabel>
          <Tabs
            value={channel}
            onValueChange={(next) =>
              setChannel(next === "wechat" ? "wechat" : "alipay")
            }
          >
            <TabsList aria-label="提现渠道" className="h-9 w-full">
              <TabsIndicator />
              <TabsTrigger value="alipay" className="flex-1">
                支付宝
              </TabsTrigger>
              <TabsTrigger value="wechat" className="flex-1">
                微信
              </TabsTrigger>
            </TabsList>
          </Tabs>
        </Field>
        <Field>
          <FieldLabel htmlFor="payout-account">收款账号</FieldLabel>
          <Input
            id="payout-account"
            required
            maxLength={128}
            aria-invalid={value.trim() === ""}
            placeholder={channel === "alipay" ? "手机号或邮箱" : "微信号"}
            value={value}
            onChange={(event) => setValue(event.target.value)}
          />
        </Field>
        <Field>
          <FieldLabel htmlFor="payout-real-name">真实姓名</FieldLabel>
          <Input
            id="payout-real-name"
            required
            maxLength={64}
            aria-invalid={realName.trim() === ""}
            placeholder="与收款账号实名一致"
            value={realName}
            onChange={(event) => setRealName(event.target.value)}
          />
          <FieldDescription>
            每次申请提现都会带走当前收款方式的快照，修改不影响在途申请。
          </FieldDescription>
        </Field>
      </FieldGroup>
      <div className="flex items-center gap-2">
        <Button type="submit" size="sm" disabled={!canSubmit || saving}>
          {saving ? (
            <Spinner data-icon="inline-start" />
          ) : (
            <Check data-icon="inline-start" />
          )}
          保存收款方式
        </Button>
        {account ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => setEditing(false)}
          >
            取消
          </Button>
        ) : null}
      </div>
    </form>
  )
}
