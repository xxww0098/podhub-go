/** 商品详情主体：共享规格身份，首次进入才挂载重编辑器，切页签保留草稿。 */
import { useCallback, useState } from "react"
import type { CategoryTreeNodeView } from "@/bindings/commands"
import type { SupplierDbPropDef, SupplierDbRow, UpsertSupplierDbPropRequest } from "@/bindings/http-supplier-dbs"
import { Tabs, TabsContent, TabsIndicator, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { computeReadiness, missingReadiness } from "./supplier-readiness"
import { SupplierRowHeader } from "./supplier-row-header"
import { SupplierRowInfoTab } from "./supplier-row-info-tab"
import { SupplierRowPromptTab } from "./supplier-row-prompt-tab"
import { SupplierRowPlatformTab } from "./supplier-row-platform-tab"
import type { PatchFn } from "./supplier-row-fields"

export type SupplierRowTab = "info" | "defaults" | "prompt"
const TAB_DEFS: Array<{key: SupplierRowTab; label: string}> = [
  { key: "info", label: "主要信息" },
  { key: "defaults", label: "平台字段" },
  { key: "prompt", label: "提示词" },
]
const READINESS_TAB: Record<string, SupplierRowTab> = {
  category: "defaults", prompt: "prompt", fixedTags: "prompt", platformPrice: "info", ozonConfig: "defaults",
}
const READINESS_KEYS = Object.keys(READINESS_TAB)
export function SupplierRowBody({
  row,
  rows = [],
  onSelectRow,
  onCreateVariant,
  onDeleteVariant,
  propDefs,
  categoryTree = [],
  categoryLoading,
  onEnsureCategoryTree,
  onPatch,
  onUpdateProp,
  onAddProp,
  onTogglePublish,
  onAdjustPrice,
  initialTab = "info",
  onDirtyChange,
  onPromptPublished,
}: {
  row: SupplierDbRow
  rows?: readonly SupplierDbRow[]
  onSelectRow?: (productId: string) => void
  onCreateVariant?: (size: string) => Promise<boolean>
  /** 删除当前规格 tab — 复用行删除（确认对话框在库页），只剩一个规格时不出现。 */
  onDeleteVariant?: () => void
  propDefs: SupplierDbPropDef[]
  categoryTree?: CategoryTreeNodeView[]
  categoryLoading?: boolean
  onEnsureCategoryTree?: () => Promise<boolean>
  onPatch: PatchFn
  onUpdateProp?: (
    def: SupplierDbPropDef,
    patch: Partial<UpsertSupplierDbPropRequest>,
  ) => Promise<boolean>
  onAddProp?: () => void
  onTogglePublish: () => void | Promise<void>
  onAdjustPrice: (priceCents: number, note: string) => Promise<boolean>
  /** 测试缝：直接渲染某个页签；生产恒从「主要信息」进。 */
  initialTab?: SupplierRowTab
  onDirtyChange?: (dirty: boolean) => void
  onPromptPublished?: () => void
}) {
  const [configEpoch, setConfigEpoch] = useState(0)
  const configSaved = useCallback(() => setConfigEpoch((value) => value + 1), [])
  const [tab, setTab] = useState<SupplierRowTab>(initialTab)
  const [visited, setVisited] = useState(() => new Set<SupplierRowTab>([initialTab]))
  const selectTab = (next: SupplierRowTab) => {
    setTab(next)
    setVisited((current) => new Set([...current, next]))
  }


  // 就绪缺项 → 页签导航：键序与 READINESS_LABELS 一致，标签复用同一份文案。
  const missingLabels = missingReadiness(row)
  const readiness = computeReadiness(row)
  const missingKeys = READINESS_KEYS.filter((key) => !readiness[key as keyof typeof readiness])

  const navigateMedia = () => {
    selectTab("info")
    requestAnimationFrame(() => {
      document.querySelector<HTMLElement>("[data-supplier-row-media-root]")?.scrollIntoView({ block: "nearest" })
    })
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-supplier-row-body="">
      <SupplierRowHeader
        row={row}
        rows={rows}
        onSelectRow={onSelectRow}
        onCreateVariant={onCreateVariant}
        onDeleteVariant={onDeleteVariant}
        onTogglePublish={() => void onTogglePublish()}
        missing={missingKeys.map((key, index) => ({ key, label: missingLabels[index] }))}
        onJumpMissing={(key) => selectTab(READINESS_TAB[key])}
      />

      {/* 主体页签：按事实类分页，重编辑器首次进入才挂载，之后保留以免切页签丢草稿。 */}
      <div className="flex min-h-0 flex-1 flex-col">
        <Tabs
          value={tab}
          onValueChange={(value) => selectTab(value as SupplierRowTab)}
          className="min-h-0 flex-1"
        >
          <div className="border-b border-border px-5"><TabsList variant="line" aria-label="行编辑分区">
            <TabsIndicator variant="line" />
            {TAB_DEFS.map((def) => (
              <TabsTrigger variant="line" key={def.key} value={def.key} data-row-tab={def.key}>
                {def.label}
              </TabsTrigger>
            ))}
          </TabsList></div>
          <TabsContent value="info" keepMounted className="min-h-0 overflow-y-auto px-5 py-4" data-supplier-row-scroll="">
            {/* key 住 productId：换规格重挂载，未落盘的行内草稿不跨行泄漏。 */}
            <div key={row.productId}>
              <SupplierRowInfoTab
                row={row}
                propDefs={propDefs}
                onPatch={onPatch}
                onUpdateProp={onUpdateProp}
                onAddProp={onAddProp}
                onAdjustPrice={onAdjustPrice}
              />
            </div>
          </TabsContent>
          <TabsContent value="prompt" keepMounted className="min-h-0 overflow-y-auto px-5 py-4" data-supplier-row-scroll="">
            {visited.has("prompt") ? <SupplierRowPromptTab row={row} rows={rows} onPatch={onPatch} onDirtyChange={onDirtyChange} configEpoch={configEpoch} onConfigSaved={configSaved} onPromptPublished={onPromptPublished} /> : null}
          </TabsContent>
          <TabsContent value="defaults" keepMounted className="min-h-0 overflow-y-auto px-5 py-4" data-supplier-row-scroll="">
            {visited.has("defaults") ? <SupplierRowPlatformTab
              row={row}
              configEpoch={configEpoch}
              onConfigSaved={configSaved}
              categoryTree={categoryTree}
              categoryLoading={categoryLoading}
              onEnsureCategoryTree={onEnsureCategoryTree}
              onPatch={onPatch}
              onNavigateMedia={navigateMedia}
            /> : null}
          </TabsContent>
        </Tabs>
      </div>
    </div>
  )
}
