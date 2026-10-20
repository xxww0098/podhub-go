/**
 * 店铺商品表的写入编排：行菜单与批量栏共用一个 `runAction` 入口——过滤
 * 可写行、归到一家店，再打开对应对话框；写入落地后回填或回读镜像行。
 */
import { useCallback, useState, type Dispatch, type ReactNode, type SetStateAction } from "react"

import { notifyCommandError, notifyError, notifyInfo, notifySuccess } from "@/lib/notify"

import { ACTION_LABEL } from "./products-actions"
import {
  verifyStoreProducts,
  type StoreProductOverviewRow,
  type StoreProductRow,
  type StoreProductStatusFilter,
} from "./products-api"
import { ProductLifecycleDialog, type LifecycleAction } from "./products-lifecycle-dialog"
import {
  VERIFY_LIMIT,
  chunkRows,
  listAfterArchive,
  primaryStoreGroup,
  rowKey,
  writableFor,
  type ProductAction,
} from "./products-mutation"
import { ProductPriceDialog, type AppliedPrice } from "./products-price-dialog"
import { ProductPromotionDialog } from "./products-promotion-dialog"
import { ProductStockDialog } from "./products-stock-dialog"
import { ProductVariantDialog } from "./products-variant-dialog"
import {
  isVariantAction,
  openInScope,
  type VariantTargetOption,
} from "./products-variant-model"

type WriteAction = Exclude<ProductAction, "verify">

function isLifecycle(action: WriteAction): action is LifecycleAction {
  return action === "archive" || action === "unarchive" || action === "delete"
}

