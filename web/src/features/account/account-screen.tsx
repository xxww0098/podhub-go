import { useEffect, useState } from "react"
import type { AccountOverview } from "@/bindings/commands"
import { accountHttp } from "@/bindings/http-account"
import { Database, Eraser, File, Image, Layers3, type LucideIcon } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { ConfirmDialog } from "@/components/ui/confirm-dialog"
import { ChangeNameDialog } from "@/components/change-name-dialog"
import { ChangeEmailDialog } from "@/components/change-email-dialog"
import { IdentityMark } from "@/components/identity-mark"
import { IconButton } from "@/components/ui/icon-button"
import { Spinner } from "@/components/ui/spinner"
import { formatBytes } from "@/lib/format"
import { notifyCommandError, notifySuccess } from "@/lib/notify"
import {
  clearCache,
  clearCacheFamily,
  pinnedSourceUsage,
  usage as deviceStorageUsage,
  usageByFamily,
  type CacheFamilyUsage,
} from "@/render/opfs-cache"
import { root as deviceStorageRoot } from "@/render/opfs-io"
import {
  renameCooldownLabel,
  renameLockedUntil as renameLockedUntilMs,
} from "./name-rules"
import {
  isPlatformStaffRole,
  platformStaffRoleLabel,
  STAFF_RANK_CHIP_CLASS,
} from "@/lib/platform-role"

type AccountProfileSectionProps = {
  overview?: AccountOverview
  onOverviewChange?: (overview: AccountOverview) => void
}
/**
 * The 账号 pane of the settings dialog. Sign-out lives only on the workspace
 * menu; platform integrations live under 平台. The card reports and mutates
 * session identity — avatar, name, staff rank — and nothing else. Standing is
 * refreshed by the settings sheet when it opens, so the card has no 刷新.
 */
