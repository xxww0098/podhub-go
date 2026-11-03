import { useCallback, useEffect, useRef, useState } from "react"
import { Plus, RefreshCw, Undo2 } from "lucide-react"

import type {
  AdminDirectoryWorkspaceView,
  WalletTopupsData,
  WalletTopupView,
} from "@/bindings/commands"
import { adminHttp } from "@/bindings/http-admin"
import { PlatformAdminDialog } from "@/components/platform-admin-dialog"
import { Button } from "@/components/ui/button"
import { ConfirmDialog } from "@/components/ui/confirm-dialog"
import { IconButton } from "@/components/ui/icon-button"
import { Input } from "@/components/ui/input"
import { InputGroup, InputGroupAddon, InputGroupInput, InputGroupText } from "@/components/ui/input-group"
import { Spinner } from "@/components/ui/spinner"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import {
  GRANT_NOTE_MAX,
  grantAttemptFor,
  grantCentsFromYuan,
  type GrantAttempt,
} from "@/features/users/wallet-grants"
import { errorMessage } from "@/lib/error-message"
import { formatDateTimeShort } from "@/lib/format"
import { formatCents, formatYuan } from "@/lib/money"
import { notifyCommandError, notifySuccess } from "@/lib/notify"
import { cn } from "@/lib/utils"

/**
 * One workspace's own wallet for the platform SuperAdmin: balance, held and
 * available, the grants that built it, and the two writes that move it. Every
 * successful write reports the fresh wallet through `onChanged` so the
 * directory row shows the new available/held without a reload.
 */
