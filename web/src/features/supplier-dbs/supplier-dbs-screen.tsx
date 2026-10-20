/**
 * 平台货源 — 管理端 master-detail 屏：左栏 SupplierDbRail（库列表常驻），
 * 右栏 SupplierDbDetailView（选中库的商品表）。没有「未选中」中间页——
 * 地址缺 `?open=` 或 `open` 指向已不存在的库时，回落到列表首库并回写地址。
 *
 * 打开的库是地址态（`?open=`，见 supplier-db-nav）：侧栏卡片点击、建库直达与
 * `?open=` 深链都只是改地址，刷新/分享/复制链接因此停在同一个库页；
 * `initialSourceId` 只是测试注入打开态的缝（测试时不做地址回落）。
 * 可见性是 `admin` 秩及以上（`isPlatformStaffRole`）；主菜单屏已拦一次，
 * 这里是兜底。
 *
 * 增删改查闭环：建/改走屏级 SupplierDbFormDialog（侧栏「新建平台货源」与
 * 库页「库设置 → 编辑库信息」共用一条路径）；删库在库页「库设置 → 删除库」
 * 自含确认框；行级操作与属性管理都在库页内。
 */
import { useCallback, useEffect, useRef, useState } from "react"
import { ShieldAlert, Unplug } from "lucide-react"

