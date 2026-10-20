import { useEffect, useState } from "react"
import { CircleHelp, LoaderCircle, RotateCcw } from "lucide-react"
import { Button } from "@/components/ui/button"
import { ConfirmDialog } from "@/components/ui/confirm-dialog"
import { UNKNOWN_RELEASE_FACT_LIMIT, unknownReleaseFactLine, type UnknownReleaseFact } from "./unknown-release-facts"

/**
 * 「待核对」rows under the ribbon: sends that never got an answer. Releasing
 * an exact Intent still requires authority, fresh readback and native validation.
 * Without that capability the current workbench only offers manual guidance.
 */
export function UnknownReleaseStrip({
  rowIds,
  facts = [],
  releasing,
  disabled,
  onRelease,
  available = false,
  onInspect,
}: {
  available?: boolean
  onInspect?: (ids: string[]) => void
  rowIds: string[]
  /** Offer, task and the evidence this row is still missing. Release stays gated by `available`. */
  facts?: readonly UnknownReleaseFact[]
  releasing: boolean
  disabled: boolean
  onRelease: (rowIds: string[]) => void
}) {
  const [pendingIds, setPendingIds] = useState<string[]>([])
  const selection = rowIds.join("\n")
  useEffect(() => { setPendingIds([]) }, [available, disabled, releasing, selection])
  if (!rowIds.length && !releasing) return null
  if (!available) return (
    <div className="flex flex-wrap items-center gap-2">
      <UnknownReleaseFacts
        count={rowIds.length}
        facts={facts}
        trailing="确认前不要重发。"
      />
      {onInspect && <Button type="button" variant="outline" size="sm" disabled={disabled || releasing || !rowIds.length}
        aria-busy={releasing} onClick={() => onInspect(rowIds)}>{releasing ? "核对中…" : "核对原 Intent"}</Button>}
    </div>
  )
  return (
    <div className="flex shrink-0 flex-wrap items-center gap-2 px-1">
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={disabled || releasing || !rowIds.length}
        onClick={() => setPendingIds(rowIds)}
        aria-busy={releasing}
        aria-label={`核对后释放 ${rowIds.length} 件商品的确切未确认 Intent`}
      >
        {releasing ? <LoaderCircle aria-hidden className="animate-spin" /> : <RotateCcw aria-hidden />}
        <span>{releasing ? "恢复中…" : `恢复待核对 ${rowIds.length}`}</span>
      </Button>
      <UnknownReleaseFacts
        count={rowIds.length}
        facts={facts}
        trailing="这些商品发送后未取得 Ozon 响应。请先在 Ozon 后台按货号核对；释放不会发送。"
      />
      <ConfirmDialog
        open={available && !disabled && !releasing && pendingIds.length > 0}
        onOpenChange={(open) => {
          if (!open) setPendingIds([])
        }}
        title={`释放 ${pendingIds.length} 件商品的确切未确认 Intent？`}
        description="仅处理已核对的原店铺确切 Intent。释放回执仍需当前状态读回和原生校验；缺少任何证据时保持锁定，释放不会提交商品。"
        confirmText="已核对，释放原 Intent"
        variant="brand"
        icon={<CircleHelp aria-hidden />}
        onConfirm={() => {
          const ids = pendingIds
          setPendingIds([])
          if (available && !disabled && !releasing && ids.length && ids.every((id) => rowIds.includes(id))) onRelease(ids)
        }}
      />
    </div>
  )
}

function UnknownReleaseFacts({
  count,
  facts,
  trailing,
}: {
  count: number
  facts: readonly UnknownReleaseFact[]
  trailing: string
}) {
  const shown = facts.slice(0, UNKNOWN_RELEASE_FACT_LIMIT)
  const rest = facts.length - shown.length
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <p className="text-sm text-foreground">{count} 件商品的发送结果待核对。{trailing}</p>
      {shown.map((fact) => (
        <p key={fact.id} className="text-sm text-foreground">{unknownReleaseFactLine(fact)}</p>
      ))}
      {rest > 0 ? <p className="text-sm text-muted-foreground">另有 {rest} 件，请在表格里按货号逐条核对。</p> : null}
    </div>
  )
}
