/** The global library cache follows committed account authority even while its screen is closed. */
import { peekAccountOverview, subscribeAccountOverview } from "@/features/account/account-overview-cache"
import { isPlatformStaffRole } from "@/lib/platform-role"
import type { SupplierDbsStore } from "./supplier-dbs-model"

export function bindSupplierDbsAuthority(store: SupplierDbsStore): void {
  const snapshot = () => {
    const overview = peekAccountOverview()
    if (!overview?.session.authenticated) return null
    const identity = overview.accounts?.find((account) => account.active)?.uuid ?? overview.session.email
    return identity ? { key: `${identity}:${overview.session.role ?? ""}`, role: overview.session.role } : null
  }
  let authority = snapshot()?.key ?? null
  // This subscription belongs to the singleton's lifetime; logout separately sweeps its session cache.
  subscribeAccountOverview(() => {
    const next = snapshot()
    if ((next?.key ?? null) === authority) return
    authority = next?.key ?? null
    const previouslyLoaded = store.getState().status !== "idle"
    store.reset()
    if (previouslyLoaded && isPlatformStaffRole(next?.role)) void store.loadList()
  })
}
