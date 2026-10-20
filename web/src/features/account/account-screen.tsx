import { useEffect, useState } from "react"
import type { AccountOverview } from "@/bindings/commands"
import { accountHttp } from "@/bindings/http-account"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { ConfirmDialog } from "@/components/ui/confirm-dialog"
import { ChangeNameDialog } from "@/components/change-name-dialog"
import { IdentityMark } from "@/components/identity-mark"
import { Spinner } from "@/components/ui/spinner"
import { formatBytes } from "@/lib/format"
import { notifyCommandError, notifySuccess } from "@/lib/notify"
import { cn } from "@/lib/utils"
import {
  clearCache,
  clearCacheFamily,
  pinnedSourceUsage,
  usage as deviceStorageUsage,
  usageByFamily,
  type CacheFamilyUsage,
} from "@/render/opfs-cache"
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
    <div className="flex w-full flex-col gap-4">
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
          className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-xl border border-border bg-card px-4 py-3"
          data-platform-staff={isPlatformStaffRole(overview.session.role)}
        >
            <IdentityMark
              kind="user"
              role={overview?.session.role}
              name={overview.session.name ?? overview.session.email ?? ""}
              imageUrl={overview.session.avatar_url}
              className="size-9"
            />
            <div className="flex min-w-0 flex-1 flex-col gap-2">
              <p className="flex min-w-0 flex-col gap-0.5">
                <span className="break-words text-md font-semibold">
                  {overview.session.name ?? "—"}
                </span>
                <span className="break-all text-compact text-muted-foreground">
                  {overview.session.email ?? "—"}
                </span>
              </p>
              <div className="flex flex-wrap items-center gap-3">
                {renameLocked ? (
                  <span className="w-fit text-xs text-muted-foreground">
                    {renameCooldownLabel(renameLockedUntil, Date.now())}
                  </span>
                ) : (
                  <button
                    type="button"
                    className="w-fit cursor-pointer text-xs font-medium text-muted-foreground underline-offset-2 hover:text-foreground hover:underline disabled:cursor-not-allowed disabled:opacity-45"
                    disabled={busy}
                    onClick={() => setRenameOpen(true)}
                  >
                    修改名字
                  </button>
                )}
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {staffLabel ? (
                <span className={STAFF_RANK_CHIP_CLASS}>{staffLabel}</span>
              ) : null}
            </div>
            <div className="ml-auto flex flex-wrap items-center gap-2">
              {overview.session.avatar_url ? (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setClearAvatarOpen(true)}
                  disabled={busy}
                >
                  清空头像
                </Button>
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
    </div>
  )
}

type DeviceStorage = Awaited<ReturnType<typeof deviceStorageUsage>>
type PinnedSourceUsage = Awaited<ReturnType<typeof pinnedSourceUsage>>

/**
 * The render cache's families, in bar and row order. `swatch` pairs each
 * family with its `--chart-N` token, the palette the usage charts already
 * draw with.
 */
