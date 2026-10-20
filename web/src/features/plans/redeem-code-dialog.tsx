import { useState, type FormEvent } from "react"
import { Gift, Sparkles } from "lucide-react"

import type { AccountOverview, RedeemResultView } from "@/bindings/commands"
import { accountHttp } from "@/bindings/http-account"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Spinner } from "@/components/ui/spinner"
import { loadWallet } from "@/features/usage/wallet-cache"
import {
  commandErrorCode,
  WORKSPACE_MISMATCH_CODE,
} from "@/lib/error-message"
import { notifyCommandError, notifySuccess } from "@/lib/notify"
import { formatYuan } from "@/lib/money"

/**
 * The redeem-code entry is a focused dialog, not a plans-page card: codes are
 * an ops distribution channel (pricing.md — 不是加购的回门), so the comparison
 * page stays about plans and the Workspace menu's 兑换码 item opens this.
 */
export function RedeemCodeDialog({
  open,
  onOpenChange,
  canRedeem,
  workspaceUuid,
  onOverviewChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  canRedeem: boolean
  /** The Workspace this dialog redeems into — pinned into the request (B2). */
  workspaceUuid?: string
  onOverviewChange?: (overview: AccountOverview) => void
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <div className="flex items-start gap-3">
          <div className="flex size-10 shrink-0 items-center justify-center rounded-xl border border-border text-muted-foreground">
            <Gift className="size-5" />
          </div>
          <DialogHeader>
            <DialogTitle>兑换码</DialogTitle>
            <DialogDescription>兑换成员名额或钱包额度。</DialogDescription>
          </DialogHeader>
        </div>
        <RedeemCodeForm
          canRedeem={canRedeem}
          workspaceUuid={workspaceUuid}
          onOverviewChange={onOverviewChange}
          onRedeemed={() => onOpenChange(false)}
        />
      </DialogContent>
    </Dialog>
  )
}

/** The form body, split from the portal so tests can render it statically. */
export function RedeemCodeForm({
  canRedeem,
  workspaceUuid,
  onOverviewChange,
  onRedeemed,
}: {
  canRedeem: boolean
  workspaceUuid?: string
  onOverviewChange?: (overview: AccountOverview) => void
  onRedeemed?: () => void
}) {
  const [code, setCode] = useState("")
  const [redeeming, setRedeeming] = useState(false)

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!workspaceUuid) return
    setRedeeming(true)
    try {
      const result = await accountHttp.accountRedeemCode({
        code: code.trim().toUpperCase(),
        // B2: the server re-resolves the active Workspace and refuses when it
        // no longer matches — the code would otherwise credit a Workspace the
        // operator never confirmed.
        expected_workspace_uuid: workspaceUuid,
      })
      setCode("")
      const notice = redeemSuccessNotice(result)
      notifySuccess(notice.title, { description: notice.description })
      try {
        const next = await accountHttp.accountListWorkspaces()
        onOverviewChange?.(next)
      } catch (reason) {
        notifyCommandError(reason, "兑换成功，但 Workspace 概览刷新失败；额度会继续在后台同步。")
      } finally {
        void loadWallet().catch(() => {})
      }
      onRedeemed?.()
    } catch (reason) {
      if (commandErrorCode(reason) === WORKSPACE_MISMATCH_CODE) {
        // The switch landed server-side in another tab/device: repaint the
        // shell's standing so the refusal names the live Workspace.
        try {
          onOverviewChange?.(await accountHttp.accountListWorkspaces())
        } catch {
          // A failed repaint keeps the refusal toast as the only notice.
        }
      }
      notifyCommandError(reason, "兑换失败，请检查兑换码后重试。")
    } finally {
      setRedeeming(false)
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <form onSubmit={submit} className="flex flex-col gap-3">
        <Field>
          <FieldLabel htmlFor="workspace-redeem-code">兑换码</FieldLabel>
          <Input
            id="workspace-redeem-code"
            value={code}
            onChange={(event) => setCode(event.target.value.toUpperCase())}
            placeholder="例如: POD-PLAN-... 或 POD-WALLET-..."
            autoComplete="off"
            spellCheck={false}
            required
            disabled={!canRedeem || redeeming}
            className="font-mono tracking-wide"
          />
          <FieldDescription>
            兑换码区分有效期；过期、作废或已使用的兑换码不能重复兑换。套餐兑换码为覆盖式生效：兑换后当前
            Workspace 的原有套餐批次立即终止，剩余时长不结转、不抵扣。
          </FieldDescription>
        </Field>

        {!canRedeem ? (
          <p className="text-xs leading-5 text-muted-foreground" role="status">
            只有 Workspace 所有者可以兑换。
          </p>
        ) : null}

        <Button
          type="submit"
          disabled={!canRedeem || redeeming || !code.trim() || !workspaceUuid}
          className="w-full mt-1 font-medium flex items-center justify-center gap-2"
        >
          {redeeming ? (
            <Spinner data-icon="inline-start" />
          ) : (
            <Sparkles className="size-4" />
          )}
          {redeeming ? "兑换中…" : "兑换"}
        </Button>
      </form>
    </div>
  )
}

export function redeemSuccessNotice(result: RedeemResultView) {
  if (result.wallet_cents > 0) {
    return {
      title: `已兑换 ${formatYuan(result.wallet_cents * 1_000_000)} 钱包额度`,
      description: "余额已充入工作空间创建者的钱包，其所有工作空间共用，余额不过期。",
    }
  }
  const expiry = result.plan_expires_at
    ? `有效期至 ${formatRedeemDate(result.plan_expires_at)}。`
    : "成员名额已同步到当前 Workspace。"
  const replaced =
    result.replaced_lots > 0
      ? `原有 ${result.replaced_lots} 个生效批次（共 ${result.replaced_seats} 席）已终止，剩余时长不结转。`
      : ""
  return {
    title: `已兑换 ${result.member_seats} 个成员名额 · ${result.plan_name}`,
    description: `${expiry}${replaced}`,
  }
}

const REDEEM_DATE_FORMAT = new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium" })

function formatRedeemDate(value: string) {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : REDEEM_DATE_FORMAT.format(date)
}
