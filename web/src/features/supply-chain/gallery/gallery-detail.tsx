/**
 * 行页面（只读详情页）— 淘宝式商品页（参考 item.taobao.com 详情页与看图器）：
 * 页顶不设店铺条/页眉行——直接进主体（货号落在「基本信息」表内，类目落在
 * 看图器「参数」页）；
 * 主体左媒体右决策栏——左栏是淘宝看图器结构：竖排媒体缩略图列（视频在前带
 * 播放角标，列尾挂 参数/尺码 快捷钮；图集为空时在该位留一枚「图集」占位钮，
 * 视频位随数据：无视频不设入口，不为空面板留门）+ 主舞台（竖版媒体两侧虚化铺底），
 * 舞台下居中一条分段 tab：视频 / 图集 / 参数 / 尺码（无视频时「视频」tab 同步
 * 隐藏），面板常驻按 tab 切换；
 * 舞台两侧的 上一项/下一项 沿媒体列顺序翻整条序列（视频逐个 → 图集逐个 →
 * 参数 → 尺码），跨界时 tab 跟切，不只在图集内部翻页。
 * 右栏是 price banner（平台价大号 + 平台划线价锚点，次行建议零售）、服务事实条（毛重/
 * 上架等，对位淘宝的保障行；交期只在基本信息表与参数面板出现）、规格选项格（select/multi_select 属性按可选项
 * 铺 tile，行值高亮为已选）、基本信息表（与行页面「基本信息」区同一张
 * 字段单：名称/编号/类目（L2 · 类型）/品牌/材质/工艺/毛重/包装尺寸/
 * 包装重量/交期 + 未铺选项格的属性——整表常驻，缺值留「—」占位，
 * 对位淘宝参数摘要）、固定 tags 徽章块与
 * 动作条（加入上架清单 / 进入上架 / 收藏——进入上架直接把当前规格
 * 交给上架导航，不要求先入清单；规格即提示词绑定，上架跟随选中的规格）。
 * 描述沉到页底全宽区，对位淘宝的「宝贝详情」段；默认字段不进入详情页——
 * 画廊事实只读行级基本信息与 seller_visible 自定义属性：类型按行的类目
 * 坐标经类目树解析出类型名，包装三边/重量由行字段（毫米/克）呈现。
 *
 * 无图行不收起两栏：左栏改放规格事实表 + 一条窄占位带，不留空媒体井。
 * 窄屏纵向堆叠。回程只走壳层面包屑模块段——页内不放返回钮。
 *
 * 收藏与「加入上架清单」是本机选品草稿（listing-queue.ts），只收不发；
 * 「进入上架」仍只递最小身份给 app 导航。物流注入入口不在本页（宿主在
 * catalog-screen 的 ProductShopView）。
 */
import { useEffect, useRef, useState } from "react"
import {
  ArrowRight,
  CalendarDays,
  Check,
  ChevronLeft,
  ChevronRight,
  Image,
  Images,
  ListOrdered,
  ListPlus,
  Package,
  Play,
  Ruler,
  Star,
  Truck,
} from "lucide-react"

import type {
  SellerSupplierDbRowData,
  SupplierDbPropDefData,
} from "@/bindings/http-supplier-dbs-catalog"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

import { LISTABILITY_EXPLAIN } from "../listability-copy"
import {
  formatCny,
  leadTimeLabel,
  listabilityOf,
  propValueText,
} from "./gallery-model"
import { useGalleryCollection } from "./listing-queue"
import { marketImageSrc } from "./market-image"

/** 规格选项格的显示上限——超出的选项仍能在参数面板里读到。 */
const OPTION_TILE_LIMIT = 24

/** 看图器四个 tab——对位淘宝看图器底条。 */
type MediaTab = "video" | "gallery" | "params" | "size"
const MEDIA_TABS: Array<{ id: MediaTab; label: string }> = [
  { id: "video", label: "视频" },
  { id: "gallery", label: "图集" },
  { id: "params", label: "参数" },
  { id: "size", label: "尺码" },
]

/** 默认 tab：有视频先停视频，其次图集，都没有就参数页——看图器始终在场。 */
function defaultMediaTab(row: SellerSupplierDbRowData): MediaTab {
  if (row.productVideos.length) return "video"
  if (row.gallery.length) return "gallery"
  return "params"
}

