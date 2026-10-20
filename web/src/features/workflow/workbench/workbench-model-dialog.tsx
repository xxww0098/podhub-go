import { useEffect, useMemo, useState } from "react"
import { Tag } from "lucide-react"
import type { CategoryFieldView, WorkflowDraftView } from "@/bindings/commands"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Spinner } from "@/components/ui/spinner"
import { notifyError } from "@/lib/notify"
import type { ListingRow } from "../model/listing-row"
import type { WorkbenchEditableColumn } from "./workbench-cell-editor"
import {
  MODEL_BATCH_LABEL,
  knownModels,
  modelBatchSkipCopy,
  planModelBatch,
  runModelBatch,
  type ModelBatchMode,
  type ModelBatchPlan,
} from "./workbench-model"

/** The three batch verbs, in the order the picker lists them. */
const MODEL_BATCH_MODES: readonly ModelBatchMode[] = [
  "common",
  "join",
  "independent",
]

/**
 * What the click will do, in one line: the rows that take the write and the
 * per-item refusals, named before the operator commits. Split out of the dialog
 * so a filled plan can be asserted without mounting Base UI's portal.
 */
export function ModelBatchPreview({ plan }: { plan: ModelBatchPlan }) {
  const skip = modelBatchSkipCopy(plan.refusals)
  return (
    <p className="text-meta leading-5 text-muted-foreground">
      {plan.writes.length > 0 ? `将写入 ${plan.writes.length} 行` : "没有可写入的行"}
      {skip ? `；${skip}` : ""}
    </p>
  )
}

/**
 * 型号 batch verbs over the current card's selected rows: set one common model,
 * join a model already in use on this card, or give every row its own back.
 *
 * The writes are the workbench's single-row path — `onEditCell(draftId, "model",
 * value)` and its durable autosave — run once per row; there is no batch row
 * endpoint and no second draft. The preview and the write both read the same
 * `planModelBatch`, so the count cannot name rows the verb then skips, and
 * refused rows are reported in one toast while the successful ones stay written.
 */
export type WorkbenchModelDialogProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Every row of the current card; the selection is what the batch writes. */
  rows: readonly ListingRow[]
  productDrafts: Readonly<Record<string, WorkflowDraftView | undefined>>
  selectedRowIds: ReadonlySet<string>
  field: CategoryFieldView
  onEditCell: (
    draftId: string,
    column: WorkbenchEditableColumn,
    value: string,
  ) => void
  onFlushRows: (draftIds: readonly string[]) => Promise<boolean>
}

export function WorkbenchModelDialog({
  open,
  onOpenChange,
  rows,
  productDrafts,
  selectedRowIds,
  field,
  onEditCell,
  onFlushRows,
}: WorkbenchModelDialogProps) {
  const [mode, setMode] = useState<ModelBatchMode>("common")
  const [typed, setTyped] = useState("")
  const [picked, setPicked] = useState("")
  const [applying, setApplying] = useState(false)

  useEffect(() => {
    if (!open) return
    setMode("common")
    setTyped("")
    setPicked("")
    setApplying(false)
  }, [open])

  const known = useMemo(
    () => knownModels(rows, productDrafts, field),
    [rows, productDrafts, field],
  )
  const value = mode === "common" ? typed.trim() : mode === "join" ? picked : undefined
  const plan = useMemo(
    () => planModelBatch({ rows, productDrafts, selectedRowIds, field, mode, value }),
    [rows, productDrafts, selectedRowIds, field, mode, value],
  )
  /** 设置共同型号 / 加入已知型号 还没拿到值：预览说的是「先选一个」，不是逐行失败。 */
  const needsValue = mode !== "independent" && !value
  const ready = plan.writes.length > 0 && !applying

  async function apply() {
    if (!ready) return
    setApplying(true)
    try {
      await runModelBatch({
        plan,
        edit: (draftId, model) => onEditCell(draftId, "model", model),
        flush: onFlushRows,
        report: notifyError,
      })
      onOpenChange(false)
    } finally {
      setApplying(false)
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && !applying) onOpenChange(false)
      }}
    >
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>批量设置型号</DialogTitle>
          <DialogDescription>
            把型号写到这一张卡已选的行。每行仍按自己的货号发送，已上架的行不会被修改。
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <label className="grid gap-1.5 text-compact">
            <span className="font-medium">操作</span>
            <Select
              value={mode}
              onValueChange={(next) => {
                if (next) setMode(next as ModelBatchMode)
              }}
            >
              <SelectTrigger aria-label="型号操作">
                <SelectValue>{() => MODEL_BATCH_LABEL[mode]}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                {MODEL_BATCH_MODES.map((item) => (
                  <SelectItem key={item} value={item}>
                    {MODEL_BATCH_LABEL[item]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </label>

          {mode === "common" ? (
            <label className="grid gap-1.5 text-compact">
              <span className="font-medium">共同型号</span>
              <Input
                value={typed}
                placeholder="例如 SZ-ART-01"
                aria-label="共同型号"
                onChange={(event) => setTyped(event.target.value)}
              />
            </label>
          ) : mode === "join" ? (
            <label className="grid gap-1.5 text-compact">
              <span className="font-medium">本卡已在用的型号</span>
              <Select
                value={picked}
                onValueChange={(next) => {
                  if (next) setPicked(next)
                }}
              >
                <SelectTrigger aria-label="已知型号">
                  <SelectValue placeholder="选择一个型号">
                    {() => picked || "选择一个型号"}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {known.map((model) => (
                    <SelectItem key={model.value} value={model.value}>
                      {model.value} · {model.count} 行
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </label>
          ) : (
            <p className="text-compact leading-5 text-muted-foreground">
              每一行改回自己的独立型号：用该行的原图文件名（文件名缺失时用货号）写成固定值，
              而不是清空后再等文件名注入。
            </p>
          )}

          {needsValue ? (
            <p className="text-meta leading-5 text-muted-foreground">
              选择或输入型号后才能写入
            </p>
          ) : (
            <ModelBatchPreview plan={plan} />
          )}
        </div>
        <DialogFooter className="gap-2 sm:gap-2">
          <Button
            type="button"
            variant="outline"
            disabled={applying}
            onClick={() => onOpenChange(false)}
          >
            取消
          </Button>
          <Button
            type="button"
            variant="default"
            disabled={!ready}
            aria-busy={applying}
            onClick={() => void apply()}
          >
            {applying ? (
              <Spinner className="size-4" aria-label="正在写入型号" />
            ) : (
              <Tag aria-hidden />
            )}
            {applying ? "正在写入…" : `写入 ${plan.writes.length} 行`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
