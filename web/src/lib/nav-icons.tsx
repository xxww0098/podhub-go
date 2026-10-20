import type { ComponentType, ReactNode, SVGProps } from "react"

/**
 * Navigation glyphs, drawn by hand on lucide's 24x24 grid at a 1.75 stroke.
 *
 * They replace generic library icons because the library ones were ambiguous at
 * the size the sidebar actually renders (16px): Sparkles said nothing about bulk
 * publishing, the shopping bag and the parcel both meant "buying things", and
 * Boxes/Package both meant "a pile of goods".
 *
 * The binding rule is that glyphs sharing one sidebar must not be confusable once
 * rasterised to 16px. Two earlier drafts broke it and were redrawn: a panel frame
 * with a trend line read the same as the photo frame, and a deep U-shaped tray
 * under an up arrow read as a ship's anchor.
 *
 * Shapes are chosen so no two neighbours share a silhouette: bars, an arrow off a
 * shelf, a scalloped awning, goods in a shallow tray, a photo frame, a cube, a
 * parcel and its return arrow, an arrow entering a crate, a speech bubble, a star,
 * a truck.
 */
export type NavIcon = ComponentType<SVGProps<SVGSVGElement>>

const STROKE = 1.75

function navGlyph(displayName: string, children: ReactNode): NavIcon {
  const Glyph = (props: SVGProps<SVGSVGElement>) => (
    <svg
      viewBox="0 0 24 24"
      width="24"
      height="24"
      fill="none"
      stroke="currentColor"
      strokeWidth={STROKE}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    >
      {children}
    </svg>
  )
  ;(Glyph as { displayName?: string }).displayName = displayName
  return Glyph
}

/* ---- mode headers: the collapsed rail stacks these above the item list ---- */

/** 工作台 — panes of a working surface. */
export const WorkbenchNavIcon = navGlyph(
  "WorkbenchNavIcon",
  <>
    <rect x="3.6" y="3.6" width="7.4" height="7.4" rx="2" />
    <rect x="13" y="3.6" width="7.4" height="7.4" rx="2" />
    <rect x="3.6" y="13" width="7.4" height="7.4" rx="2" />
    <rect x="13" y="13" width="7.4" height="7.4" rx="2" />
  </>,
)

/** 平台管理 — a shield with a check: platform-wide configuration and data. */
export const AdminNavIcon = navGlyph(
  "AdminNavIcon",
  <>
    <path d="M12 3.4 19.4 6v5.2c0 4.5-3 7.9-7.4 9.4-4.4-1.5-7.4-4.9-7.4-9.4V6Z" />
    <path d="m9.2 11.8 2 2 3.6-4" />
  </>,
)

/** 履约 — a truck. The one mode whose whole job is moving goods. */
export const OpsNavIcon = navGlyph(
  "OpsNavIcon",
  <>
    <path d="M2.9 7a1.5 1.5 0 0 1 1.5-1.5h7.9a1.5 1.5 0 0 1 1.5 1.5v9.4H2.9z" />
    <path d="M13.8 9.5h3.4a1.5 1.5 0 0 1 1.24.66l2 2.96a1.5 1.5 0 0 1 .26.82v2.46h-6.9z" />
    <circle cx="7.4" cy="16.4" r="2.2" />
    <circle cx="17.6" cy="16.4" r="2.2" />
  </>,
)

/* ---- workspace ---- */

/** 代理中心 — a badge on a lanyard: the destination about the account's own
 *  referral standing rather than about goods. */
export const AgentNavIcon = navGlyph(
  "AgentNavIcon",
  <>
    <path d="M12 3.6a3.1 3.1 0 1 0 0 6.2 3.1 3.1 0 0 0 0-6.2Z" />
    <path d="M8.9 9.2 7.4 20.4l4.6-2.3 4.6 2.3-1.5-11.2" />
  </>,
)

/** 数据大屏 — three rising bars. */
export const ConsoleIcon = navGlyph(
  "ConsoleIcon",
  <>
    <path d="M3.7 19.8h16.6" />
    <path d="M6.9 19.8v-5.2" />
    <path d="M12 19.8v-9.6" />
    <path d="M17.1 19.8v-14.6" />
  </>,
)

