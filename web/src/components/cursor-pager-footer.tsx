/**
 * Cursor 分页表尾（@/components 级共享件）：本页计数 + 上一页/下一页。
 * delegate 未履约发货单、委托单列表与 ops 发货屏的分页口径完全一致，
 * 统一渲染。
 */
import { ChevronLeft, ChevronRight } from "lucide-react"

import { Button } from "@/components/ui/button"

export function CursorPagerFooter({
  page,
  count,
  hasNext,
  cursor,
  busy,
  onPrevious,
  onNext,
}: {
  page: number
  count: number
  hasNext: boolean
  cursor: string
  busy: boolean
  onPrevious: () => void
  onNext: () => void
}) {
  return (
    <footer className="flex flex-wrap items-center justify-between gap-2 border-t border-border px-3 py-2 text-compact text-muted-foreground">
      <span className="font-mono tabular-nums">
        {`本页 ${count.toLocaleString()} 单`}
        {!hasNext && page > 1 ? " · 已到最后一页" : ""}
      </span>
      <nav aria-label="分页" className="flex items-center gap-1">
        <Button
          size="icon-sm"
          variant="ghost"
          disabled={page <= 1 || busy}
          aria-label="上一页"
          onClick={onPrevious}
        >
          <ChevronLeft />
        </Button>
        <span
          role="status"
          aria-live="polite"
          aria-label={`第 ${page} 页`}
          className="min-w-10 text-center font-mono tabular-nums"
        >
          {page}
        </span>
        <Button
          size="icon-sm"
          variant="ghost"
          disabled={!hasNext || !cursor || busy}
          aria-label="下一页"
          onClick={onNext}
        >
          <ChevronRight />
        </Button>
      </nav>
    </footer>
  )
}
