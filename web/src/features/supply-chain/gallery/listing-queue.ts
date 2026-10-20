/**
 * 收藏与上架清单 — 卖家选品时的两本本地簿（localStorage，跨筛选/详情/刷新存活）。
 *
 * 货盘是平台级只读数据，收藏与清单是浏览器侧的「挑货草稿」：不入 Cloud 事实
 * 源，不产生任何写请求。每条清单还能攒下「目标店铺」与「PSD 模板」两笔绑定，
 * 同样是本机草稿；SC-06 adopt seam（商品 → 上架方案）导入时由调用方把它们
 * 落到新卡上——本模块只管收集与绑定，不管上架。
 *
 * 存储是模块级 external store：detail / card / drawer 三个面读同一份快照，
 * useSyncExternalStore 保证一处改动处处同步；SSR 渲染回退空快照。
 */
import { useMemo, useSyncExternalStore } from "react"

import type { SellerSupplierDbRowData } from "@/bindings/http-supplier-dbs-catalog"

import { listabilityOf } from "./gallery-model"

/**
 * 清单里攒下的 PSD 模板绑定：asset_id 既是内容摘要也是本机 OPFS 的键
 * （renderOpfs.workflowPickTemplatePsd 的口径），所以导入时原样交给
 * listingCardSavePsd。
 */
export type ListingQueuePsd = {
  sha256: string
  fileName: string
}

/** 清单条目：上架导航需要的最小身份 + 浮窗展示需要的快照字段。 */
export type ListingQueueEntry = {
  productId: string
  sourceId: string
  title: string
  platformCode: string
  size?: string
  /**
   * 货源行的款号（sc_products.variant_group）。非空时这条选品可以与同库同款号
   * 的其他规格一起走「同源多规格导入」；空款号不参与（空款号不自动关联）。
   * 只是请求输入，服务端派生关联身份并核对卡的货源绑定。
   */
  variantGroup?: string
  /** 封面快照——行后来补图/换图不影响已加入时的那一瞥。 */
  coverUrl: string
  platformPriceCents: number | null
  /**
   * 目标店铺（cloud store uuid）；缺省 = 不绑定，导入时让新卡落在默认店铺。
   * 与 PSD 一样是「挑货时先攒下、导入时再落卡」的草稿字段：老数据没有它们，
   * 读回照常。
   */
  storeId?: string
  /** PSD 模板覆盖；缺省 = 用商库默认模板。 */
  psd?: ListingQueuePsd
  addedAtMs: number
}

export type GalleryCollection = {
  /** 上架清单，新条目在尾部；展示时按 addedAtMs 倒序。 */
  queue: ListingQueueEntry[]
  /** 收藏的 productId 列表。 */
  favorites: string[]
}

const EMPTY_COLLECTION: GalleryCollection = { queue: [], favorites: [] }

const QUEUE_KEY = "podhub.supplier-dbs-gallery.listing-queue"
const FAVORITES_KEY = "podhub.supplier-dbs-gallery.favorites"

/** 存进来的 PSD 绑定：摘要缺失（或类型不对）就当没绑，不把坏值带上屏。 */
function storedPsd(value: unknown): ListingQueuePsd | undefined {
  if (!value || typeof value !== "object") return undefined
  const psd = value as ListingQueuePsd
  const sha256 = typeof psd.sha256 === "string" ? psd.sha256.trim() : ""
  if (!sha256) return undefined
  return { sha256, fileName: typeof psd.fileName === "string" ? psd.fileName : "" }
}

/**
 * 存储 → 清单条目。逐条校验而不是整表拒绝：商品身份在就算数，绑定字段
 * （storeId / psd）是后加的增量——老数据没有它们照样读回，坏值丢掉即可。
 */
export function queueEntriesFromStored(value: unknown): ListingQueueEntry[] {
  if (!Array.isArray(value)) return []
  const entries: ListingQueueEntry[] = []
  for (const raw of value) {
    if (!raw || typeof raw !== "object") continue
    const entry = raw as ListingQueueEntry
    if (typeof entry.productId !== "string" || !entry.productId) continue
    const storeId = typeof entry.storeId === "string" ? entry.storeId.trim() : ""
    const psd = storedPsd(entry.psd)
    const variantGroup = typeof entry.variantGroup === "string" ? entry.variantGroup.trim() : ""
    const { storeId: _storedStore, psd: _storedPsd, variantGroup: _storedGroup, ...rest } = entry
    entries.push({
      ...rest,
      ...(storeId ? { storeId } : {}),
      ...(psd ? { psd } : {}),
      ...(variantGroup ? { variantGroup } : {}),
    })
  }
  return entries
}

function readStored(): GalleryCollection {
  if (typeof window === "undefined") return EMPTY_COLLECTION
  try {
    const queueRaw = window.localStorage.getItem(QUEUE_KEY)
    const favRaw = window.localStorage.getItem(FAVORITES_KEY)
    const queue: unknown = queueRaw ? JSON.parse(queueRaw) : []
    const favorites: unknown = favRaw ? JSON.parse(favRaw) : []
    return {
      queue: queueEntriesFromStored(queue),
      favorites: Array.isArray(favorites)
        ? favorites.filter((id): id is string => typeof id === "string" && id !== "")
        : [],
    }
  } catch {
    return EMPTY_COLLECTION
  }
}

let collection: GalleryCollection = readStored()
const listeners = new Set<() => void>()

