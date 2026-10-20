import { useEffect, useState } from "react"
import { createPortal } from "react-dom"
import { ChevronLeft, ChevronRight, X } from "lucide-react"
import type { WorkflowProductLifecycle } from "@/bindings/commands"
import { renderOpfs } from "@/bindings/render-opfs"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { useScreenActive } from "@/components/screen-pane"
import { formatBytes } from "@/lib/format"
import { notifyError } from "@/lib/notify"
import { cn } from "@/lib/utils"
import { createSlicePreviewScheduler, isSourcePreview } from "./slice-preview-scheduler"

// The controls that sit on the scrim or on the picture itself. A pale
// photograph and the recess well are the same value in light, so the plate is
// card white with a strong hairline, and it commits to ink under the pointer.
const OVERLAY_PLATE =
  "border-border-strong bg-card text-foreground hover:border-foreground hover:bg-foreground hover:text-background"

// The delivery inspector draws its list at 32 CSS px; the zoom fills the
// viewport. Both edges reach the OPFS worker now — a thumbnail is decoded
// and downscaled there and only its bytes cross back
// (`bindings/render-opfs.ts` `edge`).
const SLICE_THUMBNAIL_EDGE = 192
const SLICE_DETAIL_EDGE = 2_048

const slicePreviewScheduler = createSlicePreviewScheduler(
  async (request) => {
    if (isSourcePreview(request)) {
      const preview = await renderOpfs.workflowSourcePreview(request.handle, request.edge)
      return preview.data_url
    }
    const preview = await renderOpfs.workflowRenderedSlicePreview(
      request.draftId,
      request.fileName,
      request.edge,
    )
    return preview.data_url
  },
)

/**
 * listing-design.md §3.1.1: a delivered slice paints its Public Media URL.
 * Signed or authenticated origins never land in `image.public_url`.
 */
export function deliveredSlicePreview(
  image: WorkflowProductLifecycle["images"][number],
): string | undefined {
  const url = image.public_url?.trim()
  return url ? url : undefined
}

function slicePreviewKeyOf(image: WorkflowProductLifecycle["images"][number]): string {
  return `${image.index}:${image.content_hash}`
}