export function useProductWrites({
  stores,
  syncDisabled,
  setRows,
  clearSelection,
  reloadOverview,
  reloadList,
  listStatus,
  onArchived,
  scopeKey,
  variantTargets,
}: {
  stores: StoreProductOverviewRow[]
  syncDisabled: boolean
  setRows: Dispatch<SetStateAction<StoreProductRow[]>>
  clearSelection: () => void
  reloadOverview: () => Promise<void>
  reloadList: () => Promise<void>
  /** 当前状态页签。归档成功后，非「档案」页把这些行拿掉。 */
  listStatus: StoreProductStatusFilter | undefined
  /** 归档回执已落地：先按这些行挪页签计数，再由 reload 回读服务端。 */
  onArchived: (rows: StoreProductRow[]) => void
  /** 工作空间 + 店铺：换范围后属于上一范围的打开状态一律作废。 */
  scopeKey: string
  /** 「移入已有同款」的候选：当前列表里已观察到的同款分组。 */
  variantTargets: readonly VariantTargetOption[]
}): {
  verifying: Set<string>
  runAction: (action: ProductAction, candidates: StoreProductRow[]) => void
  refreshAfterWrite: (targets: StoreProductRow[]) => void
  dialogs: ReactNode
} {
  const [verifying, setVerifying] = useState<Set<string>>(new Set())
  // 打开状态记住它是在哪个范围里开的：换店铺/换工作空间后，旧范围的行不再
  // 出现在弹窗里，晚回包也没有可重填的目标。
  const [mutation, setMutation] = useState<{
    action: WriteAction
    rows: StoreProductRow[]
    scope: string
  } | null>(null)
  const opened = openInScope(mutation, scopeKey)

  /** 向 Ozon 核实同一家店的若干行并就地替换；`quiet` 用于写入后的自动回读。 */
  const verifyRows = useCallback(
    async (targets: StoreProductRow[], quiet = false) => {
      const target = targets[0]
      if (!target) return
      const keys = targets.map((row) => `${row.store_id}:${row.offer_id}`)
      setVerifying((prev) => new Set([...prev, ...keys]))
      try {
        let refreshed = 0
        for (const chunk of chunkRows(targets, VERIFY_LIMIT)) {
          const verified = await verifyStoreProducts(
            target.store_id,
            chunk.map((row) => row.offer_id),
          )
          const byOffer = new Map(verified.map((item) => [item.offer_id, item]))
          refreshed += verified.length
          setRows((prev) =>
            prev.map((item) =>
              item.store_id === target.store_id ? (byOffer.get(item.offer_id) ?? item) : item,
            ),
          )
        }
        if (!quiet) {
          if (refreshed === 0) notifyInfo("Ozon 未返回这些商品，数据未变更")
          else notifySuccess(`已核实 ${refreshed} 件商品`)
        }
      } catch (reason) {
        notifyCommandError(reason, "核实失败，请稍后重试。")
      } finally {
        setVerifying((prev) => {
          const next = new Set(prev)
          for (const key of keys) next.delete(key)
          return next
        })
      }
    },
    [setRows],
  )

  /** 写入落地后回读：少量行直接核实，量大或核实被停用时重读镜像。 */
  const refreshAfterWrite = useCallback(
    (targets: StoreProductRow[]) => {
      void reloadOverview()
      if (!syncDisabled && targets.length <= VERIFY_LIMIT) void verifyRows(targets, true)
      else void reloadList()
    },
    [reloadOverview, reloadList, verifyRows, syncDisabled],
  )

  const runAction = useCallback(
    (action: ProductAction, candidates: StoreProductRow[]) => {
      const { ok, dropped } = writableFor(action, candidates)
      if (dropped.length > 0 && ok.length > 0) {
        notifyInfo(`${dropped.length} 件不能${ACTION_LABEL[action]}，已跳过`)
      }
      const group = primaryStoreGroup(ok)
      if (!group) {
        notifyError(`已选商品都不能${ACTION_LABEL[action]}`)
        return
      }
      if (group.droppedStores > 0) {
        notifyInfo("一次操作只写一家店铺；其余店铺的商品未包含")
      }
      if (action === "verify") {
        void verifyRows(group.rows)
        return
      }
      setMutation({ action, rows: group.rows, scope: scopeKey })
    },
    [verifyRows, scopeKey],
  )

  const mutationRows = opened?.rows ?? []

  const applyLifecycle = useCallback(
    (action: LifecycleAction, succeeded: Set<string>) => {
      const done = mutationRows.filter((row) =>
        succeeded.has(action === "delete" ? row.offer_id : String(row.product_id)),
      )
      const doneKeys = new Set(done.map(rowKey))
      clearSelection()
      if (action === "unarchive") {
        refreshAfterWrite(done)
        return
      }
      if (action === "archive") {
        // 页签计数来自汇总列，不来自当前页。回执成功后先按行挪计数，
        // 再重读汇总；非档案页拿掉这些行并重载列表，下一页才能补上来。
        onArchived(done)
        setRows((prev) => listAfterArchive(prev, doneKeys, listStatus))
        void reloadOverview()
        void reloadList()
        return
      }
      setRows((prev) => prev.filter((row) => !doneKeys.has(rowKey(row))))
      void reloadOverview()
    },
    [
      mutationRows,
      clearSelection,
      refreshAfterWrite,
      setRows,
      reloadOverview,
      reloadList,
      listStatus,
      onArchived,
    ],
  )

  /** 分组回执已落地：清勾选并重读镜像。分组事实由镜像观察，核实走账本观察轴
   * （对话框里的「核实结果」），这里不再向 Ozon 追一次单行读。 */
  const applyVariantOperation = useCallback(() => {
    clearSelection()
    void reloadOverview()
    void reloadList()
  }, [clearSelection, reloadOverview, reloadList])

  const applyPrices = useCallback(
    (applied: AppliedPrice[]) => {
      const target = mutationRows[0]?.store_id
      const patch = new Map(applied.map((item) => [item.productId, item]))
      setRows((prev) =>
        prev.map((row) => {
          const hit = row.store_id === target ? patch.get(row.product_id) : undefined
          return hit ? { ...row, price: hit.price, oldPrice: hit.oldPrice } : row
        }),
      )
      void reloadOverview()
    },
    [mutationRows, setRows, reloadOverview],
  )

  const store = stores.find((item) => item.store_id === mutationRows[0]?.store_id)
  const storeName = store?.name ?? ""
  const lifecycleAction = opened && isLifecycle(opened.action) ? opened.action : null
  const variantAction = opened && isVariantAction(opened.action) ? opened.action : null
  const close = () => setMutation(null)
  const rowsFor = (action: WriteAction) => (opened?.action === action ? mutationRows : [])

  const dialogs = (
    <>
      <ProductPriceDialog
        open={opened?.action === "price"}
        rows={rowsFor("price")}
        storeName={storeName}
        currency={store?.currency ?? ""}
        onClose={close}
        onApplied={applyPrices}
      />
      <ProductStockDialog
        open={opened?.action === "stock"}
        rows={rowsFor("stock")}
        storeName={storeName}
        onClose={close}
        onApplied={() => refreshAfterWrite(mutationRows)}
      />
      <ProductPromotionDialog
        open={opened?.action === "promotion"}
        rows={rowsFor("promotion")}
        storeName={storeName}
        onClose={close}
        onApplied={() => refreshAfterWrite(mutationRows)}
      />
      <ProductLifecycleDialog
        action={lifecycleAction}
        rows={lifecycleAction ? mutationRows : []}
        storeName={storeName}
        onClose={close}
        onApplied={applyLifecycle}
      />
      {/* 只在打开时挂载：关掉再打开是一次新意图，内部状态与 operation_id 都要换新。 */}
      {variantAction ? (
        <ProductVariantDialog
          action={variantAction}
          rows={mutationRows}
          storeName={storeName}
          scopeKey={scopeKey}
          targets={variantTargets}
          onClose={close}
          onApplied={applyVariantOperation}
        />
      ) : null}
    </>
  )

  return { verifying, runAction, refreshAfterWrite, dialogs }
}
