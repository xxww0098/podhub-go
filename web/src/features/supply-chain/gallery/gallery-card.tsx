/**
 * 画廊卡片 — the seller compares listings, not rows. 4:3 cover (lazy, fixed
 * ratio so the wall never shifts) with an always-on 收藏 heart chip; 名称,
 * 平台货源/类目 badges, 平台价 + 交期发货, and the card's two actions:
 * 查看详情 opens the read-only page, 加入清单 stashes the local pick
 * （多规格行先进详情页选规格——规格即提示词绑定）.
 * 零售价/划线价（平台）/固定 tags/上架入口都在详情页里，卡面只留比较用的
 * 最少事实（参考图 1）。
 *
 * Hover is decorative only (lift + cover zoom, 150ms, off under
 * prefers-reduced-motion): every action is reachable without hover, so touch
 * loses nothing.
 */
import { Check, Heart, Image, ListPlus } from "lucide-react"

import type { SellerSupplierDbRowData } from "@/bindings/http-supplier-dbs-catalog"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

import { LISTABILITY_BADGE } from "../listability-copy"
import {
  formatCny,
  leadTimeLabel,
  listabilityOf,
  type GalleryDensity,
} from "./gallery-model"
import { marketImageSrc } from "./market-image"
import { useGalleryCollection } from "./listing-queue"

/** 密度档的卡面尺度：列宽之外，留白/字级/信息量也一起变，否则三档看起来一个样。 */
const DENSITY_CARD: Record<
  GalleryDensity,
  {
    /** 正文容器：留白与行距随密度收紧或放松。 */
    body: string
    title: string
    /** 大图档多一行标题，宽卡才不显空。 */
    titleClamp: string
    price: string
    meta: string
    /** 紧凑档只留比较骨架（封面/名称/价/动作），徽标让位给密度。 */
    showMeta: boolean
    actionSize: "xs" | "sm"
  }
> = {
  compact: {
    body: "gap-1.5 p-2.5",
    title: "text-xs font-semibold leading-snug",
    titleClamp: "line-clamp-2",
    price: "text-[15px]",
    meta: "text-meta",
    showMeta: false,
    actionSize: "xs",
  },
  standard: {
    body: "gap-2 p-3",
    title: "text-sm font-semibold leading-snug",
    titleClamp: "line-clamp-2",
    price: "text-lg",
    meta: "text-xs",
    showMeta: true,
    actionSize: "sm",
  },
  large: {
    body: "gap-2.5 p-3.5",
    title: "text-base font-semibold leading-snug",
    titleClamp: "line-clamp-3",
    price: "text-xl",
    meta: "text-sm",
    showMeta: true,
    actionSize: "sm",
  },
}

