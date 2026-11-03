import type { ImageSet } from "@/bindings/http-ai-image-sets"
import type { WorkflowDraftView } from "@/bindings/commands"
import { peekAccountOverview } from "@/features/account/account-overview-cache"
import { rowPreparing } from "../prepare/preparation-tracks"
import { deliveredMediaSlices, mediaSelectionOpen } from "../workbench/media-selection"
import type { ListingWorkbenchRuntime } from "../workbench/listing-workbench-store"

export type ImageSetScope = { owner: string; cardId: string; rowId: string; draftId: string; sourceHandle: string }
export type ImageSetIntent = ImageSetScope & { rawSHA256: string; key: string; setId?: string }
export type ImageSetMediaEdit = { intent: ImageSetIntent; view: ImageSet; urls: string[] } | { intent: ImageSetIntent; restore: true }
const prefix = "podhub.ai-image-set.v1:"

export function imageSetOwner(): string {
  const overview = peekAccountOverview()
  if (!overview?.session.authenticated || !overview.active_workspace?.uuid) return ""
  const account = overview.session.uuid ?? overview.session.email
  return account ? `${account}:${overview.active_workspace.uuid}` : ""
}
export function intentStorageKey(scope: ImageSetScope): string { return prefix + JSON.stringify([scope.owner, scope.cardId, scope.rowId, scope.draftId, scope.sourceHandle]) }
export function sameImageSetScope(a: ImageSetScope, b: ImageSetScope): boolean {
  return a.owner === b.owner && a.cardId === b.cardId && a.rowId === b.rowId && a.draftId === b.draftId && a.sourceHandle === b.sourceHandle
}
export function readImageSetIntent(scope: ImageSetScope, storage?: Pick<Storage, "getItem">): ImageSetIntent | undefined {
  try {
    const raw = (storage ?? globalThis.localStorage)?.getItem(intentStorageKey(scope))
    if (!raw || raw.length > 4096) return
    const value = JSON.parse(raw) as ImageSetIntent
    if (sameImageSetScope(value, scope) && /^[a-f0-9]{64}$/.test(value.rawSHA256) && /^image-set-[a-f0-9-]{36}$/.test(value.key)
      && (!value.setId || /^[a-f0-9-]{36}$/.test(value.setId))) return value
  } catch { /* Missing or damaged metadata never authorizes a purchase. */ }
}
export function saveImageSetIntent(intent: ImageSetIntent, storage: Storage = localStorage): void {
  storage.setItem(intentStorageKey(intent), JSON.stringify(intent))
  if (readImageSetIntent(intent, storage)?.key !== intent.key) throw new Error("无法保存套图请求，请检查浏览器存储")
}
type PurchaseLocks = { request: <T>(name: string, callback: () => T | Promise<T>) => Promise<T> }
export async function reserveImageSetIntent(scope: ImageSetScope, rawSHA256: string, canPurchase: () => boolean, locks: PurchaseLocks | undefined = navigator.locks, storage: Storage = localStorage, replaceKey?: string): Promise<{ intent: ImageSetIntent; created: boolean }> {
  if (!locks) throw new Error("当前浏览器不支持安全购买锁，请使用桌面应用")
  return locks.request(intentStorageKey(scope), () => {
    if (!canPurchase()) throw new Error("来源或商品状态已变化")
    const existing = readImageSetIntent(scope, storage)
    if (!existing && storage.getItem(intentStorageKey(scope))) throw new Error("套图请求记录损坏，暂不能再次购买")
    if (existing && (!replaceKey || replaceKey !== existing.key)) return { intent: existing, created: false }
    if (replaceKey && !existing) throw new Error("原请求记录已变化，请重新查询")
    const intent = { ...scope, rawSHA256, key: `image-set-${crypto.randomUUID()}` }
    saveImageSetIntent(intent, storage)
    return { intent, created: true }
  })
}
export function retryableImageSet(view: ImageSet): boolean {
  return view.status === "failed" && view.items.length === 3 && view.items.every((item) => item.status === "failed")
}
export async function updateImageSetIntent(scope: ImageSetScope, key: string, setId: string | null, locks: PurchaseLocks | undefined = navigator.locks, storage: Storage = localStorage): Promise<ImageSetIntent | undefined> {
  if (!locks) return readImageSetIntent(scope, storage)
  return locks.request(intentStorageKey(scope), () => {
    const existing = readImageSetIntent(scope, storage)
    if (!existing || existing.key !== key) return existing
    if (setId === null) { storage.removeItem(intentStorageKey(scope)); return undefined }
    const updated = { ...existing, setId }
    saveImageSetIntent(updated, storage)
    return updated
  })
}
export function imageSetUnknown(view: ImageSet): boolean {
  return view.status === "unknown" || view.status === "processing" || view.items.some((item) => item.status === "unknown" || item.status === "processing")
}
export function readyImageSetURLs(view: ImageSet): string[] {
  if (view.items.length !== 3 || new Set(view.items.map((item) => item.ordinal)).size !== 3 || view.items.some((item) => ![0, 1, 2].includes(item.ordinal))) return []
  return [...view.items].sort((a, b) => a.ordinal - b.ordinal).flatMap((item) => {
    if (item.status !== "ready" || !item.asset || !/^[a-f0-9]{64}$/.test(item.asset.sha256)) return []
    try {
      const url = new URL(item.asset.url)
      return url.origin === "https://podhub-supplier.ozon-pod.com" && !url.search && !url.hash && url.pathname.endsWith(`/images/${item.asset.sha256}.jpg`) ? [url.href] : []
    } catch { return [] }
  })
}
export function imageSetEditOpen(current: ListingWorkbenchRuntime, scope: ImageSetScope, owner = imageSetOwner()): boolean {
  const row = current.rows.find((item) => item.draftId === scope.draftId)
  const product = current.productDrafts[scope.draftId]
  return Boolean(owner && sameImageSetScope(scope, { owner, cardId: current.cardId ?? "", rowId: row?.id ?? "", draftId: scope.draftId, sourceHandle: row?.source?.handle ?? "" })
    && mediaSelectionOpen(row, product) && !rowPreparing(current.activity, row!.id)
    && !current.pendingRemovalIds.has(scope.draftId) && !current.removedProducts.has(scope.draftId) && !current.queueFrozenIds.includes(scope.draftId))
}