/** 批量上架 — stock rising off a shelf, the shelf broken around it for "many". */
export const ListingIcon = navGlyph(
  "ListingIcon",
  <>
    <path d="M3.9 19.7h6.3" />
    <path d="M13.8 19.7h6.3" />
    <path d="M12 18.4V4" />
    <path d="M8 8 12 4l4 4" />
  </>,
)

/** 平台货盘 — a load of goods sitting in a shallow tray. */
export const CatalogIcon = navGlyph(
  "CatalogIcon",
  <>
    <path d="M3 12.1v1.8a2.4 2.4 0 0 0 2.4 2.4h13.2a2.4 2.4 0 0 0 2.4-2.4v-1.8" />
    <rect x="7.2" y="7.7" width="9.6" height="6.4" rx="1.4" />
  </>,
)

/** 列表管理 — a table grid: a header row and one column divider. */
export const SupplierDbsIcon = navGlyph(
  "SupplierDbsIcon",
  <>
    <rect x="3.4" y="4.6" width="17.2" height="14.8" rx="2.2" />
    <path d="M3.4 9.4h17.2" />
    <path d="M10.2 9.4v10" />
  </>,
)

/** 店铺商品 — a single boxed good. */
export const ProductsIcon = navGlyph(
  "ProductsIcon",
  <>
    <path d="M12 3.3 20.4 7.8v8.4L12 20.7 3.6 16.2V7.8Z" />
    <path d="M3.6 7.8 12 12.3l8.4-4.5" />
    <path d="M12 12.3v8.4" />
  </>,
)

/* ---- fulfilment ---- */

/** 订单发货 — a parcel leaving. */
export const OpsShippingIcon = navGlyph(
  "OpsShippingIcon",
  <>
    <rect x="3.2" y="7.2" width="9.6" height="9.6" rx="1.8" />
    <path d="M3.2 10.8h9.6" />
    <path d="M15.1 12h5.5" />
    <path d="M18.4 10 20.6 12 18.4 14" />
  </>,
)

/** 售后退货 — the same parcel, arrow turned back on itself. */
export const OpsReturnsIcon = navGlyph(
  "OpsReturnsIcon",
  <>
    <rect x="3.2" y="10.6" width="9.4" height="9.4" rx="1.8" />
    <path d="M3.2 14.1h9.4" />
    <path d="M20.4 13V10a3.2 3.2 0 0 0-3.2-3.2h-5.4" />
    <path d="M14.6 4 11.8 6.8 14.6 9.6" />
  </>,
)

/** 入仓供货 — goods dropping into an open crate. */
export const OpsSupplyIcon = navGlyph(
  "OpsSupplyIcon",
  <>
    <path d="M3.6 12.1v4.6a3.4 3.4 0 0 0 3.4 3.4h10a3.4 3.4 0 0 0 3.4-3.4v-4.6" />
    <path d="M12 3.9v7.8" />
    <path d="M8.4 8.1 12 11.7 15.6 8.1" />
  </>,
)

/** 客服消息 — a speech bubble, tail down-left. */
export const MessageCenterIcon = navGlyph(
  "MessageCenterIcon",
  <path d="M7 5.4h10a3.6 3.6 0 0 1 3.6 3.6v2.4a3.6 3.6 0 0 1-3.6 3.6h-4.4l-4.2 3.6v-3.6H7a3.6 3.6 0 0 1-3.6-3.6V9A3.6 3.6 0 0 1 7 5.4Z" />,
)

/** 评价口碑 — a star, drawn on the grid rather than borrowing a stock one. */
export const OpsVoiceIcon = navGlyph(
  "OpsVoiceIcon",
  <path d="M12 4 14.29 9.64 20.37 10.08 15.71 14.01 17.17 19.92 12 16.7 6.83 19.92 8.29 14.01 3.63 10.08 9.71 9.64Z" />,
)

/** 委托订单 — a factory: the destination goods are delegated to for production. */
export const DelegateNavIcon = navGlyph(
  "DelegateNavIcon",
  <>
    <path d="M3.4 19.4h17.2" />
    <path d="M5.4 19.4V9.6l4.3 2.7V9.6l4.3 2.7V5.4l4.6 2.9v11.1" />
    <path d="M8.2 16.2h1.8M12.8 16.2h1.8" />
  </>,
)
