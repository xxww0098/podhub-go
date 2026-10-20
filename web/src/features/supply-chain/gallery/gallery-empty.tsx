/** Five next steps, five different doors out — never a bare "nothing here". */
import { PackageOpen, SearchX, Star } from "lucide-react"

import { Button } from "@/components/ui/button"
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty"

export function GalleryEmpty({
  kind,
  query,
  onClear,
}: {
  kind: "empty" | "zero" | "search" | "fav"
  query: string
  onClear: () => void
}) {
  const copy = {
    empty: {
      icon: <PackageOpen />,
      title: "平台还未上架货品",
      body: "货品上架后会出现在这里，库和类目也会跟着长出来。",
    },
    zero: {
      icon: <SearchX />,
      title: "没有符合筛选的货品",
      body: "试试其他库或价格区间，或清除筛选后再看。",
    },
    search: {
      icon: <SearchX />,
      title: `没有找到「${query}」相关的货品`,
      body: "换个词试试——可以搜名称、编号或标签，例如货品编号 P001。",
    },
    fav: {
      icon: <Star />,
      title: "还没有收藏的货品",
      body: "在卡片或详情页点星标收藏，方便回头比较；挑好的货加进上架清单可批量进入上架。",
    },
  }[kind]

  return (
    <Empty role="status" className="min-h-64" data-gallery-empty={kind}>
      <EmptyHeader>
        <EmptyMedia variant="icon">{copy.icon}</EmptyMedia>
        <EmptyTitle>{copy.title}</EmptyTitle>
        <EmptyDescription>{copy.body}</EmptyDescription>
      </EmptyHeader>
      {kind !== "empty" && kind !== "fav" ? (
        <EmptyContent>
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="cursor-pointer"
            onClick={onClear}
          >
            清空筛选
          </Button>
        </EmptyContent>
      ) : null}
    </Empty>
  )
}
