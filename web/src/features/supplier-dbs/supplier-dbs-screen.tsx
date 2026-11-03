/** One product table; factories are configured separately before product creation. */
import "./supplier-dbs.css"
import { useEffect, useState } from "react"
import { RotateCcw, ShieldAlert, Unplug } from "lucide-react"
import { useAccountOverview } from "@/features/account/account-overview-cache"
import { isPlatformStaffRole, isPlatformSuperAdminRole } from "@/lib/platform-role"
import { Empty, EmptyContent, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import { IconButton } from "@/components/ui/icon-button"
import { Spinner } from "@/components/ui/spinner"
import { clearLive, notifyLive } from "@/lib/notify"
import { SupplierProductsView } from "./supplier-db-table"
import { SupplierLibraryManagement } from "./supplier-library-management"
import { supplierDbs, useSupplierDbsStore, type SupplierDbsStore } from "./supplier-dbs-store"

const LIST_READ_LIVE = "supplier-dbs-read"

type SupplierDbsScreenProps = {
  role?: string | null
  accountUuid?: string
  store?: SupplierDbsStore
}

export function SupplierDbsScreen({ role, accountUuid, store }: SupplierDbsScreenProps) {
  const overview = useAccountOverview()
  const rolePending = role === undefined && overview === null
  const resolvedRole = role ?? overview?.session.role
  const staff = isPlatformStaffRole(resolvedRole)
  const superAdmin = isPlatformSuperAdminRole(resolvedRole)
  const identity = accountUuid ?? overview?.session.uuid ?? overview?.session.email ?? "injected"
  const authority = `${identity}:${resolvedRole ?? "pending"}`
  const [committedAuthority, setCommittedAuthority] = useState(authority)
  const authorityCurrent = authority === committedAuthority
  const storeRef = store ?? supplierDbs
  const owned = store === undefined
  const state = useSupplierDbsStore(storeRef)
  const [managing, setManaging] = useState(false)

  useEffect(() => {
    if (rolePending || authorityCurrent) return
    if (!owned) storeRef.reset()
    setCommittedAuthority(authority)
    if (staff && (!owned || storeRef.getState().status === "idle")) void storeRef.loadList()
  }, [authority, authorityCurrent, rolePending, staff, owned, storeRef])
  useEffect(() => {
    if (owned && staff && authorityCurrent && state.status === "idle") void storeRef.loadList()
  }, [owned, staff, authorityCurrent, state.status, storeRef])

  const sourceIds = state.dbs.map((db) => db.sourceId).join(",")
  // shortcut: 单表复用各工厂明细读取，数据量增大时改为服务端聚合分页。
  useEffect(() => {
    if (!staff || !authorityCurrent || state.status !== "ready") return
    for (const sourceId of sourceIds.split(",").filter(Boolean)) {
      if (!storeRef.getState().details[sourceId]) void storeRef.loadDetail(sourceId)
    }
  }, [staff, authorityCurrent, state.status, sourceIds, storeRef])

  useEffect(() => {
    if (!staff || !authorityCurrent || state.status !== "error") { clearLive(LIST_READ_LIVE); return }
    notifyLive({ id: LIST_READ_LIVE, type: "error", reason: state.reason, title: "读不到平台商品库", description: state.error,
      action: { label: "重试", onClick: () => void storeRef.loadList() } })
    return () => clearLive(LIST_READ_LIVE)
  }, [staff, authorityCurrent, state.status, state.reason, state.error, storeRef])

  if (rolePending || !authorityCurrent || staff && !managing && state.status !== "ready" && state.status !== "error") {
    return <div className="grid min-h-48 place-items-center" data-supplier-dbs="loading"><Spinner aria-label="正在加载平台商品库" /></div>
  }
  if (!staff) return <Empty role="status" className="min-h-48" data-supplier-dbs="forbidden"><EmptyHeader><EmptyMedia variant="icon"><ShieldAlert /></EmptyMedia><EmptyTitle>仅平台管理员可以维护平台商品库</EmptyTitle></EmptyHeader></Empty>
  if (managing) return <SupplierLibraryManagement store={storeRef} superAdmin={superAdmin} onBack={() => setManaging(false)} />
  if (state.status === "error") return <Empty role="status" className="min-h-48" data-supplier-dbs="error"><EmptyHeader><EmptyMedia variant="icon"><Unplug /></EmptyMedia><EmptyTitle>读不到平台商品库</EmptyTitle></EmptyHeader><EmptyContent><IconButton icon={RotateCcw} label="重试" variant="outline" onClick={() => void storeRef.loadList()} /></EmptyContent></Empty>

  const details = state.dbs.flatMap((db) => state.details[db.sourceId]?.detail ? [state.details[db.sourceId].detail!] : [])
  const loading = state.dbs.some((db) => !state.details[db.sourceId] || ["idle", "loading"].includes(state.details[db.sourceId].status))
  const failed = state.dbs.filter((db) => state.details[db.sourceId]?.status === "error")
  return <div key={authority} className="supplier-workspace flex min-h-0 min-w-0 flex-1 flex-col" data-supplier-dbs="manage">
    <SupplierProductsView store={storeRef} dbs={state.dbs} details={details} loading={loading} failedFactories={failed} showCreator={superAdmin}
      onRetry={() => { for (const db of failed) void storeRef.loadDetail(db.sourceId, { force: true }) }}
      onManageFactories={() => setManaging(true)} />
  </div>
}
