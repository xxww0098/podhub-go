import { useCallback, useEffect, useRef, useMemo, useState } from "react"
import { BookmarkCheck, Loader2, ShieldCheck, Sparkles } from "lucide-react"
import { packsHttp } from "@/bindings/http-packs"
import type {
  CategorySchemaView,
  FieldPackView,
  FieldValueOrigin,
  SkuImportCandidate,
  SkuImportPreview,
  WorkflowCategoryDraft,
  WorkflowDraftValue,
  WorkflowValidationIssue,
} from "@/bindings/commands"
import { Button } from "@/components/ui/button"
import { ConfirmDialog } from "@/components/ui/confirm-dialog"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Switch } from "@/components/ui/switch"
import { notifyCommandError, notifySuccess } from "@/lib/notify"
import { cn } from "@/lib/utils"
import { CategoryFieldsForm } from "./category-fields-form"
import { SkuImportPanel } from "./sku-import-panel"
import { tableOwnedFields } from "./workbench/workbench-columns"
import {
  isCategoryDraftBlank,
  type WorkflowValueLocation,
} from "./workflow-draft"

const NOOP = () => undefined
const EMPTY_KEYS: string[] = []
const EMPTY_SKU_PREVIEW = async (): Promise<SkuImportPreview> => ({
  source_sku: 0,
  source_product_id: 0,
  source_offer_id: "",
  source_name: "",
  source_description_category_id: 0,
  source_type_id: 0,
  category_matches: false,
  candidates: [],
  skipped_fields: 0,
})

export type DefaultFieldsDialogProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  schema: CategorySchemaView
  draft: WorkflowCategoryDraft
  issues: WorkflowValidationIssue[]
  fieldOrigins: FieldValueOrigin[]
  targetStoreId: string
  onFetchSchema: () => Promise<void>
  onUpdateValue: (
    fieldKey: string,
    value: WorkflowDraftValue | undefined,
    location: WorkflowValueLocation,
  ) => void
  onAddComplexItem?: (complexId: number) => void
  onRemoveComplexItem?: (complexId: number, itemIndex: number) => void
  aiAllowedFieldKeys?: string[]
  aiProtectedFieldKeys?: string[]
  onPreviewSkuImport?: (sku: string) => Promise<SkuImportPreview>
  onApplySkuImport?: (candidates: SkuImportCandidate[], sourceSku: number) => void
  busy?: boolean
  queueLocked?: boolean
}