export function AccountProfileSection({
  overview,
  onOverviewChange,
}: AccountProfileSectionProps) {
  const [busy, setBusy] = useState(false)
  const [clearAvatarOpen, setClearAvatarOpen] = useState(false)
  const [renameOpen, setRenameOpen] = useState(false)
  const [emailOpen, setEmailOpen] = useState(false)
  const staffLabel = platformStaffRoleLabel(overview?.session.role)
  const renameLockedUntil = renameLockedUntilMs(
    overview?.session.name_changed_at_ms ?? undefined,
  )
  const renameLocked = renameLockedUntil != null && renameLockedUntil > Date.now()

  async function clearAvatar() {
    setBusy(true)
    try {
      const next = await accountHttp.accountClearAvatar()
      onOverviewChange?.(next)
      setClearAvatarOpen(false)
      notifySuccess("头像已清空")
    } catch (reason) {
      notifyCommandError(reason, "无法清空头像，请稍后重试。")
    } finally {
      setBusy(false)
    }
  }

  async function renameAccount(name: string) {
    setBusy(true)
    try {
      const next = await accountHttp.accountRename(name)
      onOverviewChange?.(next)
      setRenameOpen(false)
      notifySuccess("名字已更新")
    } catch (reason) {
      notifyCommandError(reason, "无法修改名字，请稍后重试。")
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex w-full flex-col gap-2">
      {!overview ? (
        <div
          role="status"
          className="grid min-h-48 place-items-center rounded-xl border border-border bg-card text-sm text-muted-foreground"
        >
          <span className="inline-flex items-center gap-2">
            <Spinner className="size-4" />
            正在加载账户状态…
          </span>
        </div>
      ) : (
        <div
          className="flex flex-wrap items-center gap-x-7 gap-y-3 rounded-xl border border-border bg-card p-4 sm:p-6"
          data-platform-staff={isPlatformStaffRole(overview.session.role)}
        >
          <IdentityMark
            kind="user"
            role={overview?.session.role}
            name={overview.session.name ?? overview.session.email ?? ""}
            imageUrl={overview.session.avatar_url}
            className="size-16 shrink-0 sm:size-[5.5rem]"
          />
          <div className="flex min-w-0 flex-1 basis-40 flex-col gap-1 sm:basis-56">
            <p className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
              <span className="break-words text-xl font-semibold leading-tight tracking-[-0.01em]">
                {overview.session.name ?? "—"}
              </span>
              {staffLabel && staffLabel !== overview.session.name?.trim() ? (
                <span className={STAFF_RANK_CHIP_CLASS}>{staffLabel}</span>
              ) : null}
            </p>
            <p className="break-all text-md text-muted-foreground">
              {overview.session.email ?? "—"}
            </p>
          </div>
          <div className="ml-auto flex flex-wrap items-center gap-2">
            <Button variant="outline" size="lg" className="h-11" disabled={busy} onClick={() => setEmailOpen(true)}>
              更换邮箱
            </Button>
            {renameLocked ? (
              <span className="text-meta text-muted-foreground">
                {renameCooldownLabel(renameLockedUntil, Date.now())}
              </span>
            ) : (
              <Button variant="outline" size="lg" className="h-11" disabled={busy} onClick={() => setRenameOpen(true)}>
                修改名字
              </Button>
            )}
            {overview.session.avatar_url ? (
              <IconButton
                icon={Eraser}
                label="清空头像"
                size="icon-sm"
                variant="outline"
                onClick={() => setClearAvatarOpen(true)}
                disabled={busy}
              />
            ) : null}
          </div>
        </div>
      )}

      <ConfirmDialog
        open={clearAvatarOpen}
        onOpenChange={setClearAvatarOpen}
        title="清空头像"
        description="将移除当前账户头像。"
        confirmText="清空"
        busy={busy}
        onConfirm={() => void clearAvatar()}
      />
      <ChangeNameDialog
        open={renameOpen}
        busy={busy}
        currentName={overview?.session.name ?? overview?.session.email ?? ""}
        onOpenChange={setRenameOpen}
        onSubmit={(name) => void renameAccount(name)}
      />
      {emailOpen ? <ChangeEmailDialog open onOpenChange={setEmailOpen} /> : null}
    </div>
  )
}

type DeviceStorage = Awaited<ReturnType<typeof deviceStorageUsage>>
type PinnedSourceUsage = Awaited<ReturnType<typeof pinnedSourceUsage>>

/** The render cache's families, in display order. */
const CACHE_FAMILY_META: Record<string, { label: string; description: string; icon: LucideIcon }> = {
  templates: {
    label: "PSD 模板",
    description: "保留在本机的模板文件，删除后需重新选择",
    icon: File,
  },
  sources: {
    label: "源图",
    description: "已导入的设计图源文件，删除后需重新导入",
    icon: Image,
  },
  renders: {
    label: "切片产物",
    description: "已渲染、尚未投递的切片",
    icon: Layers3,
  },
  "static-slices": {
    label: "静态切片缓存",
    description: "跨商品行复用的静态图层切片",
    icon: Database,
  },
}

interface ClearTarget {
  /** `undefined` is the whole cache; a family name clears just that family. */
  family?: string
  title: string
  description: string
  /** The success toast once the clear lands. */
  done: string
}

/**
 * 本机存储 — what this browser profile holds on the operator's own machine:
 * the OPFS render cache (templates, source images, slices) plus the small
 * localStorage / IndexedDB caches. All of it is rebuildable; Cloud stays the
 * source of truth, so this panel reports and never promises.
 *
 * `undefined` is still loading, `null` is an engine that cannot report — the
 * Chromium-first empty state, not a fabricated zero.
 */
export function DeviceStoragePanel() {
  const [storage, setStorage] = useState<DeviceStorage | null>()
  const [families, setFamilies] = useState<CacheFamilyUsage[] | null>()
  const [pinned, setPinned] = useState<PinnedSourceUsage>()
  const [target, setTarget] = useState<ClearTarget | null>(null)
  const [clearing, setClearing] = useState(false)

  function reload() {
    void deviceStorageUsage().then(setStorage, () => setStorage(null))
    // The survey tolerates an unavailable OPFS root. Probe it first so that
    // an inaccessible cache is not presented as four empty families.
    void deviceStorageRoot().then(usageByFamily).then(setFamilies, () => setFamilies(null))
    // 0 pinned is the honest state until a local row store wires
    // `setPinnedSources` (browser-owned-listing slice 17) — never fabricated.
    void pinnedSourceUsage().then(setPinned, () => setPinned(undefined))
  }

  useEffect(reload, [])

  async function clear() {
    if (!target) return
    setClearing(true)
    try {
      if (target.family) {
        await clearCacheFamily(target.family)
      } else {
        await clearCache()
      }
      notifySuccess(target.done)
      reload()
    } catch (reason) {
      notifyCommandError(reason, "无法清理本机缓存，请稍后重试。")
    } finally {
      setClearing(false)
      setTarget(null)
    }
  }

  if (storage === undefined) {
    return (
      <div role="status" className="flex items-center gap-2 text-sm text-muted-foreground">
        <Spinner className="size-4" />
        正在读取本机存储…
      </div>
    )
  }
  return (
    <>
      <DeviceStorageCard
        storage={storage}
        families={families}
        pinned={pinned}
        onClearFamily={(family) => {
          const meta = CACHE_FAMILY_META[family]
          // 源图 is the only family where 清理 does not mean "every entry": a
          // source a local行 still references is its only copy (README D3 of
          // browser-owned-listing) and survives this same as 清理本机缓存.
          const sourceCaveat = family === "sources"
            ? "在制品的源图不会被清理，删除方案里的行才会释放它们。"
            : ""
          setTarget({
            family,
            title: `清理${meta?.label ?? "缓存"}`,
            description: `删除本机未被引用的${meta?.label ?? "缓存"}（${meta?.description ?? ""}）。${sourceCaveat}Cloud 上的商品行不受影响。`,
            done: `${meta?.label ?? "缓存"}已清理`,
          })
        }}
        onClear={storage ? () => setTarget({
          title: "清理本机缓存",
          description: "删除本机的 PSD 模板、切片缓存与未被引用的源图。在制品的源图不会被清理，删除方案里的行才会释放它们。Cloud 上的商品行不受影响，下一次准备要重新选择模板、重新导入未被引用的源图。",
          done: "本机缓存已清理",
        }) : undefined}
      />
      <ConfirmDialog
        open={target !== null}
        onOpenChange={(open) => {
          if (!open) setTarget(null)
        }}
        title={target?.title ?? ""}
        description={target?.description ?? ""}
        confirmText="清理"
        busy={clearing}
        onConfirm={() => void clear()}
      />
    </>
  )
}

/**
 * Browser estimates and cache-family records are separate measurements. They
 * can differ, so neither a remainder nor a combined quota chart is inferred.
 */
export function DeviceStorageCard({
  storage,
  families,
  pinned,
  onClearFamily,
  onClear,
}: {
  storage: DeviceStorage | null
  families?: CacheFamilyUsage[] | null
  /** The `sources` family's pinned subset — undefined while still loading. */
  pinned?: PinnedSourceUsage
  onClearFamily?: (family: string) => void
  onClear?: () => void
}) {
  return (
    <section className="flex flex-col gap-6">
      <div className="flex min-h-[48px] flex-wrap items-center gap-x-4 gap-y-2">
        {storage === null ? (
          <p className="min-w-0 text-compact text-muted-foreground">当前浏览器不提供存储用量。</p>
        ) : (
          <p className="flex min-w-0 flex-wrap items-baseline gap-x-2">
            <span className="text-sm font-medium tabular-nums text-foreground">
              浏览器估算已用 {formatBytes(storage.usedBytes)}
            </span>
            <span className="text-compact text-muted-foreground">{`配额 ${formatBytes(storage.quotaBytes)}`}</span>
          </p>
        )}
        {families?.length ? <span className="text-compact text-muted-foreground">分区依据本机缓存记录</span> : null}
        <div className="ml-auto flex flex-wrap items-center gap-2">
          {storage ? (
            <Badge variant={storage.persisted ? "good" : "outline"}>
              {storage.persisted ? "已持久化" : "磁盘紧张时可能被清理"}
            </Badge>
          ) : null}
          {onClear ? (
            <IconButton
              icon={Eraser}
              label="清理本机缓存"
              size="icon-sm"
              variant="outline"
              onClick={onClear}
            />
          ) : null}
        </div>
      </div>
      {families === undefined ? (
        <p role="status" className="text-compact text-muted-foreground">正在读取缓存分类…</p>
      ) : families === null ? (
        <p role="status" className="text-compact text-muted-foreground">无法读取本机缓存分类，请检查浏览器存储权限。</p>
      ) : families.length === 0 ? (
        <p className="text-compact text-muted-foreground">当前没有可显示的缓存分类。</p>
      ) : (
        <ul className="flex flex-col gap-4.5" aria-label="本机缓存分类">
          {families.map((row) => {
            const meta = CACHE_FAMILY_META[row.family]
            const Icon = meta?.icon ?? File
            return (
              <li
                key={row.family}
                className="flex min-h-[110px] flex-wrap items-center gap-x-4 gap-y-3 rounded-lg border border-border bg-card p-5 sm:gap-x-7 sm:px-6"
              >
                <span className="grid size-[60px] shrink-0 place-items-center rounded-xl bg-brand-soft text-brand"><Icon aria-hidden className="size-[28px]" /></span>
                <div className="min-w-0 flex-1 basis-36">
                  <p className="text-md font-semibold leading-6">{meta?.label ?? row.family}</p>
                  <p className="mt-1 text-md leading-5 text-muted-foreground">{meta?.description ?? ""}</p>
                  {row.family === "sources" && pinned ? (
                    <p className="text-xs text-muted-foreground">
                      已钉住 {pinned.count} 张 · {formatBytes(pinned.bytes)}，清理时不会被删除
                    </p>
                  ) : null}
                </div>
                <div className="ml-auto flex shrink-0 items-center justify-end gap-3">
                  <span className="text-md font-medium tabular-nums text-muted-foreground">
                    {formatBytes(row.bytes)}
                    {row.entries > 0 ? ` · ${row.entries} 项` : ""}
                  </span>
                  <Button
                    type="button"
                    variant="outline"
                    size="lg"
                    className="h-11 min-w-[84px]"
                    aria-label={`清理${meta?.label ?? row.family}`}
                    disabled={!onClearFamily || row.bytes === 0}
                    onClick={() => onClearFamily?.(row.family)}
                  >清理</Button>
                </div>
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}
