/**
 * 货盘卡片：海报在上、事实在下。
 *
 * 卡片是被 1px 边线圈住的一个商品对象，海报通栏贴到圆角里；暂不可上架
 * 不给海报加蒙版或降透明——状态只由徽标说，画作保持原色，选品时还看得清。
 * 加入清单用品牌色边线 + 1px 外描边表示；悬停只加深边线，不抬升卡片。
 * 海报上不压任何角标：清单动作在卡里（价格同一行），收藏是底行右端的一枚
 * 静音图标——选品时看清画，比在画上摆两个白片按钮重要。
 * 正文五行：价格与清单动作、名称、类目·规格（单行截断）、状态徽标、运费·交期+收藏。
 */
import { Check, Heart, Image, Plus } from "lucide-react"

import type { SellerSupplierDbRowData } from "@/bindings/http-supplier-dbs-catalog"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { IconButton } from "@/components/ui/icon-button"
import { cn } from "@/lib/utils"

import { LISTABILITY_BADGE } from "../listability-copy"
import { formatCny, leadTimeLabel, listabilityOf } from "./gallery-model"
import { useGalleryCollection } from "./listing-queue"
import { marketImageSrc } from "./market-image"

export function GalleryCard({
  row,
  categoryLabel,
  onOpen,
  variantCount = 1,
}: {
  row: SellerSupplierDbRowData
  categoryLabel: string
  onOpen: (row: SellerSupplierDbRowData) => void
  variantCount?: number
}) {
  const cover = row.gallery[0]
  const coverUrl = cover?.url || row.productVideos.find((video) => video.coverUrl)?.coverUrl
  const { queue, queueIds, favoriteIds, toggleQueued, toggleFavorite } = useGalleryCollection()
  const queued = queueIds.has(row.productId)
  const variantGroup = row.variantGroup?.trim()
  const groupQueued = queued || (variantCount > 1 && Boolean(variantGroup) && queue.some((entry) =>
    entry.sourceId === row.sourceId && entry.variantGroup === variantGroup,
  ))
  const favorited = favoriteIds.has(row.productId)
  const listability = listabilityOf(row)
  const shipping = row.shippingCostCents === undefined ? "运费待定" : `运费 ${formatCny(row.shippingCostCents ?? 0)}`
  const specification = variantCount > 1 ? `${variantCount} 个规格` : row.size
  const subtitle = [categoryLabel || "未分类", specification].filter(Boolean).join(" · ")

  return (
    <article
      data-gallery-product={row.productId}
      className={cn(
        "group/gallery-card flex min-w-0 flex-1 flex-col overflow-hidden rounded-xl border border-border bg-card transition-colors hover:border-border-strong",
        groupQueued && "border-brand shadow-[0_0_0_1px_var(--brand)]",
      )}
    >
      <div className="relative aspect-[4/5] overflow-hidden bg-muted/40">
        <button
          type="button"
          aria-label={`查看 ${row.title} 的商品详情`}
          className="block size-full cursor-pointer outline-none focus-visible:outline-2 focus-visible:-outline-offset-4 focus-visible:outline-ring"
          onClick={() => onOpen(row)}
        >
          {coverUrl ? (
            <img
              src={marketImageSrc(coverUrl, 640)}
              alt=""
              width={cover?.w || undefined}
              height={cover?.h || undefined}
              loading="lazy"
              decoding="async"
              className="size-full object-contain"
            />
          ) : (
            <span className="flex size-full flex-col items-center justify-center gap-2 text-muted-foreground" data-gallery-cover="none">
              <Image className="size-10" aria-hidden />
              <span className="text-sm">暂无图片</span>
            </span>
          )}
        </button>
      </div>
      <div className="flex flex-1 flex-col gap-1 px-2.5 pt-2 pb-2.5">
        <div className="flex flex-wrap items-center justify-between gap-x-1 gap-y-1.5">
          <span className="text-xl leading-none font-semibold tracking-tight text-card-foreground tabular-nums" aria-label={`平台价 ${formatCny(row.platformPriceCents)}`}>
            {formatCny(row.platformPriceCents)}
          </span>
          <Button
            type="button"
            variant={groupQueued ? "ghost" : "link"}
            size="xs"
            aria-label={variantCount > 1
              ? groupQueued ? `查看已选规格 ${row.title}` : `选择规格后加入上架清单 ${row.title}`
              : queued ? `移出上架清单 ${row.title}` : `加入上架清单 ${row.title}`}
            aria-pressed={variantCount > 1 ? undefined : queued}
            data-gallery-queue=""
            onClick={() => {
              if (variantCount > 1) onOpen(row)
              else toggleQueued(row)
            }}
          >
            {groupQueued ? <Check aria-hidden /> : <Plus aria-hidden />}
            {variantCount > 1 ? groupQueued ? "已选规格" : "选规格" : queued ? "已加入" : "加入清单"}
          </Button>
        </div>
        <h3 className="line-clamp-2 min-w-0 text-lg leading-snug font-semibold text-balance text-card-foreground" title={row.title}>
          {row.title}
        </h3>
        <p className="truncate text-compact leading-snug text-muted-foreground" title={subtitle}>
          {subtitle}
        </p>
        <div className="mt-auto flex min-w-0 flex-col items-start gap-1.5 pt-1">
          {!listability.listable ? (
            <Badge variant="secondary" data-gallery-listability="">
              {LISTABILITY_BADGE[listability.class]}
            </Badge>
          ) : null}
          <div className="flex min-w-0 w-full items-center justify-between gap-2">
            <p className="text-compact leading-relaxed text-muted-foreground">
              <span aria-label={shipping}>{shipping}</span>
              <span className="px-1.5" aria-hidden>·</span>
              <span>{leadTimeLabel(row.leadTime)}</span>
            </p>
            <IconButton
              icon={Heart}
              iconClassName={cn(favorited && "fill-current")}
              label={favorited ? `取消收藏 ${row.title}` : `收藏 ${row.title}`}
              tip={favorited ? "取消收藏" : "收藏"}
              size="icon"
              tooltipSide="top"
              aria-pressed={favorited}
              data-gallery-favorite=""
              className={cn("-mr-1.5", favorited && "text-foreground")}
              onClick={() => toggleFavorite(row.productId)}
            />
          </div>
        </div>
      </div>
    </article>
  )
}