import { useAccountOverview } from "@/features/account/account-overview-cache"
import { isPlatformStaffRole, isPlatformSuperAdminRole } from "@/lib/platform-role"
import { replaceAddress } from "@/lib/address"
import { withScreen } from "@/lib/admin-surface"
import { useAddress } from "@/hooks/use-address"
import { ConfirmDialog } from "@/components/ui/confirm-dialog"
import { Button } from "@/components/ui/button"
import {
  Empty,
  EmptyContent,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty"
import { Spinner } from "@/components/ui/spinner"
import { clearLive, notifyCommandError, notifyLive, notifySuccess } from "@/lib/notify"

import { SupplierDbScope, supplierDbsInScope } from "./supplier-db-scope"
import { commandFailure } from "./supplier-dbs-errors"
import { IssuedSupplierPassword } from "./supplier-issued-password"
import { SupplierDbEmptyState, SupplierDbRail } from "./supplier-db-list"
import { SupplierDbFormDialog, type DbEditor } from "./supplier-db-form-dialog"
import { SupplierDbDetailView } from "./supplier-db-table"
import {
  EMPTY_DB_DRAFT,
  supplierDbs,
  useSupplierDbsStore,
  type SupplierDbDetailState,
  type SupplierDbsState,
  type SupplierDbsStore,
} from "./supplier-dbs-store"
import { openSupplierDbId, writeOpenSupplierDb } from "./supplier-db-nav"

const LIST_READ_LIVE = "supplier-dbs-read"
const DETAIL_READ_LIVE = "supplier-dbs-detail-read"

type SupplierDbsScreenProps = {
  /** Tests inject a role; production reads the session snapshot. */
  role?: string | null
  /** Identity injection for session-boundary regression fixtures. */
  accountUuid?: string
  /** Tests inject a store already loaded from an in-memory client. */
  store?: SupplierDbsStore
  /** Test seam: paint with this database open, whatever the address says. */
  initialSourceId?: string | null
}

export function SupplierDbsScreen({
  role,
  accountUuid,
  store,
  initialSourceId = null,
}: SupplierDbsScreenProps) {
  const overview = useAccountOverview()
  // No injected role + overview still loading → wait rather than flash the gate.
  const rolePending = role === undefined && overview === null
  const resolvedRole = role ?? overview?.session.role
  const staff = isPlatformStaffRole(resolvedRole)
  const superAdmin = isPlatformSuperAdminRole(resolvedRole)
  const identity = accountUuid ?? overview?.accounts?.find((account) => account.active)?.uuid ?? overview?.session.email ?? "injected"
  const authority = `${identity}:${resolvedRole ?? "pending"}`
  const [committedAuthority, setCommittedAuthority] = useState(authority)
  const authorityCurrent = authority === committedAuthority
  const [creatorScope, setCreatorScope] = useState("all")
  const storeRef = store ?? supplierDbs
  const owned = store === undefined
  const state = useSupplierDbsStore(storeRef)
  // 打开的库读地址本身，没有第二份导航态可漂移：刷新、分享与复制链接都停在
  // 同一个库页；侧栏换库只改地址。
  const address = useAddress()
  const requestedId = initialSourceId ?? openSupplierDbId(address.search)

  // master-detail 没有「未选中」页：列表就绪后，未选/失效的选中一律回落
  // 首库并回写地址。测试注入的 initialSourceId 不做回落。
  const visibleDbs = supplierDbsInScope(state.dbs, superAdmin ? creatorScope : "all")
  const listReady = authorityCurrent && state.status === "ready"
  const requestedKnown =
    requestedId !== null &&
    visibleDbs.some((db) => db.sourceId === requestedId)
  const selectedId = requestedKnown ? requestedId : listReady ? (visibleDbs[0]?.sourceId ?? null) : null

  useEffect(() => {
    if (rolePending || authorityCurrent) return
    // Reset fences all cached data and in-flight replies from the prior account/role.
    if (!owned) storeRef.reset()
    setCreatorScope("all")
    setCommittedAuthority(authority)
    if (staff && (!owned || storeRef.getState().status === "idle")) void storeRef.loadList()
  }, [authority, authorityCurrent, rolePending, staff, owned, storeRef])

  useEffect(() => {
    if (!listReady || initialSourceId !== null) return
    if (selectedId !== requestedId) writeOpenSupplierDb(selectedId)
  }, [listReady, selectedId, requestedId, initialSourceId])

  const detailState = selectedId ? state.details[selectedId] : undefined

  useEffect(() => {
    if (owned && staff && authorityCurrent && storeRef.getState().status === "idle") {
      void storeRef.loadList()
    }
  }, [owned, staff, authorityCurrent, state.status, storeRef])

  // 非 staff 的 `?screen=supplier-dbs&open=` 深链只吃拦截页：不读管理面、
  // 不弹常驻报错、不发面包屑段。失效 id 等回落生效，不抢网络。
  useEffect(() => {
    if (!staff || !authorityCurrent || !selectedId) return
    if (listReady && !requestedKnown && initialSourceId === null) return
    void storeRef.loadDetail(selectedId)
  }, [staff, authorityCurrent, selectedId, storeRef, listReady, requestedKnown, initialSourceId])

  // The failure copy rides the persistent toast host; the pane keeps the icon
  // and the retry so a read failure is still actionable.
  useEffect(() => {
    if (!staff || !authorityCurrent || state.status !== "error") {
      clearLive(LIST_READ_LIVE)
      return
    }
    notifyLive({
      id: LIST_READ_LIVE,
      type: "error",
      reason: state.reason,
      title: "读不到平台货源",
      description: state.error,
      action: { label: "重试", onClick: () => void storeRef.loadList() },
    })
    return () => clearLive(LIST_READ_LIVE)
  }, [staff, authorityCurrent, state.status, state.error, state.reason, storeRef])

  useEffect(() => {
    if (!staff || !authorityCurrent || detailState?.status !== "error") {
      clearLive(DETAIL_READ_LIVE)
      return
    }
    notifyLive({
      id: DETAIL_READ_LIVE,
      type: "error",
      reason: detailState.reason,
      title: "读不到库内容",
      description: detailState.error,
      action: {
        label: "重试",
        onClick: () =>
          selectedId &&
          void storeRef.loadDetail(selectedId, { force: true }),
      },
    })
    return () => clearLive(DETAIL_READ_LIVE)
  }, [staff, authorityCurrent, detailState?.status, detailState?.error, detailState?.reason, selectedId, storeRef])

  if (rolePending || !authorityCurrent) {
    return (
      <div className="grid min-h-48 place-items-center" data-supplier-dbs="loading">
        <Spinner aria-label="正在加载平台货源" className="size-5" />
      </div>
    )
  }

  if (!staff) {
    return (
      <Empty role="status" className="min-h-48" data-supplier-dbs="forbidden">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <ShieldAlert />
          </EmptyMedia>
          <EmptyTitle>仅平台管理员可以维护平台货源</EmptyTitle>
        </EmptyHeader>
      </Empty>
    )
  }

  if (state.status === "error") {
    return (
      <Empty role="status" className="min-h-48" data-supplier-dbs="error">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <Unplug />
          </EmptyMedia>
          <EmptyTitle>读不到平台货源</EmptyTitle>
        </EmptyHeader>
        <EmptyContent>
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="cursor-pointer"
            onClick={() => void storeRef.loadList()}
          >
            重试
          </Button>
        </EmptyContent>
      </Empty>
    )
  }

  if (state.status !== "ready") {
    return (
      <div className="grid min-h-48 place-items-center" data-supplier-dbs="loading">
        <Spinner aria-label="正在加载平台货源" className="size-5" />
      </div>
    )
  }

  return (
    <SupplierDbManage
      key={authority}
      store={storeRef}
      state={{ ...state, dbs: visibleDbs }}
      allDbs={state.dbs}
      creatorScope={creatorScope}
      onScopeChange={setCreatorScope}
      selectedId={selectedId}
      detailState={detailState}
      canRebind={isPlatformSuperAdminRole(resolvedRole)}
    />
  )
}

/**
 * master-detail 宿主 — 只在库列表 ready 后挂载。侧栏常驻导航；右栏按
 * selectedId 换库表格/加载/错误，全空时给建库空态。建库对话框在这里
 * （侧栏底钮、侧栏双击与库页「编辑库信息」共用一条创建/编辑路径）。
 */
function SupplierDbManage({
  store,
  state,
  selectedId,
  detailState,
  canRebind,
  allDbs,
  creatorScope,
  onScopeChange,
}: {
  store: SupplierDbsStore
  state: SupplierDbsState
  selectedId: string | null
  detailState: SupplierDbDetailState | undefined
  canRebind: boolean
  allDbs: SupplierDbsState["dbs"]
  creatorScope: string
  onScopeChange: (scope: string) => void
}) {
  // 建库 / 改库共用一条对话框路径；editor.sourceId 区分 create 与 edit。
  const active = useRef(true)
  const currentScope = useRef(creatorScope)
  currentScope.current = creatorScope
  useEffect(() => { active.current = true; return () => { active.current = false } }, [])
  const [editor, setEditor] = useState<DbEditor | null>(null)
  const [editorBusy, setEditorBusy] = useState(false)
  const [issuedPassword, setIssuedPassword] = useState<{
    email: string
    password: string
  }>()
  const detail = selectedId && detailState?.detail?.db.sourceId === selectedId ? detailState.detail : undefined
  const [promptDirty, setPromptDirty] = useState(false)
  const [navigation, setNavigation] = useState<(() => void) | null>(null)
  const requestNavigation = (action: () => void) => {
    if (promptDirty) setNavigation(() => action)
    else action()
  }
  const selectDb = (sourceId: string) => {
    if (sourceId !== selectedId) requestNavigation(() => { setPromptDirty(false); writeOpenSupplierDb(sourceId) })
  }
  const selectScope = (scope: string) => {
    if (scope === creatorScope) return
    requestNavigation(() => { setPromptDirty(false); setEditor(null); setEditorBusy(false); setIssuedPassword(undefined); onScopeChange(scope) })
  }

  const openCreate = () => setEditor({ draft: { ...EMPTY_DB_DRAFT } })

  const openEdit = useCallback(
    (sourceId: string) => {
      const db = state.dbs.find((item) => item.sourceId === sourceId)
      if (!db) return
      setEditor({
        sourceId: db.sourceId,
        draft: {
          name: db.name,
          country: db.country,
          contact: db.contact,
          internalNote: db.internalNote,
          listed: db.listed,
          icon: db.icon,
          acceptsDelegate: db.acceptsDelegate ?? false,
          accountEmail: db.accountEmail ?? "",
        },
      })
    },
    [state.dbs],
  )

  const submit = async () => {
    if (!editor) return
    setEditorBusy(true)
    const submittedScope = creatorScope
    const sourceId = editor.sourceId
    const isCreate = sourceId === undefined
    const result = isCreate
      ? await store.createDb(editor.draft)
      : await store.updateDb(sourceId, editor.draft)
    if (!active.current || currentScope.current !== submittedScope) return
    setEditorBusy(false)
    if (result.ok) {
      const issued = result.initialPassword
      const issuedEmail = editor.draft.accountEmail?.trim() ?? ""
      setEditor(null)
      if (isCreate) {
        if (issued) {
          notifySuccess("平台货源已创建")
          setIssuedPassword({ email: issuedEmail, password: issued })
        } else if (issuedEmail) {
          notifySuccess("已绑定已有账号，密码未改")
        } else {
          notifySuccess("平台货源已创建")
        }
        // 建库只是第一步——直达新库，接着添商品行。
        const created = result.value
        requestNavigation(() => {
          setPromptDirty(false)
          if (canRebind && creatorScope !== "all" && created.createdBy !== creatorScope) onScopeChange("all")
          writeOpenSupplierDb(created.sourceId)
        })
      } else {
        const previous = (
          state.dbs.find((item) => item.sourceId === sourceId)?.accountEmail ?? ""
        )
          .trim()
          .toLowerCase()
        const next = issuedEmail.toLowerCase()
        if (issued) {
          notifySuccess("厂家邮箱已换绑")
          setIssuedPassword({ email: issuedEmail, password: issued })
        } else if (next && next !== previous) {
          notifySuccess("已换绑到已有账号，密码未改")
        } else {
          notifySuccess("平台货源已保存")
        }
      }
    } else {
      notifyCommandError(
        commandFailure(result),
        isCreate ? "创建平台货源失败" : "保存平台货源失败",
      )
    }
  }

  return (
    <div
      className="flex min-h-0 min-w-0 flex-1 flex-col"
      data-supplier-dbs="manage"
    >
      <SupplierDbScope superAdmin={canRebind} dbs={allDbs} value={creatorScope} onChange={selectScope} />
      <div className="flex min-h-0 min-w-0 flex-1 flex-col sm:flex-row">
      <SupplierDbRail
        dbs={state.dbs}
        selectedId={selectedId}
        onSelect={selectDb}
        showCreator={canRebind}
        onEdit={openEdit}
        onCreate={openCreate}
      />

      {detail ? (
        <SupplierDbDetailView
          key={`${creatorScope}:${detail.db.sourceId}`}
          store={store}
          detail={detail}
          showCreator={canRebind}
          onDirtyChange={setPromptDirty}
          onExit={() => writeOpenSupplierDb(null)}
          onEditDb={() => selectedId && openEdit(selectedId)}
          onOpenAccounts={() => {
            // 壳层同面跳屏：withScreen 收掉本屏外键、保留 supplier-accounts
            // 自己的 open 键；replaceAddress 通知 React，不做整页刷新。
            const url = new URL(window.location.href)
            url.search = withScreen(url.search, "supplier-accounts")
            replaceAddress(url.href)
          }}
        />
      ) : state.dbs.length === 0 ? (
        <SupplierDbEmptyState onCreate={openCreate} />
      ) : detailState?.status === "error" ? (
        <Empty
          role="status"
          className="min-h-48 flex-1"
          data-supplier-dbs="detail-error"
        >
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <Unplug />
            </EmptyMedia>
            <EmptyTitle>读不到库内容</EmptyTitle>
          </EmptyHeader>
          <EmptyContent>
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="cursor-pointer"
              onClick={() =>
                selectedId && void store.loadDetail(selectedId, { force: true })
              }
            >
              重试
            </Button>
          </EmptyContent>
        </Empty>
      ) : (
        <div
          className="grid min-h-48 flex-1 place-items-center"
          data-supplier-dbs="detail-loading"
        >
          <Spinner
            aria-label="正在加载库"
            className="size-5"
          />
        </div>
      )}

      </div>
      <ConfirmDialog open={navigation !== null} onOpenChange={(open) => { if (!open) setNavigation(null) }} title="提示词尚未保存"
        description="切换库或查看范围会丢弃当前规格未保存的提示词草稿。" confirmText="丢弃草稿并切换"
        onConfirm={() => { const action = navigation; setNavigation(null); action?.() }} />
      <SupplierDbFormDialog
        editor={editor}
        busy={editorBusy}
        canRebind={canRebind}
        boundEmail={
          editor?.sourceId
            ? (state.dbs.find((item) => item.sourceId === editor.sourceId)?.accountEmail ?? "")
            : ""
        }
        onOpenChange={(open) => !open && setEditor(null)}
        onDraftChange={(draft) =>
          setEditor((current) => (current ? { ...current, draft } : current))
        }
        onSubmit={submit}
      />
      <IssuedSupplierPassword
        key={issuedPassword?.password ?? "closed"}
        issued={issuedPassword}
        onClose={() => setIssuedPassword(undefined)}
      />
    </div>
  )
}