const CACHE_FAMILY_META: Record<string, { label: string; description: string; swatch: string }> = {
  templates: {
    label: "PSD 模板",
    description: "保留在本机的模板文件，删除后需重新选择",
    swatch: "bg-chart-1",
  },
  sources: {
    label: "源图",
    description: "已导入的设计图源文件，删除后需重新导入",
    swatch: "bg-chart-2",
  },
  renders: {
    label: "切片产物",
    description: "已渲染、尚未投递的切片",
    swatch: "bg-chart-3",
  },
  "static-slices": {
    label: "静态切片缓存",
    description: "跨商品行复用的静态图层切片",
    swatch: "bg-chart-4",
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
  const [families, setFamilies] = useState<CacheFamilyUsage[]>()
  const [pinned, setPinned] = useState<PinnedSourceUsage>()
  const [target, setTarget] = useState<ClearTarget | null>(null)
  const [clearing, setClearing] = useState(false)

  function reload() {
    void deviceStorageUsage().then(setStorage, () => setStorage(null))
    // An engine without OPFS still reports `storage` — the family breakdown
    // just stays absent rather than painting fabricated zeros.
    void usageByFamily().then(setFamilies, () => setFamilies(undefined))
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

  if (storage === undefined) return null
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
 * The measured half, so both the reported and the unsupported card can be read
 * without a browser. The cache evicts itself under a ceiling (`render/opfs-cache.ts`
 * eviction policy); `onClear` is the escape hatch for the operator who wants
 * the disk back now, and is absent on an engine that cannot report at all.
 *
 * `families` turns the card into a dashboard: a segmented bar over the
 * browser quota plus one row per cache family with its own 清理. `onClear`
 * stays the drop-everything hatch next to the heading.
 */
export function DeviceStorageCard({
  storage,
  families,
  pinned,
  onClearFamily,
  onClear,
}: {
  storage: DeviceStorage | null
  families?: CacheFamilyUsage[]
  /** The `sources` family's pinned subset — undefined while still loading. */
  pinned?: PinnedSourceUsage
  onClearFamily?: (family: string) => void
  onClear?: () => void
}) {
  const cacheBytes = families?.reduce((total, row) => total + row.bytes, 0) ?? 0
  // OPFS families are what the sweep can free; the remainder is IndexedDB,
  // Cache Storage and localStorage — reported, never cleared from here.
  const otherBytes = storage ? Math.max(0, storage.usedBytes - cacheBytes) : 0
  const segments = [
    ...(families ?? []).map((row) => ({
      key: row.family,
      bytes: row.bytes,
      swatch: CACHE_FAMILY_META[row.family]?.swatch ?? "bg-muted-foreground/40",
    })),
    { key: "other", bytes: otherBytes, swatch: "bg-muted-foreground/30" },
  ].filter((segment) => segment.bytes > 0)
  const barBasis = storage && storage.quotaBytes > 0 ? storage.quotaBytes : storage?.usedBytes ?? 0

  return (
    <section className="flex flex-col rounded-xl border border-border bg-card">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3">
        <p className="min-w-0 text-compact text-muted-foreground">
          {storage === null
            ? "当前浏览器不提供存储用量，模板与切片缓存不可用。"
            : (
              <>
                <span className="font-mono font-medium tabular-nums text-foreground">
                  已用 {formatBytes(storage.usedBytes)}
                </span>
                {` / 配额 ${formatBytes(storage.quotaBytes)}`}
              </>
            )}
        </p>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          {storage ? (
            <Badge variant="outline">
              {storage.persisted ? "已持久化" : "磁盘紧张时可能被清理"}
            </Badge>
          ) : null}
          {onClear ? (
            <Button variant="outline" size="sm" onClick={onClear}>
              清理本机缓存
            </Button>
          ) : null}
        </div>
      </div>
      {storage && families ? (
        <>
          <div className="px-4 pb-3">
            <div
              role="img"
              aria-label={`本机存储用量 ${formatBytes(storage.usedBytes)} / ${formatBytes(storage.quotaBytes)}`}
              className="flex h-2 w-full overflow-hidden rounded-full bg-muted"
            >
              {segments.map((segment) => (
                <span
                  key={segment.key}
                  className={cn("h-full", segment.swatch)}
                  style={{ width: `${Math.min(100, (segment.bytes / barBasis) * 100)}%` }}
                />
              ))}
            </div>
          </div>
          <ul>
            {families.map((row) => {
              const meta = CACHE_FAMILY_META[row.family]
              return (
                <li
                  key={row.family}
                  className="flex flex-wrap items-center gap-3 border-t border-border px-4 py-3"
                >
                  <span
                    aria-hidden
                    className={cn("size-2.5 shrink-0 rounded-xs", meta?.swatch ?? "bg-muted-foreground/40")}
                  />
                  <div className="flex min-w-0 flex-col">
                    <p className="text-compact font-medium">{meta?.label ?? row.family}</p>
                    <p className="text-meta text-muted-foreground">{meta?.description ?? ""}</p>
                    {row.family === "sources" && pinned ? (
                      <p className="text-meta text-muted-foreground">
                        已钉住 {pinned.count} 张 · {formatBytes(pinned.bytes)}，清理时不会被删除
                      </p>
                    ) : null}
                  </div>
                  <div className="ml-auto flex shrink-0 flex-wrap items-center justify-end gap-3">
                    <span className="font-mono text-meta tabular-nums text-muted-foreground">
                      {formatBytes(row.bytes)}
                      {row.entries > 0 ? ` · ${row.entries} 项` : ""}
                    </span>
                    <Button
                      variant="ghost"
                      size="xs"
                      disabled={row.bytes === 0}
                      onClick={() => onClearFamily?.(row.family)}
                    >
                      清理
                    </Button>
                  </div>
                </li>
              )
            })}
            {otherBytes > 0 ? (
              <li className="flex flex-wrap items-center gap-3 border-t border-border px-4 py-3">
                <span aria-hidden className="size-2.5 shrink-0 rounded-xs bg-muted-foreground/30" />
                <div className="flex min-w-0 flex-col">
                  <p className="text-compact font-medium">其他浏览器数据</p>
                  <p className="text-meta text-muted-foreground">类目树、偏好与浏览器的其他存储</p>
                </div>
                <span className="ml-auto shrink-0 font-mono text-meta tabular-nums text-muted-foreground">
                  {formatBytes(otherBytes)}
                </span>
              </li>
            ) : null}
          </ul>
        </>
      ) : null}
    </section>
  )
}
