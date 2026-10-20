/**
 * One vocabulary for the settings sheet's sections.
 *
 * The rail, the pane resolver, the admin surface's section list, its search and
 * the `/admin?settings=<id>` URL all read this table, so a section is named
 * once. Icons and pane bodies stay with the dialog: this module is the same
 * kind of authority as [app-screens](./app-screens.ts) — no React, no imports
 * from components.
 *
 * Which rows a rank may open is decided here too (`settingsRowsFor`), so the
 * super_admin-only platform-management rule has one spelling.
 */
import { isPlatformSuperAdminRole } from "./platform-role"

export type SettingsSectionMeta = {
  id: string
  group: string
  label: string
  /** The rail's first entry is the account itself: avatar + "账号" label. */
  account?: boolean
  /** Platform administration — only mounted for super_admin sessions. */
  admin?: boolean
  /**
   * Wide panes keep the sheet's full width — rosters, comparison tables and
   * admin surfaces need the room. Default panes center their column at a
   * settings-page reading width with side margins.
   */
  wide?: boolean
  title: string
  description?: string
}

/**
 * Rail order is table order; the rail groups consecutive rows by `group`.
 * Three groups — 个人 / 工作空间 / 平台管理 — so no header labels one row.
 */
export const SETTINGS_SECTIONS = [
  {
    id: "account",
    group: "个人",
    label: "账号",
    account: true,
    title: "账号",
    description: "头像、名字与登录密码",
  },
  {
    id: "notifications",
    group: "个人",
    label: "通知",
    title: "通知",
    description: "邀请、任务与状态更新都在通知中心",
  },
  {
    id: "appearance",
    group: "个人",
    label: "外观",
    title: "外观",
    description: "此设备上的控制台主题",
  },
  {
    id: "storage",
    group: "个人",
    label: "本机存储",
    title: "本机存储",
    description: "此浏览器保存的模板、切片与本地缓存",
  },
  {
    id: "workspace",
    group: "工作空间",
    label: "团队协作区",
    wide: true,
    title: "团队协作区",
    description: "管理此工作空间的成员、邀请与资料",
  },
  {
    id: "plans",
    group: "工作空间",
    label: "升级方案",
    wide: true,
    title: "升级方案",
    description: "成员名额、店铺位与计费说明",
  },
  {
    id: "mcp",
    group: "工作空间",
    label: "MCP",
    title: "MCP",
    description: "申请和管理智能体令牌，权限随当前角色决定",
  },
  {
    // 用户, not 账号: the personal 账号 row sits in the same rail and search.
    id: "users",
    group: "平台管理",
    label: "用户",
    admin: true,
    wide: true,
    title: "用户",
    description: "平台账号、工作空间与权益",
  },
  {
    id: "supplier-accounts",
    group: "平台管理",
    label: "厂家账号",
    admin: true,
    wide: true,
    title: "厂家账号",
    description: "管理厂家成员账号、登录状态与排单权限",
  },
  {
    id: "ocr",
    group: "平台管理",
    label: "OCR",
    admin: true,
    wide: true,
    title: "OCR",
    description: "识图模型与定价",
  },
  {
    id: "ai-accounts",
    group: "平台管理",
    label: "AI 账号池",
    admin: true,
    wide: true,
    title: "AI 账号池",
    description: "填写密钥、选择模型、启停并测试连接",
  },
  {
    id: "media",
    group: "平台管理",
    label: "对象存储",
    admin: true,
    wide: true,
    title: "对象存储",
    description: "S3 兼容对象存储与媒体源站",
  },
  {
    id: "payment",
    group: "平台管理",
    label: "支付",
    admin: true,
    wide: true,
    title: "支付",
    description: "收款渠道、商户凭证与回调地址",
  },
  {
    // Network proxy, not 代理 (the sales-agent pane below).
    id: "proxy",
    group: "平台管理",
    label: "网络代理",
    admin: true,
    wide: true,
    title: "网络代理",
    description: "Ozon Seller API 经选中的 VLESS 节点出站，节点不可用时自动直连",
  },
  {
    id: "prompts",
    group: "平台管理",
    label: "提示词",
    admin: true,
    wide: true,
    title: "提示词",
    description: "批量维护平台货源已提交的提示词",
  },
  {
    id: "banned-tags",
    group: "平台管理",
    label: "受限标签",
    admin: true,
    wide: true,
    title: "受限标签",
    description: "全平台禁止出现在商品标签里的词，保存和推送 Ozon 前都会拦截",
  },
  {
    id: "categories",
    group: "平台管理",
    label: "类目",
    admin: true,
    wide: true,
    title: "类目抓取",
    description: "平台密钥与每日自动抓取",
  },
  {
    id: "redeem-codes",
    group: "平台管理",
    label: "兑换",
    admin: true,
    wide: true,
    title: "兑换",
    description: "兑换码的生成与核销",
  },
  {
    id: "agents",
    group: "平台管理",
    label: "代理",
    admin: true,
    wide: true,
    title: "代理",
    description: "平台代理与返佣结算",
  },
  {
    id: "admin-logs",
    group: "平台管理",
    label: "日志",
    admin: true,
    wide: true,
    title: "日志",
    description: "平台 API 请求与异常记录，仅保留最近 30 天；计费账本不受清理影响",
  },
  {
    id: "plan-orders",
    group: "平台管理",
    label: "订单",
    admin: true,
    wide: true,
    title: "订单",
    description: "加购订单与支付状态",
  },
] as const satisfies readonly SettingsSectionMeta[]

