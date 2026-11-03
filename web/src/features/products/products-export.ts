import type { StoreProductRow } from "./products-api"

const LABELS: Record<string, string> = {
  on_sale: "在售",
  processing: "处理中",
  hidden: "隐藏",
  moderation_failed: "审核失败",
  archived: "已归档",
}

/** Quote every field and neutralize spreadsheet formulas in user-controlled text. */
function csvCell(value: string | number | null | undefined): string {
  let text = value == null ? "" : String(value)
  if (/^[\s]*[=+@-]/.test(text) || /^\d{16,}$/.test(text)) text = "'" + text
  return '"' + text.replace(/"/g, '""') + '"'
}

export function productsCsv(
  rows: readonly StoreProductRow[],
  currencyOf: (storeId: string) => string | null,
  snapshotAtOf: (storeId: string) => number | null,
): string {
  const header = ["商品名称", "货号", "SKU", "店铺", "售价", "币种", "库存", "商品状态", "快照更新时间"]
  const lines = rows.map((row) => {
    const valid = (value: number | null | undefined) => typeof value === "number" && value > 0 && Number.isFinite(value) && !Number.isNaN(new Date(value).getTime())
    const own = row.refreshed_at_ms
    const store = snapshotAtOf(row.store_id)
    const observed = valid(own) ? own : valid(store) ? store : null
    const date = observed ? new Date(observed) : null
    const timestamp = date && !Number.isNaN(date.getTime()) ? date.toISOString() : ""
    return [
      row.name, row.offer_id, row.sku, row.store_name, row.price,
      currencyOf(row.store_id), row.stock_present,
      row.gone ? "已下架" : row.state ? LABELS[row.state] ?? "未知" : "未知", timestamp,
    ].map(csvCell).join(",")
  })
  return "\uFEFF" + [header.map(csvCell).join(","), ...lines].join("\r\n")
}

export function downloadProductsCsv(content: string | Uint8Array<ArrayBuffer>): void {
  const url = URL.createObjectURL(new Blob([content], { type: "text/csv;charset=utf-8" }))
  const link = document.createElement("a")
  link.href = url
  link.download = "ozon-products-" + new Date().toISOString().slice(0, 10) + ".csv"
  link.click()
  setTimeout(() => URL.revokeObjectURL(url), 0)
}
