/** Navigation metadata stays independent of React and screen implementations. */
type ScreenMeta = {
  label: string
  /** Cross-tenant observation is only addressable on /admin by super_admin. */
  superAdminOnly?: boolean
}

export const SCREEN_META = {
  home: { label: "工作台" },
  console: { label: "经营数据" },
  listing: { label: "批量上架" },
  catalog: { label: "平台商品库" },
  products: { label: "我的商品" },
  "task-records": { label: "任务记录" },
  "supplier-dbs": { label: "平台商品库管理" },
  "supplier-catalog": { label: "商品维护" },
  "supplier-accounts": { label: "工厂管理" },
  "admin-delegate-orders": { label: "委托单" },
  "admin-console": { label: "平台数据大屏", superAdminOnly: true },
  "admin-products": { label: "全部 Ozon 商品", superAdminOnly: true },
  "message-center": { label: "客服消息" },
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
