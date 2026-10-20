import type {
  WorkflowImageLifecycle,
  WorkflowProductLifecycle,
} from "@/bindings/commands"
import type { StateTone } from "@/lib/receipt-state"

/**
 * The four Seller media roles are item-level fields of the Ozon import payload,
 * not category attributes, and their only authority is the PSD top-level group a
 * slice was exported from. Cloud writes them into the Listing Draft in
 * `sync_system_image_media` after a delivery succeeds; the renderer re-derives
 * the same split from `lifecycle.images[].group_name` so a workbench cell never
 * needs a second round trip to read what a row's slices became.
 */
export type MediaRoleKey = "images" | "images360" | "primary_image" | "color_image"

export const MEDIA_ROLE_LABEL: Record<MediaRoleKey, string> = {
  images: "商品图片",
  images360: "360° 图片",
  primary_image: "主图",
  color_image: "颜色样本",
}

/**
 * Mirror of Rust `media_role_of` (`workflow/lifecycle/mod.rs`): case-insensitive
 * substring match on the PSD group name, and `360` wins so one slice can never
 * be counted under two roles. Any drift here shows up as a workbench cell that
 * disagrees with the payload Cloud actually composed.
 */
export function mediaRoleOf(
  groupName: string,
): "images360" | "color_image" | undefined {
  const group = groupName.toLowerCase()
  if (group.includes("360")) return "images360"
  if (group.includes("color") || group.includes("颜色")) return "color_image"
  return undefined
}

/** Slices that belong to one role, in render order. */
export function slicesForRole(
  images: readonly WorkflowImageLifecycle[],
  role: MediaRoleKey,
): WorkflowImageLifecycle[] {
  // Lifecycle storage is not an ordering contract. The renderer-assigned index
  // is: index 0 is the `-1` slice and therefore the primary image. Normalize at
  // the shared projection seam so every media column and URL list agrees.
  const ordered = [...images].sort((left, right) => left.index - right.index)
  switch (role) {
    case "images":
      // `images` is the full set on purpose: the role does not exclude the 360
      // or colour slices from it either.
      return ordered
    case "primary_image":
      return ordered.slice(0, 1)
    case "color_image": {
      // Both seams name one swatch by group name and fall back to the set's
      // first slice: `system_image_media_values` writes the Draft field and
      // `lifecycle_media` composes the payload. The column carries a single
      // slice for the same reason the payload carries a single URL — listing
      // every colour slice would promise more than the payload ever sends.
      const claimed = ordered.filter(
        (image) => mediaRoleOf(image.group_name) === "color_image",
      )
      return (claimed.length ? claimed : ordered).slice(0, 1)
    }
    case "images360":
      return ordered.filter((image) => mediaRoleOf(image.group_name) === "images360")
  }
}

export type MediaCellState = {
  slices: WorkflowImageLifecycle[]
  urls: string[]
  /** Short status line shown when the role has no delivered URL yet. */
  label: string
  tone: StateTone
}

/**
 * One media column for one row. The state vocabulary is the lifecycle's, never a
 * renderer guess. Current phase and completion counts come from Cloud; residual
 * images never imply current readiness. A blank `group_name` means the record
 * predates role persistence and cannot be attributed without a re-render.
 */
export function mediaCellState(
  lifecycle: WorkflowProductLifecycle | undefined,
  role: MediaRoleKey,
): MediaCellState {
  if (!lifecycle || lifecycle.media === "pending") {
    return { slices: [], urls: [], label: "未切片", tone: "idle" }
  }
  if (lifecycle.media === "rendering") {
    return { slices: [], urls: [], label: "切片中", tone: "flight" }
  }
  if (lifecycle.media === "failed" && lifecycle.media_failure_stage !== "upload") {
    return { slices: [], urls: [], label: lifecycle.media_failure_stage === "render" ? "切片失败" : "媒体失败", tone: "bad" }
  }
  const images = lifecycle.images
  if (!images.length) {
    return { slices: [], urls: [], label: "未切片", tone: "idle" }
  }
  // Only 360° can be unattributable. It has no fallback, so a record written
  // before group names were persisted would render the same empty cell as a PSD
  // that genuinely has no 360° group. `color_image` deliberately stays out:
  // without a colour group the first slice is the fallback, so the cell
  // showing that slice *is* the URL the Draft and the payload carry, and
  // warning here would hide a value that was never in doubt.
  const roleUnknown =
    role === "images360" &&
    images.every((image) => !image.group_name.trim())
  if (roleUnknown) {
    return { slices: [], urls: [], label: "组名缺失 · 需重新切片", tone: "unknown" }
  }
  const slices = slicesForRole(images, role)
  if (!slices.length) {
    // 360° is the only role that can come up empty on a sliced row: the other
    // three are either the full set or a fallback onto its first slice.
    return { slices, urls: [], label: "无 360° 切片", tone: "idle" }
  }
  const urls = slices.flatMap((image) =>
    image.phase === "public_ready" && image.public_url ? [image.public_url] : [],
  )
  if (lifecycle.media === "failed") {
    return { slices, urls, label: `${lifecycle.image_completed}/${lifecycle.image_total} 上传失败`, tone: "bad" }
  }
  if (lifecycle.media === "uploading" && role === "images") {
    return { slices, urls, label: `${lifecycle.image_completed}/${lifecycle.image_total} 上传中`, tone: "flight" }
  }
  const failed = slices.filter((image) => image.phase === "failed")
  if (failed.length) {
    return {
      slices,
      urls,
      label: "切片上传未完成 · 请查看媒体步骤并重试上传",
      tone: "bad",
    }
  }
  if (slices.some((image) => image.phase === "uploading")) {
    return {
      slices,
      urls,
      label: `${urls.length}/${slices.length} 上传中`,
      tone: "flight",
    }
  }
  if (urls.length === slices.length) {
    return { slices, urls, label: `${urls.length} 张 · 公网可读`, tone: "good" }
  }
  return {
    slices,
    urls,
    label: `${slices.length} 切片 · 未上传`,
    tone: "idle",
  }
}