function subscribeCollection(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

function snapshotCollection(): GalleryCollection {
  return collection
}

function serverCollection(): GalleryCollection {
  return collection
}

function persist(next: GalleryCollection): void {
  collection = next
  try {
    window.localStorage.setItem(QUEUE_KEY, JSON.stringify(next.queue))
    window.localStorage.setItem(FAVORITES_KEY, JSON.stringify(next.favorites))
  } catch {
    // A full or private-mode store is not worth failing the screen for.
  }
  for (const listener of listeners) listener()
}

/** 行 → 清单条目的快照：收藏的是「当时看到的那件货」。 */
export function queueEntryFromRow(row: SellerSupplierDbRowData): ListingQueueEntry {
  return {
    productId: row.productId,
    sourceId: row.sourceId,
    title: row.title,
    platformCode: row.platformCode,
    ...(row.size ? { size: row.size } : {}),
    ...(row.variantGroup?.trim() ? { variantGroup: row.variantGroup.trim() } : {}),
    coverUrl: row.gallery[0]?.url ?? "",
    platformPriceCents: row.platformPriceCents ?? null,
    addedAtMs: Date.now(),
  }
}

export function isQueued(productId: string): boolean {
  return collection.queue.some((entry) => entry.productId === productId)
}

/** 只提交最新货盘中仍可用的规格，保留清单顺序。 */
export function availableQueueRows(
  queue: ListingQueueEntry[],
  rowsById: ReadonlyMap<string, SellerSupplierDbRowData>,
): SellerSupplierDbRowData[] {
  return queue.flatMap((entry) => {
    const row = rowsById.get(entry.productId)
    return row ? [row] : []
  })
}

/**
 * 批量导入的可达集：在最新货盘里且当前可上架。暂不可上架的行被跳过并计数
 * （调用方一次性报数），但清单条目不清——平台复核/恢复后下一次导入照常带上。
 */
export function importableQueueRows(present: SellerSupplierDbRowData[]): {
  rows: SellerSupplierDbRowData[]
  skipped: number
} {
  const rows = present.filter((row) => listabilityOf(row).listable)
  return { rows, skipped: present.length - rows.length }
}

export function isFavorite(productId: string): boolean {
  return collection.favorites.includes(productId)
}

/** 加入/移出上架清单——幂等按 productId 去重。 */
export function toggleQueued(row: SellerSupplierDbRowData): void {
  if (isQueued(row.productId)) {
    persist({
      ...collection,
      queue: collection.queue.filter((entry) => entry.productId !== row.productId),
    })
    return
  }
  persist({ ...collection, queue: [...collection.queue, queueEntryFromRow(row)] })
}

export function removeQueued(productId: string): void {
  persist({
    ...collection,
    queue: collection.queue.filter((entry) => entry.productId !== productId),
  })
}

export function clearQueue(): void {
  persist({ ...collection, queue: [] })
}

/** 只改一条已入清单的条目；不在清单里就什么也不做（不凭空补条目）。 */
function updateQueueEntry(
  productId: string,
  update: (entry: ListingQueueEntry) => ListingQueueEntry,
): void {
  if (!collection.queue.some((entry) => entry.productId === productId)) return
  persist({
    ...collection,
    queue: collection.queue.map((entry) =>
      entry.productId === productId ? update(entry) : entry,
    ),
  })
}

/** 绑定/改绑/清除目标店铺——空串就是「不绑定」，导入时让新卡落回默认店铺。 */
export function setQueuedStore(productId: string, storeId: string): void {
  const next = storeId.trim()
  updateQueueEntry(productId, (entry) => {
    const { storeId: _previous, ...rest } = entry
    return next ? { ...rest, storeId: next } : rest
  })
}

/** 绑定/清除 PSD 模板——null 就是「恢复商库默认」。 */
export function setQueuedPsd(productId: string, psd: ListingQueuePsd | null): void {
  const next = psd
    ? { sha256: psd.sha256.trim(), fileName: psd.fileName }
    : undefined
  updateQueueEntry(productId, (entry) => {
    const { psd: _previous, ...rest } = entry
    return next?.sha256 ? { ...rest, psd: next } : rest
  })
}

/**
 * 导入时查这一件商品攒下的绑定。没有条目、或条目是加字段之前的老数据，
 * 都返回 undefined——调用方按「没有绑定」处理。
 */
export function queueEntryById(productId: string): ListingQueueEntry | undefined {
  return collection.queue.find((entry) => entry.productId === productId)
}

export function toggleFavorite(productId: string): void {
  persist({
    ...collection,
    favorites: isFavorite(productId)
      ? collection.favorites.filter((id) => id !== productId)
      : [...collection.favorites, productId],
  })
}

/** 测试钩子：node 测试共享同一模块态，逐例复位防串味。 */
export function resetCollectionForTests(): void {
  collection = EMPTY_COLLECTION
}

export function useGalleryCollection() {
  const state = useSyncExternalStore(
    subscribeCollection,
    snapshotCollection,
    serverCollection,
  )
  return useMemo(
    () => ({
      queue: state.queue,
      favorites: state.favorites,
      queueIds: new Set(state.queue.map((entry) => entry.productId)),
      queueEntriesById: new Map(state.queue.map((entry) => [entry.productId, entry])),
      favoriteIds: new Set(state.favorites),
      isQueued,
      isFavorite,
      toggleQueued,
      toggleFavorite,
      removeQueued,
      clearQueue,
      setQueuedStore,
      setQueuedPsd,
    }),
    [state],
  )
}
