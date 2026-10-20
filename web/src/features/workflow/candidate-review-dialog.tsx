import { useEffect, useState } from "react"
import { api } from "@/api/client"
import { route } from "@/api/routes"
import { patchListingRow } from "@/bindings/http-listing"
import type { CategorySchemaView, WorkflowAiCandidate } from "@/bindings/commands"
import type { ListingRowView } from "@/bindings/listing-projection"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { errorMessage } from "@/lib/error-message"
import { clearLive, notifyLive } from "@/lib/notify"
import type { ListingRow } from "./model/listing-row"
import { refreshProductStatus } from "./workbench/product-status"
import { readWorkflowValue, valueAsText } from "./workflow-draft"

export function pendingCandidates(row: ListingRowView): Array<{ index: number; candidate: WorkflowAiCandidate }> {
  const ai = (row.ai ?? {}) as { candidates?: WorkflowAiCandidate[] }
  return (ai.candidates ?? []).flatMap((candidate, index) =>
    candidate.state === "proposed" || candidate.state === "unresolved" ? [{ index, candidate }] : [],
  )
}

/** The displayed revision identifies the candidate indices. Never re-read a
 * revision and silently apply a decision the operator made on an older list. */
export function decideListingCandidate(row: ListingRowView, index: number, accept: boolean): Promise<ListingRowView> {
  return patchListingRow(row.id, {
    baseRevision: row.revision,
    candidateDecisions: [{ index, accept }],
  }, row)
}

export async function readCandidateReviewRow(rowId: string, flushRows: (ids: readonly string[]) => Promise<boolean>): Promise<ListingRowView> {
  if (!(await flushRows([rowId]))) throw new Error("本行修改尚未保存，请先解决保存失败再审阅建议。")
  return api.get<ListingRowView>(route("listingRowsById", { id: rowId }))
}

export function candidateCurrentText(row: ListingRowView, candidate: WorkflowAiCandidate): string {
  const address = candidate.address
  if (address.kind !== "complex") {
    return valueAsText(readWorkflowValue(row.draft, address.field_key)) || "空值"
  }
  const itemIndex = row.draft.complex_values
    .find((group) => String(group.complex_id) === address.group_key)
    ?.items.findIndex((item) => item.item_id === address.item_id)
  if (itemIndex === undefined || itemIndex < 0) return "空值"
  return valueAsText(readWorkflowValue(row.draft, address.field_key, {
    complexId: Number(address.group_key),
    itemIndex,
  })) || "空值"
}

export function CandidateReviewDialog({ row, schema, flushRows, onClose }: {
  row: ListingRow | null
  schema: CategorySchemaView
  flushRows: (ids: readonly string[]) => Promise<boolean>
  onClose: () => void
}) {
  const [snapshot, setSnapshot] = useState<ListingRowView | null>(null)
  const [busy, setBusy] = useState(false)
  const [reload, setReload] = useState(0)
  const [conflicted, setConflicted] = useState(false)
  useEffect(() => {
    let active = true
    setSnapshot(null)
    clearLive("candidate-review")
    setConflicted(false)
    if (!row) return
    setBusy(true)
    readCandidateReviewRow(row.draftId, flushRows)
      .then((next) => {
        if (!active) return
        setSnapshot(next)
        clearLive("candidate-review")
      })
      .catch((reason) => {
        if (!active) return
        notifyLive({
          id: "candidate-review",
          type: "error",
          title: errorMessage(reason, "读取候选失败"),
          reason,
          action: { label: "重新加载", onClick: () => setReload((value) => value + 1) },
        })
      })
      .finally(() => { if (active) setBusy(false) })
    return () => {
      active = false
      clearLive("candidate-review")
    }
  }, [row?.draftId, reload])

  async function decide(index: number, accept: boolean) {
    if (!snapshot || !row || busy || conflicted) return
    setBusy(true)
    try {
      const next = await decideListingCandidate(snapshot, index, accept)
      setSnapshot(next)
      clearLive("candidate-review")
      await refreshProductStatus(row, "候选已更新")
    } catch (reason) {
      notifyLive({
        id: "candidate-review",
        type: "error",
        title: errorMessage(reason, "候选确认失败"),
        reason,
        action: { label: "重新加载", onClick: () => setReload((value) => value + 1) },
      })
      if ((reason as { status?: number }).status === 409) setConflicted(true)
    } finally { setBusy(false) }
  }

  const pending = snapshot ? pendingCandidates(snapshot) : []
  return (
    <Dialog open={row !== null} onOpenChange={(open) => { if (!open) onClose() }}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>审阅识别建议 · {row?.imageName}</DialogTitle>
          <DialogDescription>逐项采用建议或保留现值。未处理的建议会阻止发送；人工填写的字段只能保留。</DialogDescription>
        </DialogHeader>
        <div className="max-h-[65vh] space-y-3 overflow-auto">
          {!snapshot && busy ? <p className="text-sm text-muted-foreground">正在读取候选…</p> : null}
          {snapshot && pending.length === 0 ? <p className="py-6 text-sm text-muted-foreground">全部建议已处理。发送前仍会检查字段、媒体和店铺。</p> : null}
          {pending.map(({ index, candidate }) => {
            const address = candidate.address
            const field = schema.fields.find((field) => field.key === address.field_key)
            const label = field?.name || address.field_key
            return (
              <section key={index} className="space-y-2 rounded-md border p-3">
                <p className="text-sm font-medium">{label}{address.kind === "complex" ? ` · ${address.item_id}` : ""}</p>
                <div className="grid grid-cols-2 gap-3 text-sm">
                  <div><p className="mb-1 text-xs text-muted-foreground">现值</p><p className="whitespace-pre-wrap break-words">{snapshot ? candidateCurrentText(snapshot, candidate) : "空值"}</p></div>
                  <div><p className="mb-1 text-xs text-muted-foreground">识别建议</p><p className="whitespace-pre-wrap break-words">{valueAsText(candidate.value) || "空值"}</p></div>
                </div>
                {candidate.issue ? <p className="text-xs text-muted-foreground">{candidate.issue}</p> : null}
                <div className="flex justify-end gap-2">
                  <Button variant="outline" size="sm" disabled={busy || conflicted} onClick={() => void decide(index, false)}>保留现值</Button>
                  {candidate.state === "proposed" ? <Button size="sm" disabled={busy || conflicted} onClick={() => void decide(index, true)}>采用建议</Button> : null}
                </div>
              </section>
            )
          })}
        </div>
      </DialogContent>
    </Dialog>
  )
}