export function GalleryDetail({
  row: initialRow,
  variantRows = [initialRow],
  propDefs,
  categoryLabel,
  onOpenListing,
  onSelectVariant,
  typeLabel,
}: {
  row: SellerSupplierDbRowData
  variantRows?: SellerSupplierDbRowData[]
  /** seller_visible prop defs for this row's db, position-ordered. */
  propDefs: SupplierDbPropDefData[]
  categoryLabel: string
  /** 类型名——行的类目坐标末段，由宿主经类目树解析。 */
  typeLabel?: string
  onOpenListing: (row: SellerSupplierDbRowData) => void
  onSelectVariant?: (row: SellerSupplierDbRowData) => void
  /**
   * 物流注入回调：宿主契约保留（测试/宿主仍递），详情页不再触发——
   * 物流入口在 catalog-screen 的 ProductShopView。
   */
  onOpenShipping: (row: SellerSupplierDbRowData) => void
}) {
  const row = initialRow
  const [slide, setSlide] = useState(0)
  const [videoIndex, setVideoIndex] = useState(0)
  // 看图器 tab：有视频默认停在视频（淘宝同此），无媒体落到参数页。
  const [mediaTab, setMediaTab] = useState<MediaTab>(() =>
    defaultMediaTab(row),
  )
  // A different row reopens the deck at its cover; the page itself stays put.
  useEffect(() => {
    setSlide(0)
    setVideoIndex(0)
    setMediaTab(defaultMediaTab(row))
  }, [row.productId])

  const {
    queueIds,
    favoriteIds,
    toggleQueued,
    toggleFavorite,
  } = useGalleryCollection()
  const queued = queueIds.has(row.productId)
  const favorited = favoriteIds.has(row.productId)
  // 前置门：行事实（listable/denial）驱动的两键禁用——点击前就看得见
  // 「为什么现在不能上架」，而不是点完才吃一句黑话。
  const listability = listabilityOf(row)
  const listingBlocked = !listability.listable

  const slides = row.gallery
  const safeSlide = Math.min(slide, Math.max(0, slides.length - 1))
  const current = slides[safeSlide]
  // 建议零售与平台价、划线价（平台）同为人民币（¥），同一套币种符。
  const retail =
    row.suggestedRetailCents != null ? formatCny(row.suggestedRetailCents) : ""
  // 平台划线价是平台价的划线锚点（平台优惠展示用）。
  const platformOldPrice =
    row.suggestedOldPriceCents != null
      ? formatCny(row.suggestedOldPriceCents)
      : ""
  // 货源运费：未填（null）或 0 即零运费（¥0.00），有值按分格式化。
  const shippingCost =
    row.shippingCostCents !== undefined
      ? formatCny(row.shippingCostCents ?? 0)
      : ""
  const props = propDefs
    .map((def) => ({ def, text: propValueText(def, row.props[def.propId]) }))
    .filter((entry) => entry.text !== "")

  // 规格选项格（淘宝「颜色分类」位）：select/multi_select 属性按定义选项铺
  // tile，行当前值高亮为已选——只读页不做选择交互，只呈现「这个规格有哪些选」。
  const optionGroups = propDefs
    .filter(
      (def) =>
        (def.type === "select" || def.type === "multi_select") &&
        def.options.length > 0,
    )
    .map((def) => {
      const raw = row.props[def.propId]
      const picked = new Set(
        Array.isArray(raw)
          ? raw.map((item) => String(item))
          : raw !== null && raw !== undefined && raw !== ""
            ? [String(raw)]
            : [],
      )
      return { def, picked }
    })
    .filter((group) => group.picked.size > 0)

  const listedAt = formatDateMs(row.listedAtMs)

  const hasVideos = row.productVideos.length > 0

  // 参数面板的事实对：货品级事实（货号/交期/运费/类型/品牌/材质/工艺/毛重/上架），
  // 再 seller_visible 属性——对位淘宝「参数」页里的属性表。
  const paramFacts: Array<[string, string]> = [
    ["货号", row.platformCode],
    ["交期", leadTimeLabel(row.leadTime)],
    ...(shippingCost ? [["运费", shippingCost] as [string, string]] : []),
    ...(typeLabel ? [["类型", typeLabel] as [string, string]] : []),
    ...(row.brand ? [["品牌", row.brand] as [string, string]] : []),
    ...(row.material ? [["材质", row.material] as [string, string]] : []),
    ...(row.craft ? [["工艺", row.craft] as [string, string]] : []),
    ...(row.grossWeightG != null
      ? [["毛重", `${row.grossWeightG} g`] as [string, string]]
      : []),
    ...(listedAt ? [["上架", listedAt] as [string, string]] : []),
  ]

  // 包装是行级事实（毫米/克）：三边凑齐合并一行「包装尺寸 W×H×D mm」，缺边
  // 按已填的逐条呈现；包装重量独立一行。尺码面板与基本信息表共用这组事实。
  const packSides: Array<[string, number | null | undefined]> = [
    ["包装宽度", row.packWidthMm],
    ["包装高度", row.packHeightMm],
    ["包装深度", row.packDepthMm],
  ]
  const packFacts: Array<{ key: string; label: string; value: string }> =
    row.packWidthMm != null && row.packHeightMm != null && row.packDepthMm != null
      ? [
          {
            key: "pack:size",
            label: "包装尺寸",
            value: `${row.packWidthMm}×${row.packHeightMm}×${row.packDepthMm} mm`,
          },
        ]
      : packSides.flatMap(([label, value]) =>
          value != null
            ? [{ key: `pack:${label}`, label, value: `${value} mm` }]
            : [],
        )
  if (row.packWeightG != null) {
    packFacts.push({
      key: "pack:weight",
      label: "包装重量",
      value: `${row.packWeightG} g`,
    })
  }

  // 尺码面板：行级尺码 + 名字里带尺寸/尺码/大小/码数的属性 + 毛重 +
  // 包装尺寸/重量。
  const sizePropPattern = /规格|尺码|尺寸|大小|码数|size/i
  const sizeFacts: Array<[string, string]> = [
    ...(row.size ? [["规格", row.size] as [string, string]] : []),
    ...props
      .filter(
        ({ def }) => sizePropPattern.test(def.name) || sizePropPattern.test(def.propId),
      )
      .map(({ def, text }): [string, string] => [def.name, text]),
    ...(row.grossWeightG != null
      ? [["毛重", `${row.grossWeightG} g`] as [string, string]]
      : []),
    ...packFacts.map((fact): [string, string] => [fact.label, fact.value]),
  ]

  // 服务事实一行：交付事实（对位淘宝发货/保障行）。交期只在「基本信息」表
  // 与参数面板出现，不再在服务事实行重复一次。
  const deliveryFacts: Array<{ icon: typeof Package; text: string }> = [
    ...(row.grossWeightG != null
      ? [{ icon: Package, text: `毛重 ${row.grossWeightG} g` }]
      : []),
    ...(listedAt ? [{ icon: CalendarDays, text: `上架 ${listedAt}` }] : []),
  ]

  // 基本信息——动作条上方的行级事实表，与行页面「基本信息」区同一张字段单：
  // 名称/编号/类目（L2 · 类型，categoryShortLabel 同款拼接）/品牌/材质/工艺/
  // 毛重/包装尺寸/包装重量/交期 + 选项格之外的 seller_visible 属性（定义即列）。
  // 整表常驻，缺值统一交 DetailFact 留「—」占位，行不散。
  // 已铺选项格的 select/multi_select 上面已含已选值，这里不重复；规格由
  // 变体 radio / 尺码面板承担，运费与上架日期分归价盘横幅与交付信息行。
  const tiledPropIds = new Set(
    optionGroups
      .filter(({ def, picked }) =>
        def.options.some((option) => picked.has(option.value)),
      )
      .map(({ def }) => def.propId),
  )
  // 包装尺寸固定一行：三边凑齐正常合并，缺边按位留「—」，三边全空缺整行
  // 交「—」占位——与尺码面板「按已填逐条」是两种口径。
  const packSizeText =
    row.packWidthMm == null && row.packHeightMm == null && row.packDepthMm == null
      ? ""
      : `${row.packWidthMm ?? "—"}×${row.packHeightMm ?? "—"}×${row.packDepthMm ?? "—"} mm`
  const infoRows: Array<{
    key: string
    label: string
    value: string
    mono?: boolean
  }> = [
    { key: "row:title", label: "名称", value: row.title },
    { key: "row:code", label: "编号", value: row.platformCode, mono: true },
    {
      key: "row:category",
      label: "类目",
      value: [categoryLabel, typeLabel].filter(Boolean).join(" · "),
    },
    { key: "row:brand", label: "品牌", value: row.brand ?? "" },
    { key: "row:material", label: "材质", value: row.material ?? "" },
    { key: "row:craft", label: "工艺", value: row.craft ?? "" },
    {
      key: "row:weight",
      label: "毛重",
      value: row.grossWeightG != null ? `${row.grossWeightG} g` : "",
    },
    { key: "pack:size", label: "包装尺寸", value: packSizeText },
    {
      key: "pack:weight",
      label: "包装重量",
      value: row.packWeightG != null ? `${row.packWeightG} g` : "",
    },
    { key: "row:contents", label: "清单", value: row.contents ?? "" },
    { key: "row:lead", label: "交期", value: leadTimeLabel(row.leadTime) },
    ...propDefs
      .filter((def) => !tiledPropIds.has(def.propId))
      .map((def) => ({
        key: `prop:${def.propId}`,
        label: def.name,
        value: propValueText(def, row.props[def.propId]),
      })),
  ]

  // 淘宝看图器：左列媒体缩略图（视频在前，带播放角标）+ 参数/尺码快捷钮，
  // 右侧舞台按 tab 切四块面板；面板常驻（hidden 切换），视频不被反复卸载。
  const safeVideoIndex = Math.min(
    videoIndex,
    Math.max(0, row.productVideos.length - 1),
  )
  const currentVideo = row.productVideos[safeVideoIndex]
  // 面板常驻不卸载（hidden 切换），离开视频页要把声音停掉——display:none
  // 不会自动 pause，否则用户切到图集还在放。
  const stageVideoRef = useRef<HTMLVideoElement>(null)
  useEffect(() => {
    if (mediaTab !== "video") stageVideoRef.current?.pause()
  }, [mediaTab])
  const railButton = (active: boolean) =>
    cn(
      "flex w-16 cursor-pointer flex-col items-center justify-center gap-1 rounded-lg px-1 py-2 text-meta transition-colors",
      active
        ? "bg-brand-soft font-medium text-brand-ink"
        : "bg-muted/70 text-muted-foreground hover:bg-muted hover:text-foreground",
    )
  // 缩略图块：浅灰圆角底 + 内嵌图，当前项用带间隙的描边环（对位淘宝橙圈）。
  const railThumb = (active: boolean) =>
    cn(
      "block w-16 cursor-pointer rounded-lg bg-muted/70 p-0.5 transition-[box-shadow,background-color]",
      active
        ? "ring-2 ring-brand"
        : "hover:bg-muted",
    )

  // 舞台翻页序列与左列媒体列一一对位：每条视频一个 → 每张图一个（空图集
  // 算占位列）→ 参数 → 尺码。无视频不占位——左列与 tab 都没有视频入口，
  // 翻页序列同样不留空门。上一项/下一项 沿它走，跨界时同步
  // videoIndex/slide 与 mediaTab，列高亮与底部分段 tab 跟切。
  const mediaSteps: Array<{ tab: MediaTab; index: number }> = [
    ...row.productVideos.map((_, index) => ({ tab: "video" as MediaTab, index })),
    ...(slides.length
      ? slides.map((_, index) => ({ tab: "gallery" as MediaTab, index }))
      : [{ tab: "gallery" as MediaTab, index: 0 }]),
    { tab: "params", index: 0 },
    { tab: "size", index: 0 },
  ]
  const activeStepIndex =
    mediaTab === "video" ? safeVideoIndex : mediaTab === "gallery" ? safeSlide : 0
  const stepIndex = Math.max(
    0,
    mediaSteps.findIndex(
      (step) => step.tab === mediaTab && step.index === activeStepIndex,
    ),
  )
  const stepMedia = (delta: number) => {
    const next =
      mediaSteps[(stepIndex + delta + mediaSteps.length) % mediaSteps.length]
    if (!next) return
    if (next.tab === "video") setVideoIndex(next.index)
    if (next.tab === "gallery") setSlide(next.index)
    setMediaTab(next.tab)
  }

  const stageFrame =
    "relative aspect-[4/5] max-h-[68vh] w-full overflow-hidden rounded-2xl border border-border bg-muted"

  const mediaViewer = (
    <section
      className="grid min-w-0 grid-cols-[4rem_minmax(0,1fr)] gap-3"
      aria-label="媒体浏览"
    >
      {/* 媒体列壳与舞台同一格行：壳随舞台高度拉伸，ul 绝对填充壳内——
          超出舞台的缩略图被裁进列内滚动，不再用固定 max-h 凑高度。 */}
      <div className="relative min-h-0">
        <ul
          className="absolute inset-0 flex flex-col gap-1.5 overflow-y-auto"
          aria-label="媒体列表"
        >
          {row.productVideos.map((video, index) => (
            <li key={video.url + "-" + index} className="shrink-0">
              <button
                type="button"
                aria-label={`视频 ${index + 1}`}
                aria-current={
                  mediaTab === "video" && index === videoIndex
                    ? "true"
                    : undefined
                }
                onClick={() => {
                  setVideoIndex(index)
                  setMediaTab("video")
                }}
                className={cn(
                  "relative",
                  railThumb(mediaTab === "video" && index === videoIndex),
                )}
              >
                {video.coverUrl ? (
                  <img
                    src={marketImageSrc(video.coverUrl, 256)}
                    alt=""
                    loading="lazy"
                    decoding="async"
                    className="aspect-square w-full rounded-md object-cover"
                  />
                ) : (
                  <span className="grid aspect-square w-full place-items-center rounded-md bg-foreground/80 text-background">
                    <Play className="size-3.5" aria-hidden />
                  </span>
                )}
                <span className="absolute right-1 bottom-1 grid size-3.5 place-items-center rounded-full bg-foreground/70 text-background">
                  <Play className="size-2 fill-current" aria-hidden />
                </span>
              </button>
            </li>
          ))}
          {/* 空图集的占位钮——与 参数/尺码 同形，点进去由舞台面板如实给
              「暂无图片」。视频位不设占位：无视频就没有入口。 */}
          {slides.map((item, index) => (
            <li key={item.url + "-" + index} className="shrink-0">
              <button
                type="button"
                aria-label={`第 ${index + 1} 张`}
                aria-current={
                  mediaTab === "gallery" && index === safeSlide
                    ? "true"
                    : undefined
                }
                onClick={() => {
                  setSlide(index)
                  setMediaTab("gallery")
                }}
                className={railThumb(
                  mediaTab === "gallery" && index === safeSlide,
                )}
              >
                <img
                  src={marketImageSrc(item.url, 256)}
                  alt=""
                  loading="lazy"
                  decoding="async"
                  className="aspect-square w-full rounded-md object-cover"
                />
              </button>
            </li>
          ))}
          {slides.length === 0 ? (
            <li className="shrink-0">
              <button
                type="button"
                aria-label="图集"
                aria-current={mediaTab === "gallery" ? "true" : undefined}
                data-gallery-media-rail="gallery"
                onClick={() => setMediaTab("gallery")}
                className={railButton(mediaTab === "gallery")}
              >
                <Images className="size-3.5" aria-hidden />
                图集
              </button>
            </li>
          ) : null}
          {/* 列尾快捷钮：参数/尺码——对位淘宝看图器左列下端的两个入口。 */}
          <li className="shrink-0">
            <button
              type="button"
              aria-label="参数"
              aria-current={mediaTab === "params" ? "true" : undefined}
              data-gallery-media-rail="params"
              onClick={() => setMediaTab("params")}
              className={railButton(mediaTab === "params")}
            >
              <ListOrdered className="size-3.5" aria-hidden />
              参数
            </button>
          </li>
          <li className="shrink-0">
            <button
              type="button"
              aria-label="尺码"
              aria-current={mediaTab === "size" ? "true" : undefined}
              data-gallery-media-rail="size"
              onClick={() => setMediaTab("size")}
              className={railButton(mediaTab === "size")}
            >
              <Ruler className="size-3.5" aria-hidden />
              尺码
            </button>
          </li>
        </ul>
      </div>

      <div className={stageFrame}>
        {/* 视频面板：竖版视频两侧虚化铺底（封面图放大模糊），正中 contain。 */}
        <div
          role="tabpanel"
          aria-label="视频"
          hidden={mediaTab !== "video"}
          className="absolute inset-0"
        >
          {currentVideo ? (
            <>
              {currentVideo.coverUrl ? (
                <img
                  src={marketImageSrc(currentVideo.coverUrl, 1280)}
                  alt=""
                  aria-hidden
                  className="absolute inset-0 size-full scale-110 object-cover opacity-60 blur-2xl saturate-150"
                />
              ) : (
                <span
                  aria-hidden
                  className="absolute inset-0 bg-foreground/80"
                />
              )}
              <video
                key={currentVideo.url}
                ref={stageVideoRef}
                src={currentVideo.url}
                poster={currentVideo.coverUrl ? marketImageSrc(currentVideo.coverUrl, 1280) : undefined}
                controls
                playsInline
                preload="metadata"
                aria-label={`${row.title} 视频 ${safeVideoIndex + 1}`}
                className="absolute inset-0 size-full object-contain"
              />
            </>
          ) : (
            <StageHint label="暂无视频" />
          )}
        </div>

        {/* 图集面板：同样的虚化铺底 + 居中 contain（当前张数由左列缩略图
            高亮与底部分段 tab 承担，舞台不再挂浮层计数）。 */}
        <div
          role="tabpanel"
          aria-label="图集"
          hidden={mediaTab !== "gallery"}
          className="absolute inset-0"
        >
          {current ? (
            <>
              <img
                src={marketImageSrc(current.url, 1280)}
                alt=""
                aria-hidden
                className="absolute inset-0 size-full scale-110 object-cover opacity-60 blur-2xl saturate-150"
              />
              <img
                src={marketImageSrc(current.url, 1280)}
                alt={`${row.title} 图片 ${safeSlide + 1}`}
                width={current.w || undefined}
                height={current.h || undefined}
                loading="lazy"
                decoding="async"
                className="relative size-full object-contain"
              />
            </>
          ) : (
            <StageHint label="暂无图片" />
          )}
        </div>

        {/* 参数面板：货品事实 + seller_visible 属性，与页底参数表同构。 */}
        <div
          role="tabpanel"
          aria-label="参数"
          hidden={mediaTab !== "params"}
          className="absolute inset-0 overflow-y-auto bg-card px-12 py-3"
        >
          <dl className="min-w-0">
            {paramFacts.map(([label, value]) => (
              <DetailFact key={label} label={label} value={value} />
            ))}
            {props.map(({ def, text }) => (
              <DetailFact key={def.propId} label={def.name} value={text} />
            ))}
          </dl>
        </div>

        {/* 尺码面板：行级尺码 + 尺码相关属性 + 行级包装尺寸/重量；
            没有则如实给空态。 */}
        <div
          role="tabpanel"
          aria-label="尺码"
          hidden={mediaTab !== "size"}
          className="absolute inset-0 overflow-y-auto bg-card px-12 py-3"
        >
          {sizeFacts.length ? (
            <dl className="min-w-0">
              {sizeFacts.map(([label, value]) => (
                <DetailFact key={label} label={label} value={value} />
              ))}
            </dl>
          ) : (
            <StageHint label="暂无尺码信息" />
          )}
        </div>

        {/* 翻页钮在舞台层、四块面板共用：沿媒体列翻整条序列
            （空图集占一位；无视频不占位，与左列入口一一对位），循环回绕。 */}
        {mediaSteps.length > 1 ? (
          <>
            <Button
              type="button"
              size="icon-sm"
              variant="outline"
              aria-label="上一项"
              className="absolute top-1/2 left-2 -translate-y-1/2 active:not-aria-[haspopup]:-translate-y-1/2 cursor-pointer rounded-full border-border/50 bg-card/50 hover:bg-card/80 hover:border-border-strong backdrop-blur-md shadow-xs"
              onClick={() => stepMedia(-1)}
            >
              <ChevronLeft aria-hidden />
            </Button>
            <Button
              type="button"
              size="icon-sm"
              variant="outline"
              aria-label="下一项"
              className="absolute top-1/2 right-2 -translate-y-1/2 active:not-aria-[haspopup]:-translate-y-1/2 cursor-pointer rounded-full border-border/50 bg-card/50 hover:bg-card/80 hover:border-border-strong backdrop-blur-md shadow-xs"
              onClick={() => stepMedia(1)}
            >
              <ChevronRight aria-hidden />
            </Button>
          </>
        ) : null}
      </div>

      {/* 分段 tab 条——第二行落在舞台列正下方，按图片框居中，不被媒体列带偏。
          无视频时「视频」tab 随左列视频入口一起隐藏（不为空面板留门）。 */}
      <div className="col-start-2 flex justify-center">
        <div
          role="tablist"
          aria-label="媒体与参数"
          className="inline-flex rounded-full bg-muted p-1"
        >
          {MEDIA_TABS.filter((tab) => tab.id !== "video" || hasVideos).map((tab) => (
            <button
              key={tab.id}
              type="button"
              role="tab"
              aria-selected={mediaTab === tab.id}
              data-gallery-media-tab={tab.id}
              onClick={() => setMediaTab(tab.id)}
              className={cn(
                "cursor-pointer rounded-full px-4 py-1.5 text-compact transition-colors",
                mediaTab === tab.id
                  ? "bg-card font-medium text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {tab.label}
            </button>
          ))}
        </div>
      </div>
    </section>
  )

  // 决策栏（淘宝右栏）：标题 → 红色促销横幅 → 服务事实 → 规格格 → 拼合 CTA。
  // 淘宝右栏无卡片外框，各段用留白与细发线分开。
  const buyBox = (
    <div className="flex min-w-0 flex-col gap-4">
      <header className="flex min-w-0 flex-col gap-1.5">
        <h2 className="min-w-0 text-lg leading-7 font-semibold break-words text-foreground">
          {row.title}
        </h2>
        {hasVideos ? (
          <p className="flex min-w-0 flex-wrap items-baseline gap-x-1.5 text-xs text-muted-foreground">
            <span>视频 {row.productVideos.length} 条</span>
          </p>
        ) : null}
      </header>

      <section className="flex min-w-0 flex-col" aria-label="价格与上架">
        {/* 价盘横幅——淘宝红橙渐变促销条，按内容收拢宽度（w-fit max-w-full，
            避免宽栏下横跨整屏留白过多）：左主价区「平台价」白底红字促销 tag
            领起 + ¥ 缩小半档前置的等宽大号数字 + 平台划线价锚点（同币种 ¥，
            读作平台优惠），次行一条 metric 带（建议零售/运费，两项间竖发线
            分隔，缺项直接不渲染）；右端供货承诺贴边收口——源头供货同形
            tag、全场直发带货车小图标。横幅本体落一道同色系软阴影与内嵌
            高光，贴底不飘。窄栏两栏换行——承诺行落到主价下方仍从左起排。 */}
        <div
          className="relative flex w-fit max-w-full min-w-0 flex-wrap items-end justify-between gap-x-6 gap-y-3 self-start overflow-hidden rounded-xl bg-gradient-to-r from-[#ff5a1f] to-[#ff2e63] px-4 py-4 text-white shadow-lg shadow-[#ff2e63]/30 ring-1 ring-white/25 ring-inset"
          data-gallery-price-banner=""
        >
          <div className="flex min-w-0 flex-col gap-1.5">
            <p className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-1">
              <span className="self-center rounded bg-white px-1.5 py-0.5 text-meta leading-none font-semibold text-destructive">
                平台价
              </span>
              {/* ¥ 借 first-letter 缩小半档（flex 项已块化，伪元素生效）——
                  价格保持单一文本节点，「¥16.00」口径不散。 */}
              <span className="font-mono text-2xl leading-none font-bold tabular-nums first-letter:text-sm first-letter:font-semibold">
                {formatCny(row.platformPriceCents)}
              </span>
              {platformOldPrice ? (
                <span
                  aria-label={`平台划线价 ${platformOldPrice}`}
                  className="font-mono text-compact tabular-nums text-white/70 line-through"
                >
                  {platformOldPrice}
                </span>
              ) : null}
            </p>
            {retail || shippingCost ? (
              <p
                className="flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-1 text-meta text-white/90"
                data-gallery-price-metrics=""
              >
                {retail ? (
                  <span className="tabular-nums">{`建议零售 ${retail}`}</span>
                ) : null}
                {retail && shippingCost ? (
                  <span aria-hidden className="h-2.5 w-px bg-white/35" />
                ) : null}
                {shippingCost ? (
                  <span className="tabular-nums">{`运费 ${shippingCost}`}</span>
                ) : null}
              </p>
            ) : null}
          </div>
          <div className="flex min-w-0 shrink-0 flex-col items-end gap-1">
            <span className="rounded-md bg-white/20 px-2 py-0.5 text-meta font-medium ring-1 ring-white/30 ring-inset">
              源头供货
            </span>
            <span className="flex items-center gap-1 text-meta text-white/85">
              <Truck className="size-3" aria-hidden />
              全场直发
            </span>
          </div>
        </div>

        {/* 服务事实行——对位淘宝「发货/保障行」；无事实时整行不占位。 */}
        {deliveryFacts.length ? (
          <ul
            className="flex flex-wrap gap-x-4 gap-y-1.5 border-b border-border/60 py-3"
            aria-label="交付信息"
          >
            {deliveryFacts.map((fact) => (
              <li
                key={fact.text}
                className="flex min-w-0 items-center gap-1.5 text-compact text-muted-foreground"
              >
                <fact.icon
                  className="size-3.5 shrink-0 text-faint-foreground"
                  aria-hidden
                />
                <span className="min-w-0 break-words">{fact.text}</span>
              </li>
            ))}
          </ul>
        ) : null}

        {/* 规格选项格——淘宝「颜色分类」tile 区；行值即已选项。 */}
        {optionGroups.map(({ def, picked }) => (
          <div
            key={def.propId}
            className="flex flex-col gap-2 border-b border-border/60 py-3"
          >
            <h4 className="text-compact font-medium text-foreground">
              {def.name}
            </h4>
            <ul className="flex flex-wrap gap-1.5" aria-label={def.name}>
              {/* 过滤后留在列的选项都命中行值——tile 恒为已选态（只读呈现）。 */}
              {def.options
                .filter((option) => picked.has(option.value))
                .slice(0, OPTION_TILE_LIMIT)
                .map((option) => (
                  <li
                    key={option.value}
                    aria-current="true"
                    className="rounded-md border border-brand bg-brand-soft px-2.5 py-1 font-medium text-brand-ink text-compact break-words"
                  >
                    {option.label}
                  </li>
                ))}
            </ul>
          </div>
        ))}

        {/* 基本信息——决策位行级事实表，与看图器「参数」页同源（DetailFact 行）。
            整表常驻：缺值行也占位呈现，不随数据有无散行。 */}
        <div className="flex min-w-0 flex-col gap-2 border-b border-border/60 py-3">
          <h4 className="text-compact font-medium text-foreground">基本信息</h4>
          <dl className="min-w-0" aria-label="基本信息">
            {infoRows.map((fact) => (
              <DetailFact
                key={fact.key}
                label={fact.label}
                value={fact.value}
                mono={fact.mono}
              />
            ))}
          </dl>
        </div>

        {/* 固定 tags——从页底迁到决策位，沿用原有徽章块样式，落在基本信息与
            动作条之间。 */}
        {row.fixedTags.length ? (
          <section
            className="flex flex-col gap-1.5 border-b border-border/60 py-3"
            aria-label="标签"
          >
            {/* 标题与同栏「规格」「基本信息」同字号同色，标签块才与规格块同级；
                徽章本身仍是 text-meta 小字，靠 pill 形态而不是字号层级区分。 */}
            <h4 className="text-compact font-medium text-foreground">
              标签（{row.fixedTags.length}）
            </h4>
            <ul className="flex flex-wrap gap-1.5">
              {row.fixedTags.map((tag, index) => (
                <li key={tag + "-" + index}>
                  <Badge
                    variant="secondary"
                    className="max-w-full font-normal whitespace-normal"
                  >
                    {tag}
                  </Badge>
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        <div className="flex min-w-0 flex-col gap-2 border-b border-border/60 py-3">
          {/* 规格=提示词绑定：选规格即选该规格的提示词版本，绑定关系由下方
              正文说明，标题不再挂提示图标。单选件只留无障碍语义——选项格
              自己用边框/底色表达选中，不画圆点。 */}
          <h4 className="text-compact font-medium text-foreground">
            规格与提示词
          </h4>
          <div role="radiogroup" aria-label="规格" className="flex flex-wrap gap-1.5">
            {variantRows.map((variant) => {
              const active = variant.productId === row.productId
              const variantQueued = queueIds.has(variant.productId)
              return (
                <label
                  key={variant.productId}
                  className={cn(
                    "flex min-w-0 max-w-full cursor-pointer items-center gap-1.5 rounded-md border px-3 py-2 text-compact has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-ring",
                    active
                      ? "border-brand bg-brand-soft font-medium text-brand-ink"
                      : "border-border text-muted-foreground hover:border-border-strong hover:text-foreground",
                  )}
                >
                  <input
                    type="radio"
                    aria-label={
                      (variant.size || "默认规格") +
                      (variantQueued ? "（已在清单）" : "")
                    }
                    name="supplier-gallery-variant"
                    value={variant.productId}
                    checked={active}
                    onChange={() => onSelectVariant?.(variant)}
                    className="sr-only"
                  />
                  <span className="min-w-0 break-words">{variant.size || "默认规格"}</span>
                  {variantQueued ? (
                    <Check aria-hidden className="size-3 text-brand-ink" />
                  ) : null}
                </label>
              )
            })}
          </div>
          <p className="text-meta text-muted-foreground">
            提示词随规格选择，上架时使用所选规格对应的提示词。
          </p>
        </div>

        {/* 拼合 CTA——淘宝底条：加入上架清单（黄）| 进入上架（橙红渐变）+ 收藏。
            宽度随内容收拢并与价盘横幅同一起点，不铺满整栏。
            进入上架直接把当前规格交给上架导航；清单只服务批量导入。
            暂不可上架的行两枚自绘 button 置灰（aria-disabled + onClick 守卫，
            不走原生 disabled——禁用态也要能 hover 出光标提示），下面一行说明
            替代黑话 toast；收藏不属上架动作，不受这门影响。 */}
        <div className="flex min-w-0 max-w-full flex-col gap-2 self-start pt-4">
          <div className="flex w-fit max-w-full items-stretch gap-2">
            <div
              className="flex min-w-0 overflow-hidden rounded-xl"
              role="group"
              aria-label="上架动作"
            >
              <button
                type="button"
                aria-pressed={queued}
                aria-disabled={listingBlocked || undefined}
                {...(listingBlocked ? { "data-listability-blocked": "" } : {})}
                data-gallery-queue-toggle=""
                className={cn(
                  "flex min-w-0 items-center justify-center gap-1.5 bg-st-attest-soft px-4 py-2.5 text-sm font-medium text-st-attest-ink transition-colors",
                  listingBlocked
                    ? "cursor-not-allowed opacity-45"
                    : "cursor-pointer hover:bg-st-attest/25",
                  queued && "bg-st-attest/30 font-semibold",
                )}
                onClick={() => {
                  if (listingBlocked) return
                  toggleQueued(row)
                }}
              >
                {queued ? <Check aria-hidden /> : <ListPlus aria-hidden />}
                {queued ? "已加入清单" : "加入上架清单"}
              </button>
              <button
                type="button"
                aria-disabled={listingBlocked || undefined}
                {...(listingBlocked ? { "data-listability-blocked": "" } : {})}
                data-gallery-open-listing=""
                className={cn(
                  "flex min-w-0 items-center justify-center gap-1.5 bg-primary px-4 py-2.5 text-sm font-medium text-primary-foreground transition-opacity",
                  listingBlocked
                    ? "cursor-not-allowed opacity-45"
                    : "cursor-pointer hover:opacity-90",
                )}
                onClick={() => {
                  if (listingBlocked) return
                  onOpenListing(row)
                }}
              >
                进入上架
                <ArrowRight aria-hidden />
              </button>
            </div>
            <Button
              type="button"
              variant="outline"
              aria-pressed={favorited}
              aria-label={favorited ? "取消收藏" : "收藏"}
              data-gallery-favorite=""
              className={cn(
                "h-auto w-11 shrink-0 cursor-pointer flex-col gap-0.5 rounded-xl px-1 py-1.5 text-meta",
                favorited && "border-st-attest/50 bg-st-attest-soft text-st-attest-ink",
              )}
              onClick={() => toggleFavorite(row.productId)}
            >
              <Star
                aria-hidden
                className={cn("size-4", favorited && "fill-current text-st-attest-ink")}
              />
              {favorited ? "已收藏" : "收藏"}
            </Button>
          </div>
          {listability.listable ? null : (
            <p
              className="text-meta text-faint-foreground"
              data-listability-note=""
            >
              {LISTABILITY_EXPLAIN[listability.class]}
            </p>
          )}
        </div>
      </section>
    </div>
  )

  const descBlock = row.description ? (
    <section
      className="flex flex-col gap-1.5 border-t border-border/60 pt-5"
      aria-label="描述"
    >
      <h4 className="text-meta font-medium text-faint-foreground">描述</h4>
      <p className="text-compact leading-relaxed break-words whitespace-pre-wrap">
        {row.description}
      </p>
    </section>
  ) : null

  return (
    <div
      className="flex min-h-0 min-w-0 flex-1 flex-col gap-5 overflow-y-auto"
      data-gallery-detail=""
    >
      {/* 看图器始终在场：无媒体行也走同一条结构，默认停在「参数」页。 */}
      <div className="grid min-w-0 items-start gap-6 lg:grid-cols-[minmax(0,5fr)_minmax(0,6fr)] xl:gap-8">
        {mediaViewer}
        {buyBox}
      </div>

      {/* 页底全宽区——淘宝「宝贝详情」段；商品参数已在看图器「参数」页，
          默认字段不再另设页底账目区。 */}
      {descBlock}
      <div className="pb-6" aria-hidden />
    </div>
  )
}

/** 舞台空态：面板没有内容时的一句提示，保持面板骨架不塌。 */
function StageHint({ label }: { label: string }) {
  return (
    <div className="flex size-full flex-col items-center justify-center gap-1.5 text-faint-foreground">
      <Image className="size-5" aria-hidden />
      <span className="text-meta">{label}</span>
    </div>
  )
}

function formatDateMs(ms: number): string {
  const date = new Date(ms)
  if (Number.isNaN(date.getTime())) return ""
  const pad = (n: number) => String(n).padStart(2, "0")
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

function DetailFact({
  label,
  value,
  mono,
}: {
  label: string
  value: string
  mono?: boolean
}) {
  const empty = value === ""
  return (
    <div className="flex min-w-0 items-baseline gap-3 border-b border-border/60 py-1.5 last:border-b-0">
      <dt className="w-24 shrink-0 text-compact break-words text-faint-foreground">
        {label}
      </dt>
      <dd
        className={cn(
          "min-w-0 text-compact break-words whitespace-pre-line",
          mono && "font-mono",
          empty && "text-faint-foreground",
        )}
        aria-label={label + " " + (empty ? "—" : value)}
      >
        {empty ? "—" : value}
      </dd>
    </div>
  )
}