export function WorkspaceWalletDialog({
  workspace,
  onClose,
  onChanged,
}: {
  workspace?: AdminDirectoryWorkspaceView
  onClose: () => void
  onChanged: (workspaceUuid: string, wallet: WalletTopupsData) => void
}) {
  const uuid = workspace?.uuid
  const [wallet, setWallet] = useState<WalletTopupsData>()
  const [loading, setLoading] = useState(false)
  const [loadError, setLoadError] = useState<string>()
  const [saving, setSaving] = useState(false)
  const [yuan, setYuan] = useState("")
  const [note, setNote] = useState("")
  const [revoking, setRevoking] = useState<WalletTopupView>()
  const attempt = useRef<GrantAttempt>(undefined)
  const request = useRef(0)

  const load = useCallback(async (workspaceUuid: string) => {
    const current = ++request.current
    setLoading(true)
    try {
      const next = await adminHttp.adminWorkspaceWallet(workspaceUuid)
      if (current !== request.current) return
      setWallet(next)
      setLoadError(undefined)
    } catch (reason) {
      if (current !== request.current) return
      const message = errorMessage(reason, "无法加载工作空间钱包，请稍后重试。")
      setLoadError(message)
      notifyCommandError(reason, "无法加载工作空间钱包，请稍后重试。")
    } finally {
      if (current === request.current) setLoading(false)
    }
  }, [])

  useEffect(() => {
    setWallet(undefined)
    setLoadError(undefined)
    setYuan("")
    setNote("")
    setRevoking(undefined)
    attempt.current = undefined
    if (uuid) void load(uuid)
    else request.current++
  }, [uuid, load])

  const cents = grantCentsFromYuan(yuan)
  const amountInvalid = yuan.trim() !== "" && cents === null
  const balance = wallet?.balance_microfen
  const held = wallet?.held_microfen ?? workspace?.wallet_held_microfen
  const available = wallet?.available_microfen ?? workspace?.wallet_available_microfen
  const stats = [
    { label: "可用", value: available },
    { label: "余额", value: balance },
    { label: "预留", value: held },
  ]

  async function grant() {
    if (!workspace || cents === null || saving) return
    const next = grantAttemptFor(attempt.current, workspace.uuid, cents, note)
    attempt.current = next
    setSaving(true)
    try {
      const data = await adminHttp.adminTopupWorkspaceWallet({
        workspace_uuid: next.workspaceUuid,
        operation_id: next.operationId,
        amount_cents: next.amountCents,
        note: next.note || undefined,
      })
      attempt.current = undefined
      setWallet(data)
      setYuan("")
      setNote("")
      onChanged(workspace.uuid, data)
      notifySuccess(`已充入 ${formatCents(next.amountCents)}`, { description: workspace.name })
    } catch (reason) {
      notifyCommandError(reason, "无法充入余额，请稍后重试。")
    } finally {
      setSaving(false)
    }
  }

  async function revoke(topup: WalletTopupView) {
    if (!workspace || saving) return
    setSaving(true)
    try {
      const data = await adminHttp.adminRevokeWorkspaceWalletTopup({
        workspace_uuid: workspace.uuid,
        topup_id: topup.id,
      })
      setWallet(data)
      setRevoking(undefined)
      onChanged(workspace.uuid, data)
      notifySuccess(`已撤销 ${formatYuan(topup.amount_microfen)}`, { description: workspace.name })
    } catch (reason) {
      notifyCommandError(reason, "无法撤销充入，请稍后重试。")
    } finally {
      setSaving(false)
    }
  }

  return (
    <PlatformAdminDialog
      open={Boolean(workspace)}
      onOpenChange={(open) => {
        if (!open && !saving) onClose()
      }}
      title={workspace ? `${workspace.name} 钱包` : "工作空间钱包"}
      width="sm:max-w-2xl"
    >
      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-4">
        <dl className="grid grid-cols-3 gap-3">
          {stats.map(({ label, value }) => (
            <div key={label} className="min-w-0">
              <dt className="text-compact text-muted-foreground">{label}</dt>
              <dd className="font-mono font-medium tabular-nums">
                {value === undefined ? "—" : formatYuan(value)}
              </dd>
            </div>
          ))}
        </dl>

        <form
          className="grid gap-2 sm:grid-cols-[9rem_minmax(0,1fr)_auto]"
          onSubmit={(event) => {
            event.preventDefault()
            void grant()
          }}
        >
          <InputGroup>
            <InputGroupInput
              aria-label="充入金额"
              inputMode="decimal"
              autoComplete="off"
              placeholder="1 – 10000"
              aria-invalid={amountInvalid || undefined}
              value={yuan}
              disabled={saving}
              onChange={(event) => setYuan(event.target.value)}
            />
            <InputGroupAddon align="inline-end">
              <InputGroupText>元</InputGroupText>
            </InputGroupAddon>
          </InputGroup>
          <Input
            aria-label="备注"
            autoComplete="off"
            placeholder="备注（选填）"
            maxLength={GRANT_NOTE_MAX}
            value={note}
            disabled={saving}
            onChange={(event) => setNote(event.target.value)}
          />
          <Button type="submit" size="sm" variant="brand" disabled={cents === null || saving || !workspace}>
            {saving ? <Spinner data-icon="inline-start" /> : <Plus data-icon="inline-start" />}
            充入
          </Button>
        </form>

        <div className="min-h-0 overflow-auto rounded-lg border border-border">
          {loadError && !wallet ? (
            <div className="flex items-center justify-between gap-2 p-3 text-compact text-muted-foreground">
              <span>{loadError}</span>
              <Button type="button" size="sm" variant="outline" disabled={loading} onClick={() => uuid && void load(uuid)}>
                {loading ? <Spinner data-icon="inline-start" /> : <RefreshCw data-icon="inline-start" />}
                重试
              </Button>
            </div>
          ) : !wallet ? (
            <div className="flex items-center gap-2 p-3 text-compact text-muted-foreground">
              <Spinner aria-hidden />加载中…
            </div>
          ) : wallet.topups.length === 0 ? (
            <p className="p-3 text-compact text-muted-foreground">暂无充入记录</p>
          ) : (
            <Table variant="directory" className="text-compact" containerClassName="overflow-visible">
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead>时间</TableHead>
                  <TableHead className="text-right">金额</TableHead>
                  <TableHead>备注</TableHead>
                  <TableHead className="w-24 text-right">状态</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {wallet.topups.map((topup) => (
                  <TableRow key={topup.id} className="text-compact">
                    <TableCell className="whitespace-nowrap tabular-nums text-muted-foreground">
                      {formatDateTimeShort(topup.created_at)}
                    </TableCell>
                    <TableCell
                      className={cn(
                        "text-right font-mono tabular-nums",
                        topup.revoked_at && "text-muted-foreground line-through",
                      )}
                    >
                      {formatYuan(topup.amount_microfen)}
                    </TableCell>
                    <TableCell className="max-w-48 truncate" title={topup.note || undefined}>
                      {topup.note || "—"}
                    </TableCell>
                    <TableCell className="text-right">
                      {topup.revoked_at ? (
                        <span className="whitespace-nowrap text-muted-foreground" title={formatDateTimeShort(topup.revoked_at)}>
                          已撤销
                        </span>
                      ) : (
                        <IconButton
                          icon={Undo2}
                          size="icon-xs"
                          label={`撤销充入 ${formatYuan(topup.amount_microfen)}`}
                          tip="撤销"
                          disabled={saving}
                          onClick={() => setRevoking(topup)}
                        />
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </div>
      </div>

      <ConfirmDialog
        open={Boolean(revoking)}
        onOpenChange={(open) => {
          if (!open) setRevoking(undefined)
        }}
        title={revoking ? `撤销 ${formatYuan(revoking.amount_microfen)}？` : "撤销充入？"}
        description="这笔金额会从工作空间余额中扣回。"
        confirmText="撤销"
        variant="destructive"
        icon={<Undo2 data-icon="inline-start" />}
        busy={saving}
        footerLayout="end"
        onConfirm={() => {
          if (revoking) void revoke(revoking)
        }}
        onCancel={() => setRevoking(undefined)}
      />
    </PlatformAdminDialog>
  )
}
