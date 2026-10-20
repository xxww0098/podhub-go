/** Navigation metadata stays independent of React and screen implementations. */
type ScreenMeta = {
  label: string
  /** Cross-tenant observation is only addressable on /admin by super_admin. */
  superAdminOnly?: boolean
}

export const SCREEN_META = {
  console: { label: "数据大屏" },
  listing: { label: "批量上架" },
  catalog: { label: "平台货源" },
  "supplier-dbs": { label: "货源管理" },
  "supplier-accounts": { label: "厂家账号" },
  "admin-delegate-orders": { label: "委托单" },
  "admin-console": { label: "平台数据大屏", superAdminOnly: true },
  "admin-products": { label: "平台店铺商品", superAdminOnly: true },
  "message-center": { label: "客服消息" },
  products: { label: "店铺商品" },
  "ops-shipping": { label: "订单发货" },
  "delegate-orders": { label: "委托订单" },
  "ops-returns": { label: "售后退货" },
  "ops-supply": { label: "入仓供货" },
  "ops-voice": { label: "评价口碑" },
  stores: { label: "店铺" },
  notifications: { label: "通知" },
  usage: { label: "用量" },
  agent: { label: "代理中心" },
} satisfies Record<string, ScreenMeta>

export type AppScreen = keyof typeof SCREEN_META

export function isObservationScreen(screen: AppScreen): boolean {
  return (SCREEN_META[screen] as ScreenMeta).superAdminOnly === true
}

export const SCREEN_LABELS: Record<AppScreen, string> = Object.fromEntries(
  Object.entries(SCREEN_META).map(([id, meta]) => [id, meta.label]),
) as Record<AppScreen, string>

export type WorkspaceSpaceScreen = "stores" | "usage"

export function isWorkspaceSpaceScreen(screen: AppScreen): screen is WorkspaceSpaceScreen {
  return screen === "stores" || screen === "usage"
}
