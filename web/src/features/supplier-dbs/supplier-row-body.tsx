import { useEffect, useRef, useState, type ReactNode } from "react"
import { Check, Plus } from "lucide-react"
import type { CategoryTreeNodeView } from "@/bindings/commands"
import type { SupplierDbPropDef, SupplierDbRow, UpsertSupplierDbPropRequest } from "@/bindings/http-supplier-dbs"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { Tabs, TabsIndicator, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { notifyError } from "@/lib/notify"
import { SupplierCategoryGate } from "./supplier-category-gate"
import { SupplierRowInfoTab } from "./supplier-row-info-tab"
import { SupplierRowCopyFields } from "./supplier-row-copy-fields"
import { SupplierRowPlatformTab } from "./supplier-row-platform-tab"
import type { PatchFn } from "./supplier-row-fields"
import "./supplier-row.css"

export type SupplierRowTab = "info" | "defaults" | "ocr"
const STEPS = [{ key: "info", label: "平台商品信息" }, { key: "defaults", label: "Ozon 字段" }, { key: "ocr", label: "AI 识图" }] as const

export function SupplierRowBody({ row, rows = [], sharedRow = row, mode = "product", onSelectRow, onAddVariant, propDefs, categoryTree = [], categoryLoading, onEnsureCategoryTree, onPatch, onPatchShared = onPatch, onUpdateProp, onAddProp, onAdjustPrice, initialTab = "info", onDirtyChange, onSharedConfigSaved, onSyncShared, onExit, pending = false, canAdjustPrice = false, platformFlushRef, aiFlushRef, status, trailing }: {
  row: SupplierDbRow
  rows?: readonly SupplierDbRow[]
  sharedRow?: SupplierDbRow
  mode?: "product" | "variant"
  onSelectRow?: (productId: string, tab?: SupplierRowTab) => void
  onAddVariant?: () => void
  propDefs: SupplierDbPropDef[]
  categoryTree?: CategoryTreeNodeView[]
  categoryLoading?: boolean
  onEnsureCategoryTree?: () => Promise<boolean>
  onPatch: PatchFn
  onPatchShared?: PatchFn
  onUpdateProp?: (def: SupplierDbPropDef, patch: Partial<UpsertSupplierDbPropRequest>) => Promise<boolean>
  onAddProp?: () => void
  onAdjustPrice: (priceCents: number, note: string) => Promise<boolean>
  initialTab?: SupplierRowTab
  onDirtyChange?: (dirty: boolean) => void
  onSharedConfigSaved?: () => void
  onSyncShared?: (validate?: boolean) => Promise<boolean>
  onExit?: () => void
  pending?: boolean
  canAdjustPrice?: boolean
  platformFlushRef?: React.RefObject<((validate?: boolean) => Promise<boolean>) | null>
  aiFlushRef?: React.RefObject<(() => Promise<boolean>) | null>
  /** 只读状态，跟规格上下文放在一起。 */
  status?: ReactNode
  /** 右侧操作，与上下文分开。 */
  trailing?: ReactNode
}) {
  const [step, setStep] = useState<SupplierRowTab>(initialTab)
  const [visited, setVisited] = useState(() => new Set<SupplierRowTab>([initialTab]))
  const [busy, setBusy] = useState(false)
  const [configEpoch, setConfigEpoch] = useState(0)
  const editorRef = useRef<HTMLDivElement>(null)
  const localPlatformRef = useRef<((validate?: boolean) => Promise<boolean>) | null>(null)
  const localAiRef = useRef<(() => Promise<boolean>) | null>(null)
  const platformSave = platformFlushRef ?? localPlatformRef
  const aiSave = aiFlushRef ?? localAiRef
  const group = rows.filter((item) => !item.archived && item.sourceId === row.sourceId && (item.productId === row.productId || Boolean(row.variantGroup?.trim()) && item.variantGroup?.trim() === row.variantGroup?.trim()))
  const variantListRef = useRef<HTMLDivElement>(null)
  // 切换规格会重建整个编辑器，胶囊轨道从 0 开始滚动；重新挂载后把选中项带回可视区。
  useEffect(() => {
    const list = variantListRef.current
    const active = list?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')
    if (!list || !active) return
    const start = active.offsetLeft - 4
    const end = active.offsetLeft + active.offsetWidth + 4
    if (start < list.scrollLeft) list.scrollLeft = start
    else if (end > list.scrollLeft + list.clientWidth) list.scrollLeft = end - list.clientWidth
  }, [row.productId, group.length])
  const index = STEPS.findIndex((item) => item.key === step)
  const hasCategory = row.descriptionCategoryId != null && row.typeId != null
  // 页头只解释当前步骤的作用域；规格本身已经由分段控件说清，不再重复「单规格」。
  const note = mode === "variant" && step === "defaults"
    ? "仅修改当前规格"
    : mode === "product" && step === "defaults" && group.length > 1
      ? `${group.length} 个规格共用字段`
      : null
  const selectStep = async (next: SupplierRowTab, validate = false) => {
    if (busy || pending || next === step) return
    const invalid = editorRef.current?.querySelector<HTMLElement>('[data-supplier-row-info-tab] [aria-invalid="true"]')
    if (invalid) { invalid.focus(); notifyError("请先重试保存标红字段，或按 Esc 撤销输入"); return }
    setBusy(true)
    try {
      if (step === "defaults") {
        if (platformSave.current && !await platformSave.current(validate)) return
        if (onSyncShared && !await onSyncShared(validate)) return
      }
      if (step === "ocr" && aiSave.current && !await aiSave.current()) return
      setVisited((current) => new Set([...current, next]))
      setStep(next)
    } finally { setBusy(false) }
  }
  return <div ref={editorRef} className="supplier-row-editor supplier-inline-editor @container/supplier-row flex min-h-0 min-w-0 flex-1 flex-col" data-supplier-row-body="" data-active-tab={step} data-editor-mode={mode}>
    <ol className="supplier-editor-steps" aria-label={mode === "product" ? "商品配置流程" : "规格配置流程"}>
      {STEPS.map((item, position) => <li key={item.key} aria-current={step === item.key ? "step" : undefined}><button type="button" data-row-tab={item.key} disabled={busy || pending} onClick={() => void selectStep(item.key)}><span>{position < index ? <Check aria-hidden className="size-3.5" /> : position + 1}</span>{item.label}</button></li>)}
    </ol>
    <div className="supplier-editor-context">
      <div className="supplier-editor-identity">
        <div className="supplier-editor-spec">
          <span className="supplier-editor-spec-label">规格</span>
          {group.length > 1
            ? <div className="min-w-0">
              <Tabs variant="capsule" value={row.productId} onValueChange={(next) => { if (next && next !== row.productId) onSelectRow?.(String(next), step) }}>
                <TabsList ref={variantListRef} variant="capsule" aria-label="同款规格" className="min-w-0 overflow-x-auto">
                  <TabsIndicator variant="capsule" />
                  {group.map((item) => {
                    const size = item.size.trim() || "未命名规格"
                    const state = item.published ? "已发布" : "草稿"
                    return <TabsTrigger key={item.productId} variant="capsule" value={item.productId} disabled={pending || busy} className="max-w-64 shrink-0" aria-label={`${size}，${state}`} title={`${size} · ${state}`}>
                      <span aria-hidden className="supplier-editor-variant-dot" data-published={item.published} />
                      <span className="min-w-0 truncate">{size}</span>
                    </TabsTrigger>
                  })}
                </TabsList>
              </Tabs>
            </div>
            : <span className={row.size.trim() ? "min-w-0 truncate text-compact font-medium" : "min-w-0 truncate text-compact text-muted-foreground"} title={row.size.trim() || undefined}>{row.size.trim() || "未填写"}</span>}
        </div>
        {status}
        {note ? <span className="supplier-editor-note">{note}</span> : null}
      </div>
      {(onAddVariant && mode === "product" && step === "info") || trailing ? (
        <div className="ml-auto flex min-w-0 shrink-0 flex-wrap items-center justify-end gap-2">
          {onAddVariant && mode === "product" && step === "info" ? <Button variant="outline" size="sm" disabled={pending || busy} onClick={onAddVariant}><Plus aria-hidden />新增规格</Button> : null}
          {trailing}
        </div>
      ) : null}
    </div>
    <div className="flex min-h-0 min-w-0 flex-1 flex-col" data-supplier-row-content="">
      <div className={step === "info" ? "supplier-editor-scroll" : "hidden"} data-supplier-row-scroll=""><SupplierRowInfoTab row={row} propDefs={propDefs} onPatch={onPatch} onUpdateProp={onUpdateProp} onAddProp={onAddProp} onAdjustPrice={onAdjustPrice} canAdjustPrice={canAdjustPrice} /></div>
      {visited.has("defaults") ? <div hidden={step !== "defaults"} className={step === "defaults" ? "flex min-h-0 flex-1 flex-col" : "hidden"} data-supplier-ozon-panel="">
        <SupplierRowPlatformTab row={mode === "product" ? sharedRow : row} shared={mode === "product"} categoryTree={categoryTree} categoryLoading={categoryLoading} onEnsureCategoryTree={onEnsureCategoryTree} onPatch={mode === "product" ? onPatchShared : onPatch} onNavigateMedia={() => void selectStep("info")} configEpoch={configEpoch} onConfigSaved={() => { if (mode === "product") onSharedConfigSaved?.(); setConfigEpoch((value) => value + 1) }} flushRef={platformSave} />
      </div> : null}
      {visited.has("ocr") ? <div className={step === "ocr" ? "supplier-editor-scroll" : "hidden"} data-supplier-row-scroll="">
        {hasCategory ? <SupplierRowCopyFields row={row} siblings={group} onPatch={onPatch} onDirtyChange={onDirtyChange} saveRef={aiSave} />
          : <div className="p-4"><SupplierCategoryGate
            title="先选择 Ozon 类目"
            description="AI 识图用类目字段生成标题、属性和描摹事实。先选类目，再配置识图规则。"
            actionLabel="去选择 Ozon 类目"
            onAction={() => void selectStep("defaults")}
          /></div>}
      </div> : null}
    </div>
    <div className="supplier-editor-footer"><span className="text-meta text-muted-foreground">{pending || busy ? "正在保存…" : null}</span>{index < STEPS.length - 1 ? <Button variant="ghost" disabled={pending || busy} onClick={onExit}>保存并退出</Button> : null}
      {index > 0 ? <Button variant="outline" disabled={pending || busy} onClick={() => void selectStep(STEPS[index - 1].key)}>上一步</Button> : null}
      {index < STEPS.length - 1 ? <Button variant="brand" disabled={pending || busy} onClick={() => void selectStep(STEPS[index + 1].key, true)}>{busy ? <Spinner /> : null}保存并继续</Button> : <Button variant="brand" disabled={pending || busy} onClick={onExit}>保存并返回</Button>}
    </div>
  </div>
}
