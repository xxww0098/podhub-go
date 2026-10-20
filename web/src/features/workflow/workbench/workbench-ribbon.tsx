import { useState } from "react"
import { OcrModelControls } from "./ocr-model-controls"
import {
  ChevronDown,
  CirclePause,
  ImagePlus,
  ListFilter,
  PackageOpen,
  SlidersHorizontal,
  Tag,
  Trash2,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"
import type { ListingRow } from "../model/listing-row"
import {
  preparationRunning,
  type GuidedPreparation,
  type PreparationActivity,
  type PreparationProgress,
} from "../prepare/preparation-tracks"
import { StoreQuotaPicker } from "../store-quota-picker"
import type {
  BatchSelectionScope,
  WorkbenchScopes,
  WorkbenchStores,
} from "./workbench-contract"
import type { WorkbenchStatusCard } from "./workbench-live-status"
import { WorkbenchLiveStatusButton } from "./workbench-live-status-button"
import { GuidedPrepareButton, PreparationStepSequence } from "./workbench-prepare-controls"
import { UploadBatchMeter } from "./upload-batch-meter-view"
import {
  RIBBON_BUTTON,
  RIBBON_DIVIDER,
  RIBBON_MEDIA_GROUP,
  RIBBON_MEDIA_GROUP_SUPPLIER,
  RIBBON_MEDIA_GROUP_SUPPLIER_WITH_STORES,
  RIBBON_MEDIA_GROUP_WITH_STORES,
  RIBBON_PREPARE_GROUP,
  RIBBON_PUBLISH_GROUP,
  RIBBON_SELECT_GROUP,
  RIBBON_SELECT_GROUP_PICKED,
} from "./workbench-ribbon-classes"
import { SendAllButton } from "./workbench-send-controls"

type WorkbenchRibbonProps = {
  rows: ListingRow[]
  scopes: WorkbenchScopes
  selectionScopes: BatchSelectionScope[]
  stores: WorkbenchStores
  /** Send targets in the current scope: the ticked sendable rows, or every admitted one. */
  sendTargets: ListingRow[]
  liveStatusCards: WorkbenchStatusCard[]
  supplierBound: boolean
  busy: boolean
  preparing: boolean
  activity: PreparationActivity
  preparationProgress: PreparationProgress
  guidedPreparation: GuidedPreparation
  queuePaused: boolean
  queueRunning: boolean
  queueStopRequested: boolean
  storeConfigured: boolean
  storeLabel: string
  onSelectionChange: (rowIds: string[]) => void
  onImportImages: () => void
  onOpenDefaults: () => void
  /**
   * 型号 batch verbs for the ticked rows. Absent when this category has no 9048
   * to write — the track is dropped with the button rather than shipping a
   * control that could never do anything.
   */
  onOpenModel?: () => void
  onQuotaChange?: (storeId: string, quota: number) => void
  onEvenSplitQuotas?: () => void
  onPrepareRows: (rowIds: string[]) => void
  onStopPreparation: () => void
  onRunAiRows: (rowIds: string[]) => void
  onRunRenderRows: (rowIds: string[]) => void
  onRunDeliverRows: (rowIds: string[]) => void
  onPauseQueue: () => void
  /** Destructive and irreversible verbs open their confirmation with these rows. */
  onConfirmDelete: (rowIds: string[]) => void
  onConfirmClear: (rowIds: string[]) => void
  onConfirmSend: (rowIds: string[]) => void
  onOpenStock: () => void
}

/**
 * The one-row batch command ribbon: select, import and defaults, the prepare
 * sequence, live status, then publish. Every count is a scope count decided by
 * `batch-actions.ts`, the same predicates the screen's handlers filter with.
 */
export function WorkbenchRibbon({
  rows,
  scopes,
  selectionScopes,
  stores,
  sendTargets,
  liveStatusCards,
  supplierBound,
  busy,
  preparing,
  activity,
  preparationProgress,
  guidedPreparation,
  queuePaused,
  queueRunning,
  queueStopRequested,
  storeConfigured,
  storeLabel,
  onSelectionChange,
  onImportImages,
  onOpenDefaults,
  onOpenModel,
  onQuotaChange,
  onEvenSplitQuotas,
  onPrepareRows,
  onStopPreparation,
  onRunAiRows,
  onRunRenderRows,
  onRunDeliverRows,
  onPauseQueue,
  onConfirmDelete,
  onConfirmClear,
  onConfirmSend,
  onOpenStock,
}: WorkbenchRibbonProps) {
  const [colorPickerStoreId, setColorPickerStoreId] = useState<string>()
  const queueLocked = queuePaused || queueRunning
  const queueDispatching = queueRunning
  const { boundStoreIds } = stores
  const selectedMode = scopes.picked.length > 0
  /**
   * The resting scope, spelled out. Every batch verb falls back to「全部」when
   * nothing is ticked, so a ribbon full of counts next to an empty checkbox
   * column reads as a selection that was never made. This chip is what says
   * whose rows the counts are.
   */
  const scopeLabel = selectedMode ? `已选 ${scopes.picked.length}` : `全部 ${rows.length}`
  // The group's track template is chosen by its children, not the other way
  // round: a fixed grid drops an extra child onto a clipped second row.
  const mediaGroupClass = supplierBound
    ? RIBBON_MEDIA_GROUP_SUPPLIER
    : RIBBON_MEDIA_GROUP
  const mediaGroupWithStoresClass = supplierBound
    ? RIBBON_MEDIA_GROUP_SUPPLIER_WITH_STORES
    : RIBBON_MEDIA_GROUP_WITH_STORES

  return (
    <section
      className="h-12 w-full min-w-0 max-w-full shrink-0 overflow-hidden rounded-xl border border-border/80 bg-card shadow-[0_1px_2px_rgba(0,0,0,0.03)]"
      aria-label="商品批量操作"
    >
      <div
        data-slot="workbench-action-ribbon"
        className="no-scrollbar h-full w-full min-w-0 overflow-x-auto overflow-y-hidden overscroll-x-contain px-2"
      >
        <div className="flex h-full min-w-max items-center">
          <div
            role="group"
            aria-label="选择商品"
            data-toolbar-slot="selection"
            className={cn(
              RIBBON_SELECT_GROUP,
              selectedMode && RIBBON_SELECT_GROUP_PICKED,
            )}
          >
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className={cn(RIBBON_BUTTON, "justify-start")}
                    disabled={!rows.length || queueLocked}
                    aria-label={`${scopeLabel}，按状态选择商品行`}
                  >
                    <ListFilter aria-hidden />
                    <span className="flex items-center gap-0.5">
                      {scopeLabel}
                      <ChevronDown aria-hidden className="size-3 opacity-60" />
                    </span>
                  </Button>
                }
              />
              <DropdownMenuContent align="start" className="w-48">
                <DropdownMenuGroup>
                  <DropdownMenuLabel>按下一步选择</DropdownMenuLabel>
                  {selectionScopes.map((scope) => (
                    <DropdownMenuItem
                      key={scope.key}
                      disabled={!scope.rows.length}
                      onClick={() => onSelectionChange(scope.rows.map((row) => row.id))}
                    >
                      <span>{scope.label}</span>
                      <span className="ml-auto font-mono text-meta tabular-nums text-muted-foreground">
                        {scope.rows.length}
                      </span>
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuGroup>
                <DropdownMenuSeparator />
                {selectedMode ? (
                  <DropdownMenuItem onClick={() => onSelectionChange([])}>
                    取消选择
                  </DropdownMenuItem>
                ) : (
                  <DropdownMenuItem disabled>尚未选择商品</DropdownMenuItem>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
            {selectedMode ? (
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className={cn(
                        RIBBON_BUTTON,
                        "text-destructive hover:text-destructive",
                      )}
                      onClick={() =>
                        onConfirmDelete(scopes.picked.map((row) => row.id))
                      }
                      aria-label={`删除所选 ${scopes.picked.length} 张图片`}
                    >
                      <Trash2 aria-hidden />
                      删除
                    </Button>
                  }
                />
                <TooltipContent>
                  删除此行。已传到 Ozon 的商品不受影响
                </TooltipContent>
              </Tooltip>
            ) : null}
            {selectedMode && onOpenModel ? (
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className={RIBBON_BUTTON}
                      onClick={onOpenModel}
                      aria-label={`设置所选 ${scopes.picked.length} 行的型号`}
                    >
                      <Tag aria-hidden />
                      型号
                    </Button>
                  }
                />
                <TooltipContent>
                  批量设置共同型号、加入本卡已知型号，或让每行恢复自己的独立型号
                </TooltipContent>
              </Tooltip>
            ) : null}
          </div>

          <div aria-hidden className={RIBBON_DIVIDER} />

          <div
            role="group"
            aria-label="图片与字段"
            data-toolbar-slot="media"
            className={cn(
              mediaGroupClass,
              boundStoreIds.length > 1 &&
                rows.length > 0 &&
                mediaGroupWithStoresClass,
            )}
          >
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className={cn(
                      RIBBON_BUTTON,
                      rows.length === 0 && "font-semibold text-brand hover:bg-brand/10 hover:text-brand",
                    )}
                    disabled={busy || queueLocked || preparing}
                    onClick={onImportImages}
                    aria-label="导入图片"
                  >
                    <ImagePlus aria-hidden />
                    <span>导入</span>
                  </Button>
                }
              />
              <TooltipContent>
                多选图片；拖入文件夹导入一层
              </TooltipContent>
            </Tooltip>
            {supplierBound ? null : (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className={RIBBON_BUTTON}
                disabled={busy || queueDispatching}
                onClick={onOpenDefaults}
                aria-label="默认字段"
              >
                <SlidersHorizontal aria-hidden />
                <span>默认字段</span>
              </Button>
            )}
            {boundStoreIds.length > 1 && rows.length > 0 ? (
              <StoreQuotaPicker
                rowCount={rows.length}
                storeSlices={stores.storeSlices}
                storeMap={stores.storeMap}
                boundStoreIds={boundStoreIds}
                storeColorAssignments={stores.storeColorAssignments}
                storeColorPreferences={stores.storeColorPreferences}
                colorPickerStoreId={colorPickerStoreId}
                onColorPickerChange={setColorPickerStoreId}
                onUpdateStoreColors={stores.updateStoreColors}
                onQuotaChange={onQuotaChange}
                onEvenSplitQuotas={onEvenSplitQuotas}
                className={RIBBON_BUTTON}
                disabled={busy || queueLocked || preparing}
              />
            ) : null}
          </div>

          <div aria-hidden className={RIBBON_DIVIDER} />

          <div
            role="group"
            aria-label="准备商品"
            data-toolbar-slot="prepare"
            className={RIBBON_PREPARE_GROUP}
          >
            <GuidedPrepareButton
              count={scopes.prepareTargets.length}
              selected={selectedMode}
              guided={guidedPreparation}
              activity={activity}
              disabled={busy || queueLocked || preparationRunning(activity)}
              onClick={() =>
                onPrepareRows(scopes.prepareTargets.map((row) => row.id))
              }
              onStop={onStopPreparation}
            />
            <PreparationStepSequence
              disabled={busy || queueLocked || guidedPreparation.active}
              rows={scopes.picked.length ? scopes.picked : scopes.prepareTargets.length ? scopes.prepareTargets : scopes.unsent}
              activity={activity}
              progress={preparationProgress}
              aiTargets={scopes.aiTargets}
              renderTargets={scopes.renderTargets}
              deliverTargets={scopes.deliverTargets}
              onRunAiRows={onRunAiRows}
              onRunRenderRows={onRunRenderRows}
              onRunDeliverRows={onRunDeliverRows}
              clearCount={scopes.clearTargets.length}
              clearDisabled={busy || queueLocked || preparing}
              onClear={() =>
                onConfirmClear(scopes.clearTargets.map((row) => row.id))
              }
            />
          </div>
          <UploadBatchMeter
            rows={rows}
            activity={activity}
            disabled={busy || queueLocked || guidedPreparation.active}
            onRetryFailed={onRunDeliverRows}
          />

          <OcrModelControls disabled={busy || queueLocked || preparing || preparationRunning(activity) || guidedPreparation.active} />

          {liveStatusCards.length ? (
            <>
              <div aria-hidden className={RIBBON_DIVIDER} />
              <WorkbenchLiveStatusButton cards={liveStatusCards} />
            </>
          ) : null}

          <div aria-hidden className={RIBBON_DIVIDER} />

          <div
            role="group"
            aria-label="发布商品"
            data-toolbar-slot="publish"
            className={RIBBON_PUBLISH_GROUP}
          >
            {queueRunning ? (
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      type="button"
                      variant="brand"
                      size="sm"
                      className={RIBBON_BUTTON}
                      disabled={busy || queuePaused || queueStopRequested}
                      onClick={onPauseQueue}
                      aria-label="暂停发送队列"
                    >
                      <CirclePause aria-hidden />
                      <span>{queuePaused ? "暂停中" : "暂停"}</span>
                    </Button>
                  }
                />
                <TooltipContent>当前批次结算后暂停，不再发送下一批</TooltipContent>
              </Tooltip>
            ) : (
              <SendAllButton
                count={sendTargets.length}
                selected={selectedMode}
                storeLabel={storeLabel}
                concurrent={boundStoreIds.length > 1}
                disabled={busy || preparing || !storeConfigured}
                onClick={() => onConfirmSend(sendTargets.map((row) => row.id))}
                readyBatch={
                  sendTargets.length > 0 &&
                  sendTargets.length === (selectedMode ? scopes.picked.length : rows.length) &&
                  scopes.exceptionCount === 0 &&
                  !queueLocked &&
                  !preparing
                }
              />
            )}
            <Button
              type="button"
              variant="outline"
              size="sm"
              className={RIBBON_BUTTON}
              disabled={busy || queueLocked || preparing}
              onClick={onOpenStock}
            >
              <PackageOpen aria-hidden />
              <span>改库存</span>
            </Button>
          </div>
        </div>
      </div>
    </section>
  )
}
