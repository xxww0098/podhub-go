/**
 * 画廊分页 — 右下角极简翻页（参考图 1）：‹ 1 ›，总数由标题行的
 * 「N 件商品」承担，这里只留页码。
 */
import { ChevronLeft, ChevronRight } from "lucide-react"

import { Button } from "@/components/ui/button"

import { pageNumbers } from "./gallery-model"

export function GalleryPager({
  page,
  pages,
  onPage,
}: {
  page: number
  pages: number
  onPage: (page: number) => void
}) {
  return (
    <nav
      aria-label="分页"
      data-gallery-pager=""
      className="flex items-center justify-end gap-1"
    >
      <Button
        type="button"
        size="icon-xs"
        variant="outline"
        className="cursor-pointer"
        aria-label="上一页"
        disabled={page <= 1}
        onClick={() => onPage(page - 1)}
      >
        <ChevronLeft />
      </Button>
      {pageNumbers(page, pages).map((item, index) =>
        item === "ellipsis" ? (
          <span key={"e-" + index} className="px-1 text-muted-foreground">
            …
          </span>
        ) : (
          <Button
            key={item}
            type="button"
            size="xs"
            variant={item === page ? "default" : "outline"}
            className="cursor-pointer"
            aria-current={item === page ? "page" : undefined}
            onClick={() => onPage(item)}
          >
            {item}
          </Button>
        ),
      )}
      <Button
        type="button"
        size="icon-xs"
        variant="outline"
        className="cursor-pointer"
        aria-label="下一页"
        disabled={page >= pages}
        onClick={() => onPage(page + 1)}
      >
        <ChevronRight />
      </Button>
    </nav>
  )
}
