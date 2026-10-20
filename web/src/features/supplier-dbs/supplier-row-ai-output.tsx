/** Recognition policy shares the Ozon configuration CAS with platform fields. */
import { useEffect, useId, useRef, useState } from "react"
import type { SupplierDbRow } from "@/bindings/http-supplier-dbs"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Spinner } from "@/components/ui/spinner"
import { commandErrorCode } from "@/lib/error-message"
import { notifyCommandError, notifyError } from "@/lib/notify"
import {
  supplierOzonConfigIO,
  type SupplierOzonConfigData,
  type SupplierOzonConfigIO,
} from "./supplier-ozon-config"

type AiOutput = SupplierOzonConfigData["ai_output"]
type OutputKey = keyof AiOutput
const DEFAULT_OUTPUT: AiOutput = { title: true, description: true, tags: true }
const OUTPUT_LABELS: Record<OutputKey, string> = { title: "标题", description: "描述", tags: "图片标签" }
type Props = {
  row: SupplierDbRow
  io?: SupplierOzonConfigIO
  configEpoch?: number
  onConfigSaved?: () => void
  onDirtyChange?: (dirty: boolean) => void
}

/** Read before the one-key write so an independently saved platform field or
 * prompt is never copied back from an old panel snapshot. The final PUT still
 * uses CAS; a concurrent write is surfaced, never automatically retried. */
export async function saveSupplierAiOutput(
  row: SupplierDbRow,
  io: SupplierOzonConfigIO,
  key: OutputKey,
  checked: boolean,
): Promise<SupplierOzonConfigData> {
  if (row.descriptionCategoryId == null || row.typeId == null) {
    throw new Error("请先选择 Ozon 类目")
  }
  const base = await io.get(row.sourceId, row.productId)
  if (base && (base.description_category_id !== row.descriptionCategoryId || base.type_id !== row.typeId)) {
    throw { code: "cloud_conflict", message: "商品类目已变更，请重新读取后再改" }
  }
  return io.put(row.sourceId, row.productId, {
    description_category_id: row.descriptionCategoryId,
    type_id: row.typeId,
    language: base?.language ?? "zh_hans",
    values: base?.values ?? {},
    prompt_text: base?.prompt_text ?? row.promptContent,
    fixed_tags: base?.fixed_tags ?? row.fixedTags,
    ai_output: { ...(base?.ai_output ?? DEFAULT_OUTPUT), [key]: checked },
    expected_revision: base?.revision ?? 0,
  })
}

export function SupplierRowAiOutput(props: Props) {
  const { row } = props
  return <AiOutputEditor key={`${row.sourceId}:${row.productId}:${row.descriptionCategoryId}:${row.typeId}`} {...props} />
}

function AiOutputEditor({ row, io = supplierOzonConfigIO, configEpoch = 0, onConfigSaved, onDirtyChange }: Props) {
  const id = useId()
  const [config, setConfig] = useState<SupplierOzonConfigData>()
  const [phase, setPhase] = useState<"loading" | "idle" | "saving" | "failed" | "conflicted">("loading")
  const [reload, setReload] = useState(0)
  const intent = useRef<{ key: OutputKey; checked: boolean } | null>(null)
  const alive = useRef(true)
  const saving = useRef(false)
  const hasCategory = row.descriptionCategoryId != null && row.typeId != null

  useEffect(() => {
    alive.current = true
    return () => { alive.current = false }
  }, [])

  // Row writes change prompt/tags; configEpoch also covers sibling-tab PUTs,
  // which advance the configuration revision without changing the row revision.
  useEffect(() => {
    if (!hasCategory || intent.current) return
    let cancelled = false
    setPhase("loading")
    void io.get(row.sourceId, row.productId).then((next) => {
      if (cancelled) return
      setConfig(next)
      setPhase("idle")
    }).catch((reason) => {
      if (cancelled) return
      setPhase("failed")
      notifyCommandError(reason, "无法读取识图生成设置")
    })
    return () => { cancelled = true }
  }, [io, row.sourceId, row.productId, row.revision, hasCategory, configEpoch, reload])

  const dirty = intent.current !== null
  useEffect(() => { onDirtyChange?.(dirty) }, [dirty, onDirtyChange])

  const save = async (key: OutputKey, checked: boolean) => {
    if (saving.current || phase === "loading" || phase === "conflicted") return
    saving.current = true
    intent.current = { key, checked }
    setPhase("saving")
    try {
      const saved = await saveSupplierAiOutput(row, io, key, checked)
      if (!alive.current) return
      intent.current = null
      setConfig(saved)
      setPhase("idle")
      onConfigSaved?.()
    } catch (reason) {
      if (!alive.current) return
      if (commandErrorCode(reason) === "cloud_conflict") {
        setPhase("conflicted")
        notifyError("Ozon 配置已变更，请重新读取后再修改识图生成设置", { reason })
      } else {
        setPhase("failed")
        notifyCommandError(reason, "保存识图生成设置失败")
      }
    } finally {
      saving.current = false
    }
  }

  const policy = { ...(config?.ai_output ?? DEFAULT_OUTPUT) }
  if (intent.current) policy[intent.current.key] = intent.current.checked
  const retry = () => {
    const pending = intent.current
    if (phase === "failed" && pending) void save(pending.key, pending.checked)
    else { intent.current = null; setReload((current) => current + 1) }
  }

  return (
    <div className="flex flex-wrap items-center gap-4" data-supplier-ai-output="" aria-busy={hasCategory && (phase === "loading" || phase === "saving") || undefined}>
      <span id={id} className="text-meta text-muted-foreground">识图生成</span>
      {!hasCategory ? <span className="text-meta text-muted-foreground">选择 Ozon 类目后可设置</span> : <>
        {phase === "loading" ? <Spinner /> : phase === "idle" || config || dirty ? (
          <fieldset aria-labelledby={id} className="flex flex-wrap items-center gap-4" disabled={phase !== "idle"}>
            {(Object.keys(OUTPUT_LABELS) as OutputKey[]).map((key) => (
              <label key={key} className="flex cursor-pointer items-center gap-2 text-compact">
                <Checkbox checked={policy[key]} aria-label={`识图生成${OUTPUT_LABELS[key]}`}
                  disabled={phase !== "idle"} onCheckedChange={(checked) => void save(key, checked)} />
                {OUTPUT_LABELS[key]}
              </label>
            ))}
          </fieldset>
        ) : null}
        {phase === "saving" ? <Spinner /> : null}
        {phase === "failed" || phase === "conflicted" ? (
          <Button type="button" variant="outline" size="sm" onClick={retry}>
            {phase === "failed" && dirty ? "重试保存" : "重新读取"}
          </Button>
        ) : null}
      </>}
    </div>
  )
}
