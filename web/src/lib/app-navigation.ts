import {
  AdminNavIcon,
  AgentNavIcon,
  CatalogIcon,
  ConsoleIcon,
  ListingIcon,
  MessageCenterIcon,
  OpsNavIcon,
  OpsReturnsIcon,
  OpsShippingIcon,
  DelegateNavIcon,
  OpsSupplyIcon,
  OpsVoiceIcon,
  ProductsIcon,
  SupplierDbsIcon,
  WorkbenchNavIcon,
  type NavIcon,
} from "./nav-icons"
import { isObservationScreen, type AppScreen } from "./app-screens"

/**
 * One sidebar destination. `agentOnly` entries stay in the static list — so
 * the mode/cursor arithmetic is the same for everyone — and are filtered out
 * of the painted list unless the account is an Agent.
 */
export type NavItem = {
  id: AppScreen
  icon: NavIcon
  agentOnly?: boolean
}

/** A nav mode's header facts. `staffOnly` gates the whole mode, not one item. */
export type NavModeMeta = {
  label: string
  icon: NavIcon
  /** Staff-only modes are filtered out of the switcher and the painted list. */
  staffOnly?: boolean
}

/** The first item is the destination when a mode has no previously visited screen. */
export const NAVIGATION = {
  workbench: {
    label: "工作台", icon: WorkbenchNavIcon, staffOnly: false,
    items: [
      { id: "console", icon: ConsoleIcon },
      { id: "listing", icon: ListingIcon },
      { id: "catalog", icon: CatalogIcon },
      { id: "products", icon: ProductsIcon },
      { id: "agent", icon: AgentNavIcon, agentOnly: true },
    ],
  },
  ops: {
    label: "履约", icon: OpsNavIcon, staffOnly: false,
    items: [
      { id: "ops-shipping", icon: OpsShippingIcon },
      { id: "delegate-orders", icon: DelegateNavIcon },
      { id: "ops-returns", icon: OpsReturnsIcon },
      { id: "ops-supply", icon: OpsSupplyIcon },
      { id: "message-center", icon: MessageCenterIcon },
      { id: "ops-voice", icon: OpsVoiceIcon },
    ],
  },
  admin: {
    label: "平台", icon: AdminNavIcon, staffOnly: true,
    items: [
      { id: "supplier-dbs", icon: SupplierDbsIcon },
      { id: "admin-console", icon: ConsoleIcon },
      { id: "admin-products", icon: ProductsIcon },
    ],
  },
} as const satisfies Record<string, NavModeMeta & {
  items: readonly [NavItem, ...NavItem[]]
}>

export type NavMode = keyof typeof NAVIGATION
export const NAV_MODES = Object.keys(NAVIGATION) as NavMode[]

/** Modes this account may see in the switcher and paint in the sidebar. */
export function navModesFor(audience: NavAudience): NavMode[] {
  return NAV_MODES.filter((mode) => !NAVIGATION[mode].staffOnly || audience.isStaff)
}

/**
 * The staff-only modes themselves. The admin surface (`/admin`) is that list
 * and nothing else: one boundary, one audience, no Workspace-mode arithmetic
 * leaking into it.
 */
export function staffNavModes(): NavMode[] {
  return NAV_MODES.filter((mode) => NAVIGATION[mode].staffOnly)
}

/** Staff routes reached from shortcuts instead of a sidebar row. */
export const ADMIN_URL_ONLY_SCREENS = [
  "supplier-accounts",
  "admin-delegate-orders",
] as const satisfies readonly AppScreen[]

export function modeOfScreen(screen: AppScreen): NavMode | undefined {
  return NAV_MODES.find((mode) => NAVIGATION[mode].items.some((item) => item.id === screen))
}

export type NavAudience = {
  isAgent: boolean
  isStaff: boolean
  /** Absent/unknown ranks cannot address cross-tenant observation. */
  isSuperAdmin?: boolean
}

/** The destinations a mode paints for this account: staff-only modes paint nothing without staff; Agent-only entries are filtered out. */
export function navItemsFor(mode: NavMode, audience: NavAudience): NavItem[] {
  if (NAVIGATION[mode].staffOnly && !audience.isStaff) return []
  return NAVIGATION[mode].items.filter(
    (item: NavItem) =>
      (!item.agentOnly || audience.isAgent) &&
      (!isObservationScreen(item.id) || audience.isSuperAdmin === true),
  )
}

/**
 * The two addressable surfaces. `/` is the workbench, `/admin` the platform
 * surface; each owns its own gate, nav and address ([admin-surface](./admin-surface.ts)).
 */
export type Surface = "workbench" | "admin"

/**
 * Workbench screens that have an address but no sidebar row: the Workspace
 * switcher, the wallet chip and the notification bell each navigate to one.
 */
export function spaceScreens(): AppScreen[] {
  return ["stores", "usage", "notifications"]
}

/**
 * Every screen a surface may address for this audience, in nav order; the first
 * entry is that surface's default screen.
 *
 * This is the address-level counterpart of `navItemsFor`: the sidebar paints
 * this list and the route resolver refuses everything outside it, so a URL can
 * never mount a destination the rank cannot address. The surface guard still
 * refuses non-staff at /admin; per-screen filtering refuses cross-tenant
 * observation to ordinary admin. Those screens live only on /admin, even
 * when the workbench sidebar offers a cross-surface shortcut.
 */
export function addressableScreens(surface: Surface, audience: NavAudience): AppScreen[] {
  if (surface === "admin") {
    if (!audience.isStaff) return []
    return [
      ...staffNavModes().flatMap((mode) => navItemsFor(mode, audience).map((item) => item.id)),
      ...ADMIN_URL_ONLY_SCREENS,
    ]
  }
  return NAV_MODES.filter((m) => !NAVIGATION[m].staffOnly || audience.isStaff)
    .flatMap((mode) => navItemsFor(mode, audience).map((item) => item.id))
    .filter((id) => !isObservationScreen(id))
    .concat(spaceScreens())
}

export function isAddressableScreen(
  screen: AppScreen,
  surface: Surface,
  audience: NavAudience,
): boolean {
  return addressableScreens(surface, audience).includes(screen)
}

/** Where a surface lands when its address names nothing — or nothing it may. */
export function defaultScreenFor(surface: Surface, audience: NavAudience): AppScreen {
  return addressableScreens(surface, audience)[0] ?? "console"
}
