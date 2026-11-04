import { ArrowRight, Check, CircleAlert, RefreshCw, Tag } from "lucide-react"
import type { IntentReviewCounts } from "@/bindings/http-listing-intents"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { homeListingHeadline, reviewAttention } from "./home-model"
import type { ReviewKind } from "./recent-submissions-read"

/**
 * One 56px status bar replaces the old dashboard hero: the review count, its
 * groups and the action sit on one line, and nothing repeats the queue below.
 */
export function HomeStatusBar({ workspaceSelected, counts, overviewFailed, reviewFailed, onOpenQueue, onRetry }: {
  workspaceSelected: boolean
  counts?: IntentReviewCounts
  overviewFailed: boolean
  reviewFailed: boolean
  onOpenQueue: (kind: ReviewKind | "all") => void
  onRetry: () => void
}) {
  const attention = counts ? reviewAttention(counts) : []
  const needsReview = counts?.needs_review ?? 0
  return <section className={cn("flex min-h-14 flex-wrap items-center gap-x-3 gap-y-2 rounded-xl border px-3 py-2", needsReview ? "border-brand/20 bg-brand-soft text-brand-ink" : "border-border bg-card")} aria-label="上架核对状态">
    <div className="flex min-w-0 flex-1 basis-64 items-center gap-3">
      <span className={cn("flex size-7 shrink-0 items-center justify-center rounded-lg", needsReview ? "bg-brand/10 text-brand-ink" : "bg-muted text-muted-foreground")}>
        {!workspaceSelected ? <Tag className="size-4" aria-hidden />
          : overviewFailed || reviewFailed ? <CircleAlert className="size-4 text-st-bad" aria-hidden />
            : !counts ? <RefreshCw className="size-4 animate-spin" aria-hidden />
              : needsReview ? <CircleAlert className="size-4" aria-hidden />
                : <Check className="size-4" aria-hidden />}
      </span>
      <p className="min-w-0 flex-1 text-sm font-medium" role="status">
        {!workspaceSelected ? "选择工作空间后查看上架概况"
          : overviewFailed ? "上架概况读取失败"
            : reviewFailed ? "待核对结果读取失败"
              : !counts ? "正在读取待核对结果"
                : needsReview ? homeListingHeadline({ needsAction: needsReview, mayBeTruncated: false })
                  : "没有待核对的上架提交"}
      </p>
    </div>
    {/* The queue's own groups, so an entry never lands on an unfiltered list. */}
    <div className="flex flex-wrap items-center gap-2">
      {attention.map((item) => <button key={item.kind} type="button" onClick={() => onOpenQueue(item.kind)} className="inline-flex min-h-8 items-center gap-1.5 rounded-md bg-brand/10 px-2 text-xs text-brand-ink hover:bg-brand/15 focus-visible:outline-2 focus-visible:outline-ring">
        <span className={cn("size-1.5 rounded-full", item.tone === "unknown" ? "bg-st-unknown" : "bg-st-bad")} aria-hidden />
        {item.label}<span className="font-semibold tabular-nums">{item.count}</span>
      </button>)}
      {overviewFailed || reviewFailed
        ? <Button size="sm" variant="outline" onClick={onRetry}><RefreshCw aria-hidden />重试</Button>
        : needsReview ? <Button size="sm" variant="brand" onClick={() => onOpenQueue("all")}>核对这{needsReview}项<ArrowRight aria-hidden /></Button>
          : null}
    </div>
  </section>
}