export function GalleryCard({
  row,
  density,
  dbLabel,
  categoryLabel,
  onOpen,
  variantCount = 1,
}: {
  row: SellerSupplierDbRowData
  density: GalleryDensity
  /** 平台货源徽标（按行 sourceId 解出的库名）。 */
  dbLabel: string
  /** 类目徽标——类目树未到场时为空，不渲染。 */
  categoryLabel: string
  onOpen: (row: SellerSupplierDbRowData) => void
  variantCount?: number
}) {
  const cover = row.gallery[0]
  const scale = DENSITY_CARD[density]
  const {
    queueIds,
    favoriteIds,
    toggleQueued,
    toggleFavorite,
  } = useGalleryCollection()
  const queued = queueIds.has(row.productId)
  const favorited = favoriteIds.has(row.productId)
  // 前置门：暂不可上架的行整卡置灰 + 状态徽标；收藏与清单草稿不受影响
  // （清单是本机挑货草稿，行恢复可上架后下一次批量导入照常带上）。
  const listability = listabilityOf(row)
  const blocked = !listability.listable

  return (
    <li
      data-gallery-card={row.productId}
      className={cn(
        // relative anchors the title button's stretched hit area, so the whole
        // card opens the peek without nesting interactive children in <button>.
        "group relative flex min-w-0 flex-col overflow-hidden rounded-xl border border-border/80 bg-card",
        "transition-all duration-200 ease-settle",
        "hover:-translate-y-1 hover:border-border-strong hover:shadow-overlay",
        "motion-reduce:transition-none motion-reduce:hover:translate-y-0",
        blocked && "opacity-60",
      )}
    >
      <div className="relative aspect-[4/3] w-full overflow-hidden border-b border-border/40 bg-muted/60">
        {blocked ? (
          <Badge
            variant="secondary"
            className="absolute bottom-1.5 left-1.5 z-10"
            data-gallery-card-listability=""
          >
            {LISTABILITY_BADGE[listability.class]}
          </Badge>
        ) : null}
        {/* 收藏白片钮常驻封面右上——挑货时不用先把鼠标探进卡里找它。 */}
        <button
          type="button"
          aria-label={favorited ? `取消收藏 ${row.title}` : `收藏 ${row.title}`}
          aria-pressed={favorited}
          data-gallery-card-favorite=""
          className={cn(
            "absolute top-2 right-2 z-10 grid size-7 cursor-pointer place-items-center rounded-full border border-border/50 bg-card/95 shadow-overlay transition-all duration-150 active:scale-90 hover:scale-110",
            favorited
              ? "text-st-attest-ink"
              : "text-foreground/60 hover:text-st-attest-ink",
          )}
          onClick={(event) => {
            event.stopPropagation()
            toggleFavorite(row.productId)
          }}
        >
          <Heart
            className={cn("size-4", favorited && "fill-current")}
            aria-hidden
          />
        </button>
        {cover ? (
          <img
            src={marketImageSrc(cover.url, 640)}
            alt=""
            width={cover.w || undefined}
            height={cover.h || undefined}
            loading="lazy"
            decoding="async"
            className={cn(
              "size-full bg-muted object-cover",
              "transition-transform duration-300 ease-settle group-hover:scale-[1.04]",
              "motion-reduce:transition-none motion-reduce:group-hover:scale-100",
            )}
          />
        ) : (
          <div
            className="flex size-full flex-col items-center justify-center gap-1.5 bg-muted/30 text-muted-foreground/60"
            data-gallery-cover="none"
            aria-label="暂无图片"
          >
            <Image className="size-6 stroke-[1.5]" aria-hidden />
          </div>
        )}
      </div>

      <div className={cn("flex min-w-0 flex-1 flex-col", scale.body)}>
        <h3 className={cn("min-w-0 tracking-tight text-foreground", scale.title)}>
          <button
            type="button"
            className={cn(
              "cursor-pointer text-left after:absolute after:inset-0 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring transition-colors group-hover:text-brand-ink",
              scale.titleClamp,
            )}
            onClick={() => onOpen(row)}
          >
            {row.title}
          </button>
        </h3>

        {scale.showMeta ? (
          <div className="flex min-w-0 items-center gap-1">
            <Badge variant="brand" className="max-w-3/5">
              <span className="min-w-0 truncate">{dbLabel}</span>
            </Badge>
            {categoryLabel ? (
              <Badge variant="secondary" className="max-w-2/5">
                <span className="min-w-0 truncate">{categoryLabel}</span>
              </Badge>
            ) : null}
            {variantCount > 1 ? (
              <Badge variant="outline">{variantCount} 个规格</Badge>
            ) : null}
          </div>
        ) : null}

        <div className="mt-auto flex min-w-0 items-baseline justify-between gap-x-2">
          <span
            className={cn(
              "font-mono font-bold tabular-nums text-destructive tracking-tight",
              scale.price,
            )}
          >
            {formatCny(row.platformPriceCents)}
          </span>
          <span
            className={cn(
              "min-w-0 truncate text-muted-foreground/85",
              scale.meta,
            )}
          >
            {leadTimeLabel(row.leadTime)}
          </span>
        </div>

        {/* 主动作带盖在 stretched-link 之上：查看详情同整卡点击，清单钮单/多规格分流。 */}
        <div className="relative z-10 grid grid-cols-2 gap-2 pt-1">
          <Button
            type="button"
            variant="outline"
            size={scale.actionSize}
            className="min-w-0"
            onClick={() => onOpen(row)}
          >
            查看详情
          </Button>
          <Button
            type="button"
            variant={queued ? "secondary" : "brand"}
            size={scale.actionSize}
            className="min-w-0"
            aria-label={
              variantCount > 1
                ? `选择规格后加入上架清单 ${row.title}`
                : queued
                  ? `移出上架清单 ${row.title}`
                  : `加入上架清单 ${row.title}`
            }
            aria-pressed={queued}
            data-gallery-card-queue=""
            onClick={() => {
              if (variantCount > 1) onOpen(row)
              else toggleQueued(row)
            }}
          >
            {queued ? (
              <Check aria-hidden className="stroke-[2.5]" />
            ) : (
              <ListPlus aria-hidden />
            )}
            {queued ? "移出清单" : "加入清单"}
          </Button>
        </div>
      </div>
    </li>
  )
}

export function GalleryCardWall({
  rows,
  density,
  dbLabel,
  categoryLabel,
  onOpen,
  variantCount,
}: {
  rows: SellerSupplierDbRowData[]
  density: GalleryDensity
  /** 平台货源徽标文案（按行的库解析名称）。 */
  dbLabel: (row: SellerSupplierDbRowData) => string
  /** 类目徽标文案（按行的类目坐标经类目树解析；空串不渲染）。 */
  categoryLabel: (row: SellerSupplierDbRowData) => string
  onOpen: (row: SellerSupplierDbRowData) => void
  variantCount?: (row: SellerSupplierDbRowData) => number
}) {
  let gridClass = "grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4"
  if (density === "compact") gridClass = "grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6"
  if (density === "large") gridClass = "grid-cols-1 gap-4 sm:grid-cols-2 2xl:grid-cols-3"
  return (
    <ul
      data-gallery-wall=""
      data-gallery-density={density}
      className={cn(
        "grid min-w-0",
        gridClass,
      )}
    >
      {rows.map((row) => (
        <GalleryCard
          key={row.productId}
          row={row}
          density={density}
          dbLabel={dbLabel(row)}
          categoryLabel={categoryLabel(row)}
          onOpen={onOpen}
          variantCount={variantCount?.(row)}
        />
      ))}
    </ul>
  )
}