/** One scoped action changes both manual fields; PSD deliveries and evidence stay intact. */
export function imageSetMediaDraft(current: ListingWorkbenchRuntime, draftId: string, edit: ImageSetMediaEdit, owner = imageSetOwner()): WorkflowDraftView {
  const product = current.productDrafts[draftId]
  if (draftId !== edit.intent.draftId || !imageSetEditOpen(current, edit.intent, owner)) {
    throw new Error("来源或商品状态已变化，不能修改图片")
  }
  const available = "restore" in edit ? deliveredMediaSlices(product!.lifecycle).map((image) => image.public_url!) : readyImageSetURLs(edit.view)
  if (!("restore" in edit) && edit.view.id !== edit.intent.setId) throw new Error("套图结果不属于当前请求")
  const urls = "restore" in edit ? available : edit.urls
  if (!urls.length || new Set(urls).size !== urls.length || urls.some((url) => !available.includes(url))) throw new Error("请选择本次已就绪图片")
  const draft = product!.draft
  return { ...product!, draft: { ...draft, values: { ...draft.values, images: { kind: "url_list", value: [...urls] }, primary_image: { kind: "text", value: urls[0]! } }, cleared: draft.cleared?.filter((key) => key !== "images" && key !== "primary_image") },
    hand_edited_keys: [...new Set([...(product!.hand_edited_keys ?? []), "images", "primary_image"])] }
}
