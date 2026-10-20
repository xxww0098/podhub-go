import { withoutForeignSearch } from "@/lib/admin-surface"

export function readWorkflowCardId(search: string): string | undefined {
  const value = new URLSearchParams(search).get("cardId")?.trim()
  return value || undefined
}

export function writeWorkflowCardId(href: string, cardId?: string): string {
  const url = new URL(href, "http://localhost")
  if (cardId?.trim()) url.searchParams.set("cardId", cardId.trim())
  else url.searchParams.delete("cardId")
  return `${url.pathname}${withoutForeignSearch(url.search, "listing")}${url.hash}`
}

/**
 * 把 cardId 写进任意地址的 query——其余参数原位保留（与 `withCatalogPick`
 * 同口径）。用在壳层换屏前一刻：从别的屏带着 cardId 进批量上架，落点是那张卡
 * 而不是主列表；`withScreen` 只收掉从批量上架带出来的 cardId。
 */
export function withWorkflowCardId(search: string, cardId?: string): string {
  const params = new URLSearchParams(search)
  if (cardId?.trim()) params.set("cardId", cardId.trim())
  else params.delete("cardId")
  const query = params.toString()
  return query ? `?${query}` : ""
}

/** 「从商库添加」的选品意图：`?pick=1`。 */
export const CATALOG_PICK_PARAM = "pick"

/**
 * 「从商库添加」落在商库屏的选品模式。
 *
 * 意图写进地址而不是另起一份组件状态：地址是唯一事实源，所以刷新、复制链接、
 * keep-alive 面板往返都还原同一模式。它只在「批量上架 → 平台货源」这一程成立——
 * 壳层换屏时收口（`authenticated-app` 的 `goTo`），商库屏读它决定模式条与
 * 清单浮窗的开局状态（`docs/supplier-dbs.md` §7.1）。
 */
export function readCatalogPick(search: string): boolean {
  return new URLSearchParams(search).get(CATALOG_PICK_PARAM) === "1"
}

/** 带上选品意图——`screen=` 与其他参数原位保留。 */
export function withCatalogPick(search: string): string {
  return searchWithPick(search, true)
}

/** 收掉选品意图——离开商库屏时用；`screen=` 与其他参数原位保留。 */
export function withoutCatalogPick(search: string): string {
  return searchWithPick(search, false)
}

function searchWithPick(search: string, pick: boolean): string {
  const params = new URLSearchParams(search)
  if (pick) params.set(CATALOG_PICK_PARAM, "1")
  else params.delete(CATALOG_PICK_PARAM)
  const query = params.toString()
  return query ? `?${query}` : ""
}
