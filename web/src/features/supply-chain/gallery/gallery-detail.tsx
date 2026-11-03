import { useEffect, useRef, useState } from "react"
import {
  ArrowRight,
  Check,
  ChevronLeft,
  ChevronRight,
  Heart,
  Image,
  ListPlus,
  Play,
} from "lucide-react"

import type {
  SellerSupplierDbRowData,
  SupplierDbPropDefData,
} from "@/bindings/http-supplier-dbs-catalog"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { IconButton } from "@/components/ui/icon-button"
import { cn } from "@/lib/utils"

import { listabilityExplanation } from "../listability-copy"
import { formatCny, leadTimeLabel, listabilityOf, propValueText } from "./gallery-model"
import { useGalleryCollection } from "./listing-queue"
import { marketImageSrc } from "./market-image"

export function GalleryDetail({
  row,
  variantRows = [row],
  propDefs,
  categoryLabel,
  typeLabel,
  onOpenListing,
  onSelectVariant,
}: {
  row: SellerSupplierDbRowData
  variantRows?: SellerSupplierDbRowData[]
  propDefs: SupplierDbPropDefData[]
  categoryLabel: string
  typeLabel?: string
  onOpenListing: (row: SellerSupplierDbRowData) => void
  onSelectVariant?: (row: SellerSupplierDbRowData) => void
  onOpenShipping: (row: SellerSupplierDbRowData) => void
}) {
  const { queueIds, favoriteIds, toggleQueued, toggleFavorite } = useGalleryCollection()
  const queued = queueIds.has(row.productId)
  const favorited = favoriteIds.has(row.productId)
  const listability = listabilityOf(row)
  const listingBlocked = !listability.listable
  const category = [categoryLabel, typeLabel].filter(Boolean).join(" · ")
  const shipping = row.shippingCostCents === undefined
    ? "运费待定"
    : `运费 ${formatCny(row.shippingCostCents ?? 0)}`
  const listedAt = formatDateMs(row.listedAtMs)
  const props = propDefs
    .filter((def) => def.sellerVisible && def.sourceId === row.sourceId)
    .map((def) => [def.name, propValueText(def, row.props[def.propId])] as [string, string])
    .filter(([, value]) => value.trim() !== "")
  const packSides: Array<[string, number | null | undefined]> = [
    ["包装宽度", row.packWidthMm],
    ["包装高度", row.packHeightMm],
    ["包装深度", row.packDepthMm],
  ]
  const facts = ([
    ["类目", categoryLabel || "类目待定"],
    ["规格", row.size || "默认规格"],
    ["品牌", row.brand ?? ""],
    ["材质", row.material ?? ""],
    ["工艺", row.craft ?? ""],
    ["商品清单", row.contents ?? ""],
    ...props,
    ...(row.grossWeightG != null ? [["毛重", `${row.grossWeightG} g`] as [string, string]] : []),
    ...(packSides.every(([, value]) => value != null)
      ? [["包装尺寸", `${row.packWidthMm}×${row.packHeightMm}×${row.packDepthMm} mm`] as [string, string]]
      : packSides.flatMap(([label, value]): Array<[string, string]> => value != null ? [[label, `${value} mm`]] : [])),
  ] satisfies Array<[string, string]>).filter(([, value]) => value.trim() !== "")

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-6 overflow-y-auto pb-16" data-gallery-detail="">
      <div className="grid min-w-0 items-start gap-6 lg:grid-cols-[minmax(0,6fr)_minmax(0,7fr)] lg:gap-8">
        <ProductMedia key={row.productId} row={row} />
        <section className="min-w-0" aria-label="商品选品">
          <h2 className="text-3xl leading-snug font-semibold text-balance break-words">{row.title}</h2>
          <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-compact text-muted-foreground">
            <span className="font-mono break-all" aria-label={`编号 ${row.platformCode || "待定"}`}>
              {row.platformCode || "编号待定"}
            </span>
            <span>{category || "类目待定"}</span>
          </div>

          <div className="mt-6" data-gallery-price="">
            <div className="flex flex-wrap items-baseline gap-3">
              <span className="text-3xl leading-none font-semibold tabular-nums" aria-label={`平台价 ${formatCny(row.platformPriceCents)}`}>
                {formatCny(row.platformPriceCents)}
              </span>
              <span className="text-compact text-muted-foreground">平台价</span>
            </div>
            <div className="mt-3 flex flex-wrap gap-x-5 gap-y-1 text-compact text-muted-foreground">
              <span>{shipping}</span>
              <span>{leadTimeLabel(row.leadTime)}</span>
            </div>
          </div>

          <div className="mt-6 border-t border-border pt-5">
            <h3 className="mb-3 text-compact font-medium">
              规格{variantRows.length > 1 ? `（${variantRows.length}）` : ""}
            </h3>
            <div role="radiogroup" aria-label="规格" className="flex flex-wrap gap-2">
              {variantRows.map((variant) => {
                const active = variant.productId === row.productId
                const variantQueued = queueIds.has(variant.productId)
                return (
                  <label
                    key={variant.productId}
                    className={cn(
                      "flex min-h-11 min-w-0 max-w-full cursor-pointer items-center gap-2 rounded-lg border px-3 py-2 text-compact has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-ring",
                      active
                        ? "border-brand bg-brand-soft font-medium text-brand-ink"
                        : "border-border hover:border-border-strong hover:bg-muted",
                    )}
                  >
                    <input
                      type="radio"
                      aria-label={(variant.size || "默认规格") + (variantQueued ? "（已在清单）" : "")}
                      name="supplier-gallery-variant"
                      value={variant.productId}
                      checked={active}
                      onChange={() => onSelectVariant?.(variant)}
                      className="sr-only"
                    />
                    <span className="min-w-0 break-words">{variant.size || "默认规格"}</span>
                    {variantQueued ? <Check aria-hidden className="size-3.5 shrink-0" /> : null}
                  </label>
                )
              })}
            </div>
          </div>

          <div className="mt-5 flex flex-wrap items-center gap-2" role="group" aria-label="上架动作">
            <Button
              size="lg"
              variant={queued ? "secondary" : "brand"}
              className="min-w-40"
              aria-pressed={queued}
              data-gallery-queue-toggle=""
              onClick={() => {
                toggleQueued(row)
              }}
            >
              {queued ? <Check aria-hidden /> : <ListPlus aria-hidden />}
              {queued ? "已加入清单" : "加入上架清单"}
            </Button>
            <Button
              size="lg"
              variant="outline"
              disabled={listingBlocked}
              aria-disabled={listingBlocked || undefined}
              data-listability-blocked={listingBlocked ? "" : undefined}
              data-gallery-open-listing=""
              onClick={() => {
                if (listingBlocked) return
                onOpenListing(row)
              }}
            >
              进入上架 <ArrowRight aria-hidden />
            </Button>
            <IconButton
              icon={Heart}
              iconClassName={cn(favorited && "fill-current")}
              label={favorited ? "取消收藏" : "收藏"}
              variant="outline"
              size="icon-lg"
              aria-pressed={favorited}
              data-gallery-favorite=""
              onClick={() => toggleFavorite(row.productId)}
            />
          </div>
          {listingBlocked ? (
            <p className="mt-3 text-compact text-muted-foreground" data-listability-note="">
              {listabilityExplanation(row.denial)}
            </p>
          ) : null}

          <section className="mt-6" aria-label="商品参数">
            <h3 className="mb-3 text-sm font-semibold">商品参数</h3>
            <dl aria-label="商品资料">
              {facts.map(([label, value], factIndex) => <DetailFact key={`${label}-${factIndex}`} label={label} value={value} />)}
            </dl>
            {row.description.trim() ? (
              <section className="mt-4 border-t border-border pt-4" aria-label="商品描述">
                <h3 className="mb-2 text-compact font-medium">商品描述</h3>
                <p className="text-compact leading-relaxed break-words whitespace-pre-wrap">{row.description}</p>
              </section>
            ) : null}
          </section>

          {row.fixedTags.length ? (
            <ul className="mt-5 flex flex-wrap gap-1.5" aria-label="标签">
              {row.fixedTags.map((tag, index) => (
                <li key={`${tag}-${index}`}>
                  <Badge variant="secondary" className="max-w-full font-normal whitespace-normal break-all">{tag}</Badge>
                </li>
              ))}
            </ul>
          ) : null}
          {listedAt ? <p className="mt-4 text-meta text-muted-foreground">上架 {listedAt}</p> : null}
        </section>
      </div>
    </div>
  )
}

