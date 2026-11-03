import type { WorkflowCategoryDraft, WorkflowDraftValue, WorkflowDraftView, WorkflowImageLifecycle, WorkflowProductLifecycle } from "@/bindings/commands"
import { mediaCellState, mediaRoleOf, type MediaCellState, type MediaRoleKey } from "../media/workflow-media-roles"
import type { ListingRow } from "../model/listing-row"
import { proseCellSkip, rowPublishFenced } from "../model/listing-row-lifecycle"

export type SelectableMediaRole = "images" | "primary_image"

export function mediaSelectionOpen(row: ListingRow | undefined, product: WorkflowDraftView | undefined): boolean {
  return Boolean(row && product && !rowPublishFenced(row, product.lifecycle) && proseCellSkip(row, product) === null
    && product.lifecycle.media === "ready" && row.render !== "running" && row.upload !== "running")
}

export function deliveredMediaSlices(lifecycle?: WorkflowProductLifecycle): WorkflowImageLifecycle[] {
  const urls = new Set<string>()
  return [...(lifecycle?.images ?? [])].sort((a, b) => a.index - b.index).filter((image) => {
    if (image.phase !== "public_ready" || !image.public_url || urls.has(image.public_url)) return false
    urls.add(image.public_url)
    return true
  })
}

function draftUrls(draft: WorkflowCategoryDraft, key: string): string[] | undefined {
  const value = draft.values[key]
  if (value) {
    if (value.kind === "url_list" || value.kind === "text_list") return key === "primary_image" || key === "color_image" ? [] : value.value.map((url) => url.trim()).filter(Boolean)
    if (value.kind === "text" || value.kind === "url") return value.value.trim() ? [value.value.trim()] : []
    return []
  }
  return draft.cleared?.includes(key) ? [] : undefined
}

/** Mirror the core's manual-media precedence without changing its lifecycle verdict. */
export function selectedMediaState(lifecycle: WorkflowProductLifecycle | undefined, draft: WorkflowCategoryDraft | undefined, role: MediaRoleKey): MediaCellState {
  const state = mediaCellState(lifecycle, role)
  if (!draft || lifecycle?.media !== "ready") return state
  const images = draftUrls(draft, "images")
  const delivered = deliveredMediaSlices(lifecycle)
  const fallbackToFirstImage = role === "primary_image" || role === "color_image" && !delivered.some((image) => mediaRoleOf(image.group_name) === "color_image")
  const urls = draftUrls(draft, role) ?? (fallbackToFirstImage ? images?.slice(0, 1) : undefined)
  if (urls === undefined) return state
  return {
    ...state,
    urls,
    slices: urls.flatMap((url) => delivered.find((image) => image.public_url === url) ?? []),
    label: urls.length ? `${urls.length} 张 · 本行设置` : "未选图片",
    tone: urls.length ? state.tone : "bad",
  }
}

/** Only this row's confirmed deliveries can become a new manual selection. */
export function mediaSelectionValue(lifecycle: WorkflowProductLifecycle | undefined, role: SelectableMediaRole, urls: readonly string[]): WorkflowDraftValue {
  const available = new Set(deliveredMediaSlices(lifecycle).map((image) => image.public_url))
  if (!urls.length || role === "primary_image" && urls.length !== 1 || new Set(urls).size !== urls.length || urls.some((url) => !available.has(url))) {
    throw new Error("只能选择本行已交付的图片，至少保留一张")
  }
  return role === "primary_image" ? { kind: "text", value: urls[0]! } : { kind: "url_list", value: [...urls] }
}

/** Recheck the current row at the write action, after a picker may have gone stale. */
export function validateMediaSelection(row: ListingRow | undefined, product: WorkflowDraftView | undefined, role: SelectableMediaRole, value: WorkflowDraftValue | undefined): WorkflowDraftValue {
  if (!mediaSelectionOpen(row, product)) throw new Error("当前商品正在处理或发送结果待核对，不能修改图片")
  const urls = value?.kind === "url_list" || value?.kind === "text_list" ? value.value : value?.kind === "text" || value?.kind === "url" ? [value.value] : []
  const next = mediaSelectionValue(product!.lifecycle, role, urls)
  const images = selectedMediaState(product!.lifecycle, product!.draft, "images").urls
  const primary = draftUrls(product!.draft, "primary_image")?.[0]
  if (role === "primary_image" && !images.includes(urls[0]!)) throw new Error("主图必须是当前选用的商品图")
  if (role === "images" && primary && !urls.includes(primary)) throw new Error("请先选择其他主图，再移除此图片")
  return next
}
