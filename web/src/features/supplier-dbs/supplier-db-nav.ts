import { replaceAddress } from "@/lib/address"

/**
 * 平台货源的打开态就是地址：`?open=<source_id>`。
 *
 * 没有第二份导航状态——库页由地址渲染（[address](../../lib/address.ts)）：列表
 * 行点击、建库直达、面包屑回程都只改地址（`replaceState`，不新增浏览器历史
 * 条目）。于是刷新、分享、复制链接都停在同一个库上；壳层换屏时收掉这个键，
 * 回程落在库列表，而不是留在上一次打开的库。
 */
const SCREEN = "supplier-dbs"

/** `?open=` — 屏自己的键；缺省（空串也算）表示停在库列表。 */
export function openSupplierDbId(search: string): string | null {
  const id = new URLSearchParams(search).get("open")?.trim()
  return id || null
}

/**
 * 进库（`sourceId`）/ 回库列表（`null`）。
 *
 * 只在货源管理屏自己的地址上写：别的屏带着 `open` 只是路过（壳层的
 * `withScreen` 会收掉它），不能从那里被改写成「打开某个库」。
 */
export function writeOpenSupplierDb(sourceId: string | null): void {
  if (typeof window === "undefined") return
  try {
    const url = new URL(window.location.href)
    const screen = url.searchParams.get("screen")
    if (sourceId) {
      if (screen && screen !== SCREEN) return
      url.searchParams.set("screen", SCREEN)
      url.searchParams.set("open", sourceId)
    } else {
      url.searchParams.delete("open")
    }
    replaceAddress(url.href)
  } catch {
    // A URL the browser refuses is not worth failing navigation for.
  }
}