function ProductMedia({ row }: {
  row: SellerSupplierDbRowData
}) {
  const media = [
    ...row.productVideos.map((item) => ({ ...item, kind: "video" as const })),
    ...row.gallery.map((item) => ({ ...item, kind: "image" as const })),
  ]
  const [index, setIndex] = useState(0)
  const [failedUrl, setFailedUrl] = useState("")
  const active = Math.min(index, Math.max(0, media.length - 1))
  const current = media[active]
  const videoRef = useRef<HTMLVideoElement>(null)
  useEffect(() => {
    const video = videoRef.current
    return () => video?.pause()
  }, [current?.url])

  return (
    <section className="min-w-0" aria-label="媒体浏览">
      <div className="grid grid-cols-[4rem_minmax(0,1fr)] items-start gap-2 sm:gap-3">
        <div className={cn(
          "relative row-start-1 aspect-[4/3] min-h-56 w-full overflow-hidden rounded-xl border border-border bg-muted lg:max-h-[68vh]",
          media.length ? "col-start-2" : "col-span-2",
        )} data-gallery-stage="">
          <div className="absolute inset-0">
            {!current || failedUrl === current.url ? (
              <div className="flex size-full flex-col items-center justify-center gap-2 px-4 py-8 text-muted-foreground">
                <Image className="size-6" aria-hidden />
                <p className="text-compact">{current ? (current.kind === "image" ? "图片加载失败" : "视频加载失败") : "暂无图片"}</p>
                {current ? <Button variant="outline" size="sm" onClick={() => setFailedUrl("")}>重新加载</Button> : null}
              </div>
            ) : current.kind === "video" ? (
              <video
                key={current.url}
                ref={videoRef}
                src={current.url}
                poster={current.coverUrl ? marketImageSrc(current.coverUrl, 1280) : undefined}
                aria-label={`${row.title} 视频 ${active + 1}`}
                controls
                playsInline
                preload="metadata"
                onError={() => setFailedUrl(current.url)}
                className="absolute inset-0 size-full object-contain"
              />
            ) : (
              <img
                key={current.url}
                src={marketImageSrc(current.url, 1280)}
                alt={`${row.title} 图片 ${active - row.productVideos.length + 1}`}
                width={current.w || undefined}
                height={current.h || undefined}
                decoding="async"
                onError={() => setFailedUrl(current.url)}
                className="absolute inset-0 size-full object-contain"
              />
            )}
            {media.length > 1 ? (
              <>
                <div className="pointer-events-none absolute inset-x-2 top-1/2 flex -translate-y-1/2 justify-between">
                  <IconButton icon={ChevronLeft} label="上一项" variant="outline" className="pointer-events-auto" onClick={() => setIndex((active + media.length - 1) % media.length)} />
                  <IconButton icon={ChevronRight} label="下一项" variant="outline" className="pointer-events-auto" onClick={() => setIndex((active + 1) % media.length)} />
                </div>
                <span className="absolute right-2 bottom-2 rounded-md bg-card px-2 py-1 text-meta tabular-nums">{active + 1} / {media.length}</span>
              </>
            ) : null}
          </div>
        </div>
        {media.length > 0 ? (
          <div className="relative col-start-1 row-start-1 min-h-0 self-stretch">
            <div className="absolute inset-0 flex flex-col gap-2 overflow-y-auto p-1" aria-label="媒体列表">
              {media.map((item, itemIndex) => {
                const video = item.kind === "video"
                const cover = video ? item.coverUrl : item.url
                const selected = active === itemIndex
                return (
                  <Button
                    key={`${item.url}-${itemIndex}`}
                    variant="outline"
                    aria-label={video ? `视频 ${itemIndex + 1}` : `第 ${itemIndex - row.productVideos.length + 1} 张`}
                    aria-current={selected ? "true" : undefined}
                    onClick={() => setIndex(itemIndex)}
                    className={cn("relative aspect-square h-auto w-full shrink-0 overflow-hidden p-0", selected && "border-brand ring-1 ring-brand")}
                  >
                    {cover ? <img src={marketImageSrc(cover, 256)} alt="" loading="lazy" decoding="async" className="size-full object-contain" /> : <Play aria-hidden />}
                    {video && cover ? <span className="absolute right-1 bottom-1 rounded-sm bg-card p-0.5"><Play aria-hidden className="size-3" /></span> : null}
                  </Button>
                )
              })}
            </div>
          </div>
        ) : null}
      </div>
    </section>
  )
}

function formatDateMs(ms: number): string {
  const date = new Date(ms)
  if (Number.isNaN(date.getTime())) return ""
  const pad = (n: number) => String(n).padStart(2, "0")
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

function DetailFact({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex min-w-0 items-baseline gap-3 border-t border-border/70 py-2">
      <dt className="w-28 shrink-0 text-compact break-words text-muted-foreground">{label}</dt>
      <dd className="min-w-0 text-compact break-words whitespace-pre-line" aria-label={`${label} ${value}`}>{value}</dd>
    </div>
  )
}