/** 当前方案默认字段支持手动编辑和 SKU 克隆；字段包仅供保存与管理。 */
export function DefaultFieldsDialog({
  open,
  onOpenChange,
  schema,
  draft,
  issues,
  fieldOrigins,
  targetStoreId,
  onFetchSchema,
  onUpdateValue,
  onAddComplexItem = NOOP,
  onRemoveComplexItem = NOOP,
  aiAllowedFieldKeys = EMPTY_KEYS,
  aiProtectedFieldKeys = EMPTY_KEYS,
  onPreviewSkuImport = EMPTY_SKU_PREVIEW,
  onApplySkuImport = NOOP,
  busy = false,
  queueLocked = false,
}: DefaultFieldsDialogProps) {
  const [probing, setProbing] = useState(false)
  const [packName, setPackName] = useState("")
  const [packs, setPacks] = useState<FieldPackView[]>([])
  const [pendingDelete, setPendingDelete] = useState<FieldPackView>()
  const [deleting, setDeleting] = useState(false)
  const [discardConfirmOpen, setDiscardConfirmOpen] = useState(false)
  const onFetchSchemaRef = useRef(onFetchSchema)
  onFetchSchemaRef.current = onFetchSchema
  const packsGeneration = useRef(0)
  const tableOwned = useMemo(() => tableOwnedFields(schema), [schema])
  const coordinate = useMemo(
    () => ({
      description_category_id: schema.description_category_id,
      type_id: schema.type_id,
      language: schema.language,
    }),
    [schema.description_category_id, schema.type_id, schema.language],
  )

  const refreshPacks = useCallback(() => {
    const generation = ++packsGeneration.current
    return packsHttp
      .fieldPackList(coordinate)
      .then((next) => {
        if (generation !== packsGeneration.current) return next
        setPacks(next)
        return next
      })
      .catch((reason) => {
        if (generation !== packsGeneration.current) return
        notifyCommandError(reason, "无法读取我的字段包")
        return undefined
      })
  }, [coordinate])

  useEffect(() => {
    if (!open) {
      packsGeneration.current += 1
      setProbing(false)
      setPendingDelete(undefined)
      setDeleting(false)
      return
    }
    void refreshPacks()
    if (busy || queueLocked) return
    let cancelled = false
    setProbing(true)
    void onFetchSchemaRef
      .current()
      .catch((reason) => {
        if (!cancelled) {
          notifyCommandError(reason, "无法更新类目字段，仍显示上次读取的字段。")
        }
      })
      .finally(() => {
        if (!cancelled) setProbing(false)
      })
    return () => {
      cancelled = true
    }
  }, [open, busy, queueLocked, refreshPacks])

  function requestClose(next: boolean) {
    if (!next && packName.trim()) {
      setDiscardConfirmOpen(true)
      return
    }
    onOpenChange(next)
  }

  function confirmDelete() {
    const target = pendingDelete
    if (!target || deleting) return
    setDeleting(true)
    void packsHttp
      .fieldPackDelete({ pack_id: target.id })
      .then(() => {
        setPendingDelete(undefined)
        notifySuccess(`已删除「${target.name}」`)
        return refreshPacks()
      })
      .catch((reason) => notifyCommandError(reason, "无法删除这个字段包。"))
      .finally(() => setDeleting(false))
  }

  return (
    <>
    <Dialog open={open} onOpenChange={requestClose}>
      <DialogContent className="max-h-[88svh] gap-3.5 overflow-y-auto pb-6 sm:max-w-4xl">
        <DialogHeader className="flex flex-col gap-3 border-b border-border/70 pb-3 lg:flex-row lg:items-start lg:justify-between">
          <div className="min-w-0 flex-1 pr-2">
            <div className="flex items-center gap-2">
              <DialogTitle className="text-base font-semibold tracking-tight text-foreground">
                当前方案默认字段
              </DialogTitle>
              <span className="inline-flex items-center rounded bg-muted px-1.5 py-0.5 font-mono text-meta text-muted-foreground">
                {schema.fields.length} 个字段
              </span>
            </div>
            <DialogDescription className="mt-1 text-compact leading-5 text-muted-foreground">
              编辑这张上架方案的默认字段，只用于之后新建的商品；不改已有商品。表格逐行生成的字段保持锁定。
            </DialogDescription>
          </div>
          <div className="shrink-0 w-full rounded-lg border border-border/80 bg-muted/25 p-2 shadow-2xs lg:w-96">
            <SkuImportPanel
              blank={isCategoryDraftBlank(schema, draft)}
              disabled={busy || queueLocked}
              onPreview={onPreviewSkuImport}
              onApply={onApplySkuImport}
            />
          </div>
        </DialogHeader>

        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center justify-between gap-2.5 rounded-lg border border-border/80 bg-card px-3.5 py-2.5 shadow-2xs">
            <div className="flex flex-wrap items-center gap-2 text-xs">
              <div className="flex items-center gap-1.5 font-medium text-foreground">
                <Sparkles className="size-3.5 text-brand" aria-hidden="true" />
                <span>AI 字段策略：</span>
              </div>
              <span className="inline-flex items-center gap-1 rounded bg-st-good-soft px-2 py-0.5 text-meta font-medium text-st-good-ink">
                允许 {aiAllowedFieldKeys.length} 个类目字段
              </span>
              <span className="inline-flex items-center gap-1 rounded bg-muted px-2 py-0.5 text-meta font-medium text-muted-foreground">
                <ShieldCheck className="size-3 text-muted-foreground" aria-hidden="true" />
                已保护 {aiProtectedFieldKeys.length} 个价格、尺寸、品牌、认证与媒体字段
              </span>
              <span className="text-meta text-muted-foreground">
                AI 只能提出候选，确认后才进入发布快照。
              </span>
            </div>
            {probing ? (
              <div className="flex items-center gap-1.5 text-meta text-muted-foreground">
                <Loader2 className="size-3 animate-spin text-brand" aria-hidden="true" />
                <span>正在核对类目字段…</span>
              </div>
            ) : null}
          </div>
          {open ? (
            <CategoryFieldsForm
              schema={schema}
              targetStoreId={targetStoreId}
              draft={draft}
              issues={issues}
              initialFilter="required"
              fieldOrigins={fieldOrigins}
              lockedFields={tableOwned}
              onOpenMedia={() => onOpenChange(false)}
              onUpdateValue={onUpdateValue}
              onAddComplexItem={onAddComplexItem}
              onRemoveComplexItem={onRemoveComplexItem}
            />
          ) : null}
        </div>

        <div className="grid gap-3 rounded-xl border border-border bg-card/60 p-4 shadow-2xs">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <BookmarkCheck className="size-4 text-brand" aria-hidden="true" />
              <p className="text-compact font-medium text-foreground">我的字段包</p>
              <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-meta text-muted-foreground">
                {packs.length} 个
              </span>
            </div>
          </div>
          <p className="text-meta leading-5 text-muted-foreground">
            字段包仅供保存、分享和管理，不再支持载入或套用。删除类目默认后不会自动改设其他字段包。
          </p>
          {packs.length === 0 ? (
            <div className="rounded-lg border border-dashed border-border/80 bg-muted/20 py-4 text-center text-meta text-muted-foreground">
              还没有我的字段包。
            </div>
          ) : (
            <ul className="grid gap-2">
              {packs.map((pack) => (
                <li
                  key={pack.id}
                  className={cn(
                    "flex flex-col sm:flex-row sm:items-center justify-between gap-2.5 rounded-lg border p-2.5 transition-colors text-compact",
                    pack.active
                      ? "border-brand/40 bg-brand/3 shadow-2xs"
                      : "border-border/70 bg-card hover:border-border",
                  )}
                >
                  <label className="flex min-w-0 flex-1 items-center gap-2 cursor-pointer select-none">
                    <input
                      type="radio"
                      name="field-pack-active"
                      aria-label={`设为类目默认 ${pack.name}`}
                      checked={pack.active}
                      disabled={busy || queueLocked}
                      className="accent-brand size-3.5 shrink-0 cursor-pointer"
                      onChange={() => {
                        void packsHttp
                          .fieldPackSetActive({ pack_id: pack.id })
                          .then(() => refreshPacks())
                          .catch((reason) =>
                            notifyCommandError(reason, "无法设为类目默认"),
                          )
                      }}
                    />
                    <span className="truncate font-medium text-foreground">{pack.name}</span>
                    {pack.active ? (
                      <span className="inline-flex items-center rounded-sm bg-brand/10 px-1.5 py-0.2 text-meta font-medium text-brand">
                        类目默认
                      </span>
                    ) : null}
                    {pack.source === "library" ? (
                      <span className="inline-flex items-center rounded-sm bg-muted px-1.5 py-0.2 text-meta font-medium text-muted-foreground">
                        已载入
                      </span>
                    ) : null}
                    {pack.shared ? (
                      <span className="inline-flex items-center rounded-sm bg-muted/70 px-1.5 py-0.2 text-meta font-medium text-muted-foreground">
                        已分享
                      </span>
                    ) : null}
                  </label>
                  <div className="flex flex-wrap items-center gap-2 sm:shrink-0">
                    <label className="flex items-center gap-1.5 text-meta text-muted-foreground cursor-pointer select-none">
                      <span>分享字段</span>
                      <Switch
                        size="sm"
                        checked={pack.shared}
                        disabled={busy || queueLocked}
                        onCheckedChange={(checked) => {
                          void packsHttp
                            .fieldPackSetShared({
                              pack_id: pack.id,
                              shared: checked,
                            })
                            .then(() => {
                              notifySuccess(checked ? "已分享字段到字段库" : "已撤回分享字段")
                              return refreshPacks()
                            })
                            .catch((reason) =>
                              notifyCommandError(reason, "无法分享字段"),
                            )
                        }}
                      />
                    </label>
                    <div className="h-3 w-px bg-border/60" aria-hidden="true" />
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="h-7 px-2 text-xs text-muted-foreground hover:text-destructive hover:bg-destructive/10"
                      disabled={busy || queueLocked || deleting}
                      aria-label={`删除 ${pack.name}`}
                      onClick={() => setPendingDelete(pack)}
                    >
                      删除
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          )}
          <div className="flex flex-wrap items-center gap-2 pt-1">
            <Input
              value={packName}
              onChange={(event) => setPackName(event.target.value)}
              placeholder="新字段包名称"
              disabled={busy || queueLocked}
              className="h-8.5 max-w-60 text-compact font-mono text-xs"
            />
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-8.5 text-xs"
              disabled={busy || queueLocked || packName.trim() === ""}
              onClick={() => {
                void packsHttp
                  .fieldPackSaveFromCard({
                    name: packName.trim(),
                    schema,
                    draft,
                    language: schema.language,
                  })
                  .then(() => {
                    setPackName("")
                    notifySuccess("已保存字段包")
                    return refreshPacks()
                  })
                  .catch((reason) =>
                    notifyCommandError(reason, "无法保存字段包"),
                  )
              }}
            >
              保存字段包
            </Button>
          </div>
        </div>

        <DialogFooter className="flex-col sm:flex-row items-center sm:justify-between gap-3 pt-3 pb-1 border-t border-border/70">
          <p className="text-meta leading-4 text-muted-foreground max-w-2xl">
            点发送时用这里的当前值组装价格、VAT、品牌等批次字段（只进 Seller 载荷，不写回已有商品）；名称、货号、图片仍用各行自己的值。
            保存、分享或删除字段包不会改已有方案或已有商品；编辑卡片不会发布到字段库。
          </p>
          <Button
            type="button"
            className="text-compact px-5 h-8.5"
            onClick={() => requestClose(false)}
          >
            完成
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
    <ConfirmDialog
      open={Boolean(pendingDelete)}
      onOpenChange={(next) => {
        if (!next && !deleting) setPendingDelete(undefined)
      }}
      title="删除字段包？"
      description={`将删除「${pendingDelete?.name ?? ""}」。已用它创建的上架方案和商品不受影响。删除类目默认后不会自动改设其他字段包。此操作不可撤销。`}
      confirmText="删除"
      variant="destructive"
      busy={deleting}
      onConfirm={confirmDelete}
    />
    <ConfirmDialog
      open={discardConfirmOpen}
      onOpenChange={setDiscardConfirmOpen}
      title="字段包名称尚未保存"
      description="已输入的字段包名称不会被保存，确定关闭？"
      confirmText="关闭"
      variant="destructive"
      onConfirm={() => {
        setDiscardConfirmOpen(false)
        onOpenChange(false)
      }}
    />
    </>
  )
}
