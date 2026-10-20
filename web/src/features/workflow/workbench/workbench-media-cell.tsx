import { useState } from "react"
import { ChevronDown, CircleAlert, Images, LoaderCircle } from "lucide-react"
import type { WorkflowProductLifecycle } from "@/bindings/commands"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { TONE_INK } from "@/lib/receipt-state"
import { cn } from "@/lib/utils"
import { SliceZoom, stepSlice } from "../media/rendered-image"
import {
  MEDIA_ROLE_LABEL,
  mediaCellState,
  type MediaRoleKey,
} from "../media/workflow-media-roles"
import { FieldSourceMarker, type FieldLayerView } from "./field-source-marker"
import { MediaDeliveryInspector } from "./media-delivery-inspector"
import { RetryGlyphButton } from "./preparation-step-glyph"

export function MediaRoleCell({
  draftId,
  role,
  lifecycle,
  sourceLayer,
  onRetryMedia,
}: {
  draftId: string
  role: MediaRoleKey
  lifecycle?: WorkflowProductLifecycle
  sourceLayer?: FieldLayerView
  onRetryMedia: () => void
}) {
  const state = mediaCellState(lifecycle, role)
  // ← / → walk the zoom across this cell's strip, so the open slice lives here
  // rather than in each chip.
  const [zoomAt, setZoomAt] = useState<number | null>(null)
  if (!state.slices.length) {
    return (
      <span
        className={cn(
          "flex min-w-0 items-center gap-1 text-compact",
          state.tone === "idle" ? "text-muted-foreground/60" : TONE_INK[state.tone],
        )}
      >
        {sourceLayer ? <FieldSourceMarker layer={sourceLayer} /> : null}
        <span className="truncate">{state.label}</span>
        {state.tone === "bad" ? (
          // The failure glyph itself is the retry, so the cell keeps its state
          // line and stops growing a second Chinese button beside it.
          <RetryGlyphButton
            label={`重试切片 ${MEDIA_ROLE_LABEL[role]}`}
            tooltip={`${state.label}，点击重试`}
            onRetry={onRetryMedia}
          >
            <CircleAlert aria-hidden />
          </RetryGlyphButton>
        ) : null}
      </span>
    )
  }

  const isUploaded = state.urls.length > 0
  const isUploading = state.tone === "flight"
  const isFailed = state.tone === "bad"
  const total = state.slices.length
  const zoomSlice = zoomAt === null ? undefined : state.slices[zoomAt]

  return (
    <div className="flex min-w-0 flex-col items-start gap-1 py-0.5">
      {/* A 20 px chip cannot show whether a slice is right, but it still paid
          for a full-resolution decode; eight per row across the mounted rows
          made scrolling stutter. The cell states the count and
          opens the zoom, which reads one slice on demand. */}
      <button
        type="button"
        onClick={(event) => {
          event.stopPropagation()
          setZoomAt(0)
        }}
        aria-label={`查看大图 ${MEDIA_ROLE_LABEL[role]}（${total} 张）`}
        className="-ml-1 inline-flex items-center gap-1 rounded-md px-1 py-0.5 text-compact text-foreground transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
      >
        {sourceLayer ? <FieldSourceMarker layer={sourceLayer} /> : null}
        <Images className="size-3 shrink-0 opacity-60" aria-hidden />
        <span className="font-medium tabular-nums">{total} 张</span>
      </button>
      {zoomSlice ? (
        <SliceZoom
          draftId={draftId}
          image={zoomSlice}
          onClose={() => setZoomAt(null)}
          strip={
            total > 1 && zoomAt !== null
              ? {
                  at: zoomAt,
                  total,
                  step: (delta) => setZoomAt((current) => stepSlice(current, delta, total)),
                }
              : undefined
          }
        />
      ) : null}
      {isUploading ? (
        // Flight wins over the delivered popover: a partial batch has URLs, and
        // painting it with the green「N 张已就绪」dot made a row stuck at
        // "7/8 上传中" read as finished. The delivered links are one 上传 away.
        <div className="flex items-center gap-1 text-meta font-medium text-st-flight-ink">
          <LoaderCircle className="size-3 shrink-0 animate-spin" />
          <span className="truncate">{state.label}</span>
        </div>
      ) : isUploaded || isFailed ? (
        // A failed slice keeps the inspector: that is where its 重试 lives, and
        // the delivered siblings are still worth copying.
        <Popover>
          <PopoverTrigger
            render={
              <button
                type="button"
                className="group -ml-1 inline-flex max-w-full items-center gap-1 rounded-md px-1 py-0.5 text-left text-meta font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                aria-label={
                  isFailed
                    ? `${MEDIA_ROLE_LABEL[role]}：${state.slices.length - state.urls.length} 张未交付，点击重试`
                    : `${MEDIA_ROLE_LABEL[role]}：${state.urls.length} 张已就绪，点击查看或复制公网链接`
                }
              >
                <span
                  className={cn(
                    "size-1.5 shrink-0 rounded-full",
                    isFailed ? "bg-destructive" : "bg-st-good-ink",
                  )}
                />
                <span className="truncate">{state.label}</span>
                <ChevronDown className="size-2.5 shrink-0 opacity-40 transition-transform group-hover:opacity-100 group-data-[state=open]:rotate-180" />
              </button>
            }
          />
          <PopoverContent
            align="start"
            side="bottom"
            sideOffset={4}
            className="w-80 max-w-[calc(100vw-24px)] p-0 shadow-overlay"
            aria-label={`${MEDIA_ROLE_LABEL[role]}公网交付详情`}
          >
            <MediaDeliveryInspector
              draftId={draftId}
              role={role}
              slices={state.slices}
              urls={state.urls}
              onRetryMedia={onRetryMedia}
            />
          </PopoverContent>
        </Popover>
      ) : isFailed ? (
        <div className="flex items-center gap-1 text-meta font-medium text-destructive">
          <CircleAlert className="size-3 shrink-0" />
          <span className="truncate">{state.label}</span>
        </div>
      ) : (
        <p className="text-meta text-muted-foreground">{state.label}</p>
      )}
    </div>
  )
}