// Slice thumbnails for one Product Instance, keyed by `index:content_hash` so
// a re-render replaces its tile instead of showing a stale slice. Delivered
// slices use the Public Media URL on the first paint. Undelivered ones share
// one bounded OPFS scheduler; a missing local artifact leaves the tile on its
// phase label. Only the delivery inspector calls this, and only while its
// popover is open — the workbench table itself paints no slice thumbnails.
export function useSlicePreviews(
  draftId: string,
  images: WorkflowProductLifecycle["images"],
  enabled = true,
): Record<string, string> {
  const screenActive = useScreenActive()
  const [localPreviews, setLocalPreviews] = useState<Record<string, string>>({})
  const wanted = images
    .filter((image) => !deliveredSlicePreview(image))
    .map((image) => `${slicePreviewKeyOf(image)}:${image.file_name}`)
    .join(",")

  useEffect(() => {
    const pending = images.filter((image) => !deliveredSlicePreview(image))
    if (!draftId || !wanted) {
      setLocalPreviews((current) => (Object.keys(current).length ? {} : current))
      return
    }
    // ScreenPane keeps inactive modules mounted. Leaving the module withdraws
    // its queued subscriptions; already loaded thumbnails remain ready for the
    // next activation.
    if (!screenActive) return
    // Off-viewport rows must not occupy the scheduler's slots or hold blob URLs.
    // The process LRU still serves a scroll-back without another decode.
    if (!enabled) {
      setLocalPreviews((current) => (Object.keys(current).length ? {} : current))
      return
    }
    let cancelled = false
    const jobs = pending.map((image) => ({
      key: slicePreviewKeyOf(image),
      request: {
        draftId,
        index: image.index,
        contentHash: image.content_hash,
        fileName: image.file_name,
        edge: SLICE_THUMBNAIL_EDGE,
        priority: "background" as const,
      },
    }))
    setLocalPreviews((current) => {
      const next = Object.fromEntries(
        jobs.flatMap(({ key, request }) => {
          const cached = current[key] ?? slicePreviewScheduler.peek(request)
          return cached ? [[key, cached]] : []
        }),
      )
      const same =
        Object.keys(next).length === Object.keys(current).length
        && Object.keys(next).every((key) => next[key] === current[key])
      return same ? current : next
    })

    const subscriptions = jobs.map(({ key, request }) => {
      const subscription = slicePreviewScheduler.request(request)
      void subscription.promise.then(
        (preview) => {
          if (!cancelled && preview) {
            setLocalPreviews((current) =>
              current[key] === preview ? current : { ...current, [key]: preview },
            )
          }
        },
        () => {
          // Thumbnails are best-effort evidence; the pipeline never depends on
          // them, and a slice whose local artifact is gone keeps its label.
        },
      )
      return subscription
    })
    return () => {
      cancelled = true
      subscriptions.forEach((subscription) => subscription.cancel())
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draftId, screenActive, enabled, wanted])

  const previews: Record<string, string> = { ...localPreviews }
  for (const image of images) {
    const delivered = deliveredSlicePreview(image)
    if (delivered) previews[slicePreviewKeyOf(image)] = delivered
  }
  return previews
}

export function useSourcePreview(handle: string | undefined, enabled: boolean): string | undefined {
  const screenActive = useScreenActive()
  const [preview, setPreview] = useState<string>()

  useEffect(() => {
    if (!handle) {
      setPreview(undefined)
      return
    }
    if (!screenActive) return
    if (!enabled) {
      setPreview(undefined)
      return
    }
    const request = { kind: "source" as const, handle, edge: SLICE_THUMBNAIL_EDGE, priority: "background" as const }
    const cached = slicePreviewScheduler.peek(request)
    if (cached) {
      setPreview(cached)
      return
    }
    let cancelled = false
    const subscription = slicePreviewScheduler.request(request)
    void subscription.promise.then(
      (value) => {
        if (!cancelled && value) setPreview(value)
      },
      () => {
        // Source thumbnails are best-effort; the opaque handle still drives the pipeline.
      },
    )
    return () => {
      cancelled = true
      subscription.cancel()
    }
  }, [handle, screenActive, enabled])

  return preview
}

export function formatFileSize(bytes?: number): string {
  if (bytes === undefined || !Number.isFinite(bytes) || bytes <= 0) return ""
  return formatBytes(bytes)
}

// ← / → wrap around the strip, so the last slice steps back to the first.
export function stepSlice(current: number | null, delta: number, total: number): number | null {
  if (current === null || total < 1) return current
  return (((current + delta) % total) + total) % total
}

/**
 * The large view of one slice, mounted only while it is open.
 *
 * The workbench table does not paint slice thumbnails: a 20 px chip still
 * costs a full-resolution JPEG decode, and eight of them per row times the
 * mounted rows saturated a modest CPU on every scroll.
 * The media cell hands the operator a count that opens this, and the picture
 * is read here — one slice, on demand, at interactive priority.
 *
 * Src selection follows `docs/listing-design.md` §3.1.1: the Public Media URL
 * after delivery, the local OPFS render before it.
 */
export function SliceZoom({
  draftId,
  image,
  onClose,
  strip,
}: {
  draftId: string
  image: WorkflowProductLifecycle["images"][number]
  onClose: () => void
  // Present when this slice sits in a walkable strip: the zoom then carries
  // its position and the two step controls.
  strip?: { at: number, total: number, step: (delta: number) => void }
}) {
  const publicSrc = deliveredSlicePreview(image)
  const [localSrc, setLocalSrc] = useState<string>()
  const [failed, setFailed] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const [byteSize, setByteSize] = useState<number | undefined>(image.byte_size)
  const src = publicSrc ?? localSrc

  useEffect(() => {
    setByteSize(image.byte_size)
  }, [image.byte_size])

  useEffect(() => {
    if (publicSrc) return
    setLocalSrc(undefined)
    setFailed(false)
    let cancelled = false
    // Interactive previews are never cached: this effect owns the URL it
    // receives and revokes it on cleanup — or immediately if the delivery
    // lands after this slice was already left behind.
    let owned: string | undefined
    const subscription = slicePreviewScheduler.request({
      draftId,
      index: image.index,
      contentHash: image.content_hash,
      fileName: image.file_name,
      edge: SLICE_DETAIL_EDGE,
      priority: "interactive",
    })
    void subscription.promise.then(
      (preview) => {
        if (cancelled) {
          if (preview) URL.revokeObjectURL(preview)
          return
        }
        if (preview) {
          owned = preview
          setLocalSrc(preview)
          return
        }
        setFailed(true)
        notifyError("切片加载失败，请重试。", { id: "slice-zoom-load" })
      },
      () => {
        if (cancelled) return
        setFailed(true)
        notifyError("切片加载失败，请重试。", { id: "slice-zoom-load" })
      },
    )
    return () => {
      cancelled = true
      subscription.cancel()
      if (owned) URL.revokeObjectURL(owned)
    }
  }, [attempt, draftId, image.content_hash, image.file_name, image.index, publicSrc])

  // The scheduler hands back the object URL only; a local slice that never
  // reached delivery still has to name its own weight under the picture.
  useEffect(() => {
    if (publicSrc || byteSize !== undefined) return
    let cancelled = false
    void renderOpfs.workflowRenderedSlicePreview(draftId, image.file_name).then(
      (preview) => {
        // Only the byte size is wanted here; the preview URL was created just
        // for this read, and nothing else owns it.
        if (preview?.data_url) URL.revokeObjectURL(preview.data_url)
        if (!cancelled && preview?.byte_size) setByteSize(preview.byte_size)
      },
      () => {
        // best effort
      },
    )
    return () => {
      cancelled = true
    }
  }, [byteSize, draftId, image.file_name, publicSrc])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose()
        return
      }
      if (!strip || (event.key !== "ArrowLeft" && event.key !== "ArrowRight")) return
      event.preventDefault()
      strip.step(event.key === "ArrowLeft" ? -1 : 1)
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [onClose, strip])

  const dialog = (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`大图预览 ${image.file_name}`}
      className="fixed inset-0 z-[310] grid place-items-center bg-foreground/35 p-4 backdrop-blur-[1px] sm:p-8"
      onClick={onClose}
    >
      <div
        className="flex max-w-full items-center gap-2 sm:gap-3"
        onClick={(event) => event.stopPropagation()}
      >
        {/* The walk controls stand outside the frame, never on the picture:
            this dialog exists to show the slice, and chrome laid over it is
            chrome judged against artwork nobody has seen yet. */}
        {strip ? (
          <Button
            type="button"
            size="icon"
            variant="outline"
            className={cn("shrink-0", OVERLAY_PLATE)}
            onClick={() => strip.step(-1)}
            aria-label="上一张"
            title="上一张（←）"
          >
            <ChevronLeft aria-hidden />
          </Button>
        ) : null}
        <div className="relative flex max-h-[92vh] min-w-0 flex-col rounded-xl border border-border bg-card p-2 shadow-overlay">
          <Button
            type="button"
            size="icon-sm"
            variant="outline"
            className={cn("absolute right-3 top-3 z-10", OVERLAY_PLATE)}
            onClick={onClose}
            aria-label="关闭大图预览"
            autoFocus={!strip}
          >
            <X aria-hidden />
          </Button>
          <div
            className="relative grid min-h-48 min-w-48 place-items-center overflow-hidden rounded-lg bg-muted"
            aria-busy={!src && !failed}
          >
            {src ? (
              <img
                src={src}
                alt={`${image.file_name} 预览`}
                decoding="async"
                className="h-auto max-h-[82vh] w-auto max-w-[calc(90vw-10rem)] object-contain"
              />
            ) : failed ? (
              <Button
                type="button"
                size="xs"
                variant="outline"
                onClick={() => setAttempt((current) => current + 1)}
              >
                重试
              </Button>
            ) : (
              <span role="status" className="inline-flex items-center gap-2 px-3 py-2 text-compact text-muted-foreground">
                <Spinner className="size-3.5" />
                正在加载切片…
              </span>
            )}
          </div>
          <div className="flex min-w-0 items-center justify-between gap-4 px-1 pt-2 text-left text-meta text-muted-foreground">
            <div className="flex min-w-0 items-center gap-2">
              {strip ? (
                <span
                  className="shrink-0 font-mono font-medium tabular-nums text-foreground"
                  aria-label={`第 ${strip.at + 1} 张，共 ${strip.total} 张`}
                >
                  {strip.at + 1}/{strip.total}
                </span>
              ) : null}
              <p className="truncate font-mono" title={image.file_name}>{image.file_name}</p>
            </div>
            <p className="shrink-0 font-mono tabular-nums">
              {image.width} × {image.height}
              {byteSize ? ` · ${formatFileSize(byteSize)}` : ""}
            </p>
          </div>
        </div>
        {strip ? (
          <Button
            type="button"
            size="icon"
            variant="outline"
            className={cn("shrink-0", OVERLAY_PLATE)}
            onClick={() => strip.step(1)}
            aria-label="下一张"
            title="下一张（→）"
            autoFocus
          >
            <ChevronRight aria-hidden />
          </Button>
        ) : null}
      </div>
    </div>
  )

  // The dialog is `fixed`, but it is opened from a workbench table cell whose
  // sticky rows and columns carry their own z-index; painted in place it lands
  // under them. Portal it to the body so it escapes that stacking context.
  return typeof document === "undefined" ? dialog : createPortal(dialog, document.body)
}
