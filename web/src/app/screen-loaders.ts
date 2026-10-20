import type { AppScreen } from "@/lib/app-screens"

/**
 * One statically analyzable import map for every production screen.
 * Hover/focus prefetch and `lazy()` both go through this object so a
 * `import(pathVariable)` cannot widen the bundle.
 */
export const SCREEN_LOADERS = {
  console: () => import("@/features/console/console-screen"),
  "admin-console": () => import("@/features/platform-observation/admin-console-screen"),
  "admin-products": () => import("@/features/platform-observation/admin-products-screen"),
  listing: () => import("@/features/workflow/workflow-screen-entry"),
  catalog: () => import("@/features/supply-chain/catalog-screen"),
  "supplier-dbs": () => import("@/features/supplier-dbs/supplier-dbs-screen"),
  "supplier-accounts": () => import("@/features/supplier/admin-supplier-accounts-screen"),
  "admin-delegate-orders": () =>
    import("@/features/delegate/admin-delegate-orders-screen"),
  "message-center": () => import("@/features/message-center/message-center-screen"),
  products: () => import("@/features/products/products-screen"),
  "ops-shipping": () => import("@/features/ops/shipping/shipping-screen"),
  "delegate-orders": () => import("@/features/delegate/delegate-screen"),
  "ops-returns": () => import("@/features/ops/returns/returns-screen"),
  "ops-supply": () => import("@/features/ops/supply/supply-screen"),
  "ops-voice": () => import("@/features/ops/voice/voice-screen"),
  stores: () => import("@/features/stores/stores-screen"),

  notifications: () => import("@/features/notifications/notifications-screen"),

  usage: () => import("@/features/usage/usage-screen"),

  agent: () => import("@/features/agents/agent-center-screen"),
} as const satisfies Record<AppScreen, () => Promise<unknown>>

export function preloadScreen(screen: AppScreen): void {
  void SCREEN_LOADERS[screen]()
}

/**
 * The notification centre floats over the shell — a pane, not a screen — but
 * it stays lazy for the same reason: nothing pays for it until the bell asks.
 */
export const loadNotificationsDialog = () =>
  import("@/features/notifications/notifications-dialog")
