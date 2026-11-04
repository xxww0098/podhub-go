import { useState, type FormEvent } from "react"
import { Gift, Info, Sparkles } from "lucide-react"

import type { AccountOverview, RedeemResultView } from "@/bindings/commands"
import { accountHttp } from "@/bindings/http-account"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Field, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Spinner } from "@/components/ui/spinner"
import { loadWallet } from "@/features/usage/wallet-cache"
import {
  commandErrorCode,
  WORKSPACE_MISMATCH_CODE,
} from "@/lib/error-message"
import { notifyCommandError, notifySuccess } from "@/lib/notify"
import { formatYuan } from "@/lib/money"
import { formatDateTimeShort } from "@/lib/format"
import { planDisplayName } from "./plan-catalog"

export const SUBSCRIPTION_REDEEMED_EVENT = "podhub:subscription-redeemed"
export const REDEEM_CODE_REDEEMED_EVENT = "podhub:redeem-code-redeemed"

/**
 * The redeem-code entry is a focused dialog, not a plans-page card: codes are
 * an ops distribution channel (pricing.md), so the comparison
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
      <DialogContent layout="panel" className="sm:max-w-md">
        <DialogHeader variant="panel">
          <div className="flex items-center gap-3">
            <span aria-hidden className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-brand-soft text-brand">
              <Gift className="size-5" />
            </span>
            <div className="flex min-w-0 flex-col gap-0.5">
              <DialogTitle>兑换码</DialogTitle>
              <DialogDescription>兑换套餐或钱包额度。</DialogDescription>
            </div>
          </div>
        </DialogHeader>
        <DialogBody className="p-5">
          <RedeemCodeForm
            canRedeem={canRedeem}
            workspaceUuid={workspaceUuid}
            onOverviewChange={onOverviewChange}
            onRedeemed={() => onOpenChange(false)}
          />
        </DialogBody>
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
      if (result.plan_key) window.dispatchEvent(new CustomEvent(SUBSCRIPTION_REDEEMED_EVENT, { detail: workspaceUuid }))
      window.dispatchEvent(new Event(REDEEM_CODE_REDEEMED_EVENT))
      setCode("")
      const notice = redeemSuccessNotice(result)
      notifySuccess(notice.title, { description: notice.description })
      try {
        const next = await accountHttp.accountListWorkspaces()
        onOverviewChange?.(next)
      } catch (reason) {
        notifyCommandError(reason, "兑换成功，但工作空间概览刷新失败，请刷新页面。")
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
    <form onSubmit={submit} className="flex flex-col gap-4">
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
          className="h-11 font-mono text-base tracking-wide"
        />
      </Field>

      <div className="flex gap-2.5 rounded-lg bg-muted/40 px-3 py-2.5 text-meta leading-5 text-muted-foreground">
        <Info aria-hidden className="mt-0.5 size-3.5 shrink-0" />
        <p>
          过期、作废或已使用的兑换码不能重复兑换。套餐将在已有付费时长结束后生效；店铺超出容量时，按添加顺序保留，未来账期可在套餐页面调整。
        </p>
      </div>

      {!canRedeem ? (
        <p className="text-meta leading-5 text-muted-foreground" role="status">
          只有 Workspace 所有者可以兑换。
        </p>
      ) : null}

      <Button
        type="submit"
        size="lg"
        disabled={!canRedeem || redeeming || !code.trim() || !workspaceUuid}
        className="w-full font-medium"
      >
        {redeeming ? (
          <Spinner data-icon="inline-start" />
        ) : (
          <Sparkles className="size-4" />
        )}
        {redeeming ? "兑换中…" : "兑换"}
      </Button>
    </form>
  )
}

export function redeemSuccessNotice(result: RedeemResultView) {
  if (result.plan_key) {
    return {
      title: `已兑换 ${planDisplayName(result.plan_key)} · ${result.plan_stores} 家店铺 · ${result.plan_months} 个月`,
      description: result.starts_at && result.ends_at ? `生效时间：${formatDateTimeShort(result.starts_at)} 至 ${formatDateTimeShort(result.ends_at)}。` : "请在套餐页面查看生效时间。",
    }
  }
  return {
    title: `已兑换 ${formatYuan(result.wallet_cents * 1_000_000)} 钱包额度`,
    description: "余额已充入当前工作空间的钱包，不过期。",
  }
}