export type SettingsSection = (typeof SETTINGS_SECTIONS)[number]["id"]

/**
 * The table with every optional flag resolved. Consumers that read
 * `account`/`admin`/`wide` take this view so a terse table entry never turns
 * into a union member without the property — the literal ids stay derived from
 * the table above.
 */
export type SettingsSectionRow = SettingsSectionMeta & {
  id: SettingsSection
  account: boolean
  admin: boolean
  wide: boolean
}

export const SETTINGS_ROWS: readonly SettingsSectionRow[] = SETTINGS_SECTIONS.map(
  (section) => ({ account: false, admin: false, wide: false, ...section }),
)

/** The panes only a PlatformRole `super_admin` session may mount. */
export const ADMIN_SETTINGS_ROWS = SETTINGS_ROWS.filter((row) => row.admin)

/**
 * The rows a rank may open: platform management is a `super_admin` surface.
 *
 * An `admin` rank runs the main-menu platform screens (货源管理 on `/admin`,
 * gated by `isPlatformStaffRole` and Cloud's `require_platform_staff`), but
 * never these panes — that split is one function so the rail, the sheet's
 * search, the pane resolver and the admin surface's own rail cannot drift
 * apart.
 */
export function settingsRowsFor(
  role: string | null | undefined,
): readonly SettingsSectionRow[] {
  return isPlatformSuperAdminRole(role) ? SETTINGS_ROWS : SETTINGS_ROWS.filter((row) => !row.admin)
}

/** The platform-management rows this rank may open; empty for everyone else. */
export function adminSettingsRowsFor(
  role: string | null | undefined,
): readonly SettingsSectionRow[] {
  return isPlatformSuperAdminRole(role) ? ADMIN_SETTINGS_ROWS : []
}

export function isSettingsSection(value: string): value is SettingsSection {
  return SETTINGS_ROWS.some((row) => row.id === value)
}

export type SettingsPaneResolution =
  | { kind: "pane"; section: SettingsSection }
  | { kind: "refused"; section: SettingsSection }

/**
 * Which pane the sheet paints for a requested section.
 *
 * The workbench opens the sheet only from controls that already know what the
 * actor may see, so an unavailable section there keeps the old 账号 fallback.
 * The admin surface is addressed by URL: a link naming a section this actor may
 * not see must refuse rather than silently paint a different one.
 */
export function resolveSettingsPane(input: {
  requested: SettingsSection
  available: readonly SettingsSectionRow[]
  adminSurface: boolean
}): SettingsPaneResolution {
  if (input.available.some((row) => row.id === input.requested)) {
    return { kind: "pane", section: input.requested }
  }
  return input.adminSurface
    ? { kind: "refused", section: input.requested }
    : { kind: "pane", section: "account" }
}