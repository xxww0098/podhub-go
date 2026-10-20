import {
  Fragment,
  useEffect,
  useId,
  useMemo,
  useState,
  useSyncExternalStore,
} from "react"
import { Search, Store } from "lucide-react"

import type { OzonStoreView } from "@/bindings/commands"
import type { SupplierDb } from "@/bindings/http-supplier-dbs"
import { Input } from "@/components/ui/input"
import { useStoreRoster } from "@/features/stores/store-roster-cache"
import { matchesStoreQuery } from "@/features/stores/store-search"
import {
  supplierDbs,
  useSupplierDbsStore,
} from "@/features/supplier-dbs/supplier-dbs-store"
import {
  peekListingWorkbench,
  subscribeListingWorkbench,
} from "@/features/workflow/workbench/listing-workbench-store"
import { readAddress, replaceAddress } from "@/lib/address"
import { withScreen } from "@/lib/admin-surface"
import {
  CatalogIcon,
  ListingIcon,
  SupplierDbsIcon,
} from "@/lib/nav-icons"
import {
  navItemsFor,
  navModesFor,
  staffNavModes,
  type NavAudience,
} from "@/lib/app-navigation"
import { runViewTransition } from "@/lib/view-transition"
import { SCREEN_LABELS, type AppScreen } from "@/lib/app-screens"
import {
  SETTINGS_SECTION_ICONS,
  type SettingsSectionIcon,
} from "@/components/settings-section-icons"
import type {
  SettingsSection,
  SettingsSectionRow,
} from "@/lib/settings-sections"

/** Keystroke → committed query: the dropdown never repaints per character. */
export const SEARCH_DEBOUNCE_MS = 200

/** One group's ceiling — five sources, five rows each keeps the panel scannable. */
export const SEARCH_GROUP_LIMIT = 5

/** One searchable destination, from any source: a page, or a business record. */
export type SearchHit = {
  key: string
  label: string
  /** Secondary text the row can carry (库名, Client ID …); never load-bearing. */
  hint?: string
  icon: SettingsSectionIcon
  open: () => void
}

/** A source the command palette draws from. Empty sources never register. */
export type SearchProvider = {
  id: "pages" | "catalog-products" | "supplier-dbs" | "stores" | "listing-plans"
  label: string
  search: (query: string) => SearchHit[]
}

export type SearchGroup = {
  id: SearchProvider["id"]
  label: string
  hits: SearchHit[]
}

/** A published 商库 row as the palette sees it — the seller gallery's floor. */
export type CatalogRowRef = {
  productId: string
  title: string
  dbName: string
}

/** Plain data the providers are built from; every field may be absent. */
export type SearchProviderDeps = {
  audience: NavAudience
  adminSurface: boolean
  adminSections?: readonly SettingsSectionRow[]
  /** 商库商品 — published rows the 货源管理 screens already hold. */
  supplierDbCatalogRows?: readonly CatalogRowRef[]
  /** 平台货源 — the db list the 货源管理 screen already holds. */
  supplierDbs?: readonly SupplierDb[]
  /** 店铺 — this Workspace's roster as the shell-level cache holds it. */
  workspaceStores?: readonly OzonStoreView[]
  /** 上架方案 — the workbench's one open card, if a runner is mounted. */
  listingPlan?: { cardId: string; cardName: string }
  onScreenChange: (screen: AppScreen) => void
  onOpenSettings: (section: SettingsSection) => void
}

function matches(haystack: string, needle: string): boolean {
  return haystack.toLowerCase().includes(needle.toLowerCase())
}

/**
 * Query → grouped hits. Providers own their matching semantics; this pass only
 * ranks (label-prefix first, input order stable within a rank) and caps each
 * group. Sources with nothing to say are absent, not empty.
 */
export function searchGroups(
  query: string,
  providers: readonly SearchProvider[],
): SearchGroup[] {
  const q = query.trim()
  if (!q) return []
  const groups: SearchGroup[] = []
  for (const provider of providers) {
    const ranked = [...provider.search(q)].sort(
      (a, b) =>
        Number(b.label.toLowerCase().startsWith(q.toLowerCase())) -
        Number(a.label.toLowerCase().startsWith(q.toLowerCase())),
    )
    const hits = ranked.slice(0, SEARCH_GROUP_LIMIT)
    if (hits.length) groups.push({ id: provider.id, label: provider.label, hits })
  }
  return groups
}

/** The combobox's flat cursor over grouped rows: down/up wrap, others ignore. */
export function stepActive(
  key: string,
  active: number,
  count: number,
): number | null {
  if (key === "ArrowDown" && count) return (active + 1) % count
  if (key === "ArrowUp" && count) return (active - 1 + count) % count
  return null
}

/**
 * The matched substring, if any: `[before, match, after]`, case-insensitive,
 * first occurrence. Highlight stays inside the semantic palette — the caller
 * paints `match`, never the rest.
 */
export function highlightParts(
  label: string,
  query: string,
): [string, string, string] | null {
  const q = query.trim()
  if (!q) return null
  const at = label.toLowerCase().indexOf(q.toLowerCase())
  if (at < 0) return null
  return [label.slice(0, at), label.slice(at, at + q.length), label.slice(at + q.length)]
}

/**
 * Compose a screen's own address: `withScreen` drops foreign module params, then
 * the record's drill-in key rides on top. Writing the whole search in one
 * `replaceAddress` is the injection `withScreen` keeps (the progress-chip
 * handoff, upside down): the route follows the address, so the jump lands on
 * the record, not the module root.
 */
function screenSearch(
  search: string,
  screen: AppScreen,
  drill: { key: string; value: string },
): string {
  const params = new URLSearchParams(withScreen(search, screen))
  params.set(drill.key, drill.value)
  const query = params.toString()
  return query ? `?${query}` : ""
}

/** 商库商品详情 — `?screen=catalog&product=<product_id>`（catalog 屏自己的钻取键）。 */
export function catalogProductSearch(search: string, productId: string): string {
  return screenSearch(search, "catalog", { key: "product", value: productId })
}

/** 平台货源 — `?screen=supplier-dbs&open=<source_id>`（库页由地址渲染）。 */
export function supplierDbOpenSearch(search: string, sourceId: string): string {
  return screenSearch(search, "supplier-dbs", { key: "open", value: sourceId })
}

/** 上架方案 — `?screen=listing&cardId=<draft_id>`（runner 的恢复入口）。 */
export function listingCardSearch(search: string, cardId: string): string {
  return screenSearch(search, "listing", { key: "cardId", value: cardId })
}

function navigateToSearch(search: string): void {
  runViewTransition(() => replaceAddress({ search }))
}

/**
 * The provider registry. Pages keep the old navigator semantics (workbench
 * screens, or staff screens + settings panes on `/admin`); the four data
 * providers are workbench business data the app already holds in module-level
 * stores — no request is issued from here. A source that has not been loaded
 * simply does not register, so its group never appears.
 */
export function buildSearchProviders(deps: SearchProviderDeps): SearchProvider[] {
  const providers: SearchProvider[] = [
    {
      id: "pages",
      label: "页面",
      search: (query) => {
        const modes = deps.adminSurface
          ? staffNavModes()
          : navModesFor(deps.audience)
        const hits: SearchHit[] = modes
          .flatMap((mode) => navItemsFor(mode, deps.audience))
          .map((item) => ({
            key: `screen-${item.id}`,
            label: SCREEN_LABELS[item.id],
            icon: item.icon,
            open: () => deps.onScreenChange(item.id),
          }))
        if (!deps.adminSurface) return hits.filter((hit) => matches(hit.label, query))
        return [
          ...hits,
          ...(deps.adminSections ?? []).map((row) => ({
            key: `settings-${row.id}`,
            label: row.label,
            icon: SETTINGS_SECTION_ICONS[row.id],
            open: () => deps.onOpenSettings(row.id),
          })),
        ].filter((hit) => matches(hit.label, query))
      },
    },
  ]
  if (deps.adminSurface) return providers
  if (deps.supplierDbCatalogRows?.length) {
    providers.push({
      id: "catalog-products",
      label: "商库商品",
      search: (query) =>
        deps.supplierDbCatalogRows!
          .filter((row) => matches(row.title, query))
          .map((row) => ({
            key: `catalog-product-${row.productId}`,
            label: row.title,
            hint: row.dbName,
            icon: CatalogIcon,
            open: () =>
              navigateToSearch(
                catalogProductSearch(readAddress().search, row.productId),
              ),
          })),
    })
  }
  if (deps.supplierDbs?.length) {
    providers.push({
      id: "supplier-dbs",
      label: "平台货源",
      search: (query) =>
        deps.supplierDbs!
          .filter((db) => matches(db.name, query))
          .map((db) => ({
            key: `supplier-db-${db.sourceId}`,
            label: db.name,
            hint: `${db.rowCount} 行`,
            icon: SupplierDbsIcon,
            open: () =>
              navigateToSearch(
                supplierDbOpenSearch(readAddress().search, db.sourceId),
              ),
          })),
    })
  }
  if (deps.workspaceStores?.length) {
    providers.push({
      id: "stores",
      label: "店铺",
      search: (query) =>
        deps.workspaceStores!
          .filter((store) => matchesStoreQuery(store, query))
          .map((store) => ({
            key: `store-${store.id}`,
            label: store.label || "未命名店铺",
            hint: store.client_id || undefined,
            icon: Store,
            open: () => deps.onScreenChange("stores"),
          })),
    })
  }
  if (deps.listingPlan) {
    const plan = deps.listingPlan
    providers.push({
      id: "listing-plans",
      label: "上架方案",
      search: (query) =>
        matches(plan.cardName, query)
          ? [
              {
                key: `listing-plan-${plan.cardId}`,
                label: plan.cardName,
                icon: ListingIcon,
                open: () =>
                  navigateToSearch(
                    listingCardSearch(readAddress().search, plan.cardId),
                  ),
              },
            ]
          : [],
    })
  }
  return providers
}

const EMPTY_WORKBENCH_STRING = ""

function planCardIdSnapshot(): string {
  return peekListingWorkbench().cardId ?? EMPTY_WORKBENCH_STRING
}

function planCardNameSnapshot(): string {
  return peekListingWorkbench().cardName ?? EMPTY_WORKBENCH_STRING
}

type GlobalSearchProps = {
  audience: NavAudience
  adminSurface?: boolean
  adminSections?: readonly SettingsSectionRow[]
  /** The roster cache key; absent (signed out) keeps the 店铺 group unregistered. */
  workspaceId?: number
  onScreenChange: (screen: AppScreen) => void
  onOpenSettings: (section: SettingsSection) => void
}

/**
 * The sidebar's command palette: pages plus the business data the app already
 * holds (商库商品 / 平台货源 / 店铺 / 上架方案). Keystrokes debounce into one
 * committed query; each source answers with at most five rows; picking a row
 * navigates to the record's own address.
 */
export function GlobalSearch({
  audience,
  adminSurface = false,
  adminSections = [],
  workspaceId,
  onScreenChange,
  onOpenSettings,
}: GlobalSearchProps) {
  const listboxId = useId()
  const [query, setQuery] = useState("")
  const [committed, setCommitted] = useState("")
  const [focused, setFocused] = useState(false)
  const [active, setActive] = useState(0)
  useEffect(() => {
    if (query === committed) return
    const timer = setTimeout(() => setCommitted(query), SEARCH_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [query, committed])
  // Module-level stores, read-only: the palette never fetches, it only sees
  // what the screens this session already loaded.
  const dbsState = useSupplierDbsStore(supplierDbs)
  const roster = useStoreRoster(workspaceId)
  const planCardId = useSyncExternalStore(
    subscribeListingWorkbench,
    planCardIdSnapshot,
    () => EMPTY_WORKBENCH_STRING,
  )
  const planCardName = useSyncExternalStore(
    subscribeListingWorkbench,
    planCardNameSnapshot,
    () => EMPTY_WORKBENCH_STRING,
  )
  const catalogRows = useMemo(() => {
    const names = new Map(dbsState.dbs.map((db) => [db.sourceId, db.name]))
    const rows: CatalogRowRef[] = []
    for (const state of Object.values(dbsState.details)) {
      const detail = state.detail
      if (!detail) continue
      const dbName = names.get(detail.db.sourceId) ?? detail.db.name
      // The seller gallery only sees published rows; a hit the target screen
      // would drop is not a hit.
      for (const row of detail.rows) {
        if (row.published && !row.archived) {
          rows.push({ productId: row.productId, title: row.title, dbName })
        }
      }
    }
    return rows
  }, [dbsState])
  const providers = useMemo(
    () =>
      buildSearchProviders({
        audience,
        adminSurface,
        adminSections,
        supplierDbCatalogRows: catalogRows,
        supplierDbs: dbsState.dbs,
        workspaceStores: roster?.overview.stores,
        listingPlan:
          planCardId && planCardName
            ? { cardId: planCardId, cardName: planCardName }
            : undefined,
        onScreenChange,
        onOpenSettings,
      }),
    [
      audience,
      adminSurface,
      adminSections,
      catalogRows,
      dbsState.dbs,
      roster,
      planCardId,
      planCardName,
      onScreenChange,
      onOpenSettings,
    ],
  )
  const q = committed.trim()
  const groups = useMemo(() => searchGroups(q, providers), [q, providers])
  const results = useMemo(() => groups.flatMap((group) => group.hits), [groups])
  const open = focused && q.length > 0
  const activeIndex = Math.min(active, Math.max(results.length - 1, 0))
  const go = (hit: SearchHit) => {
    setQuery("")
    setCommitted("")
    setActive(0)
    setFocused(false)
    hit.open()
  }

  return (
    <div className="relative group-data-[collapsible=icon]:hidden">
      <Search
        aria-hidden
        className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-faint-foreground"
      />
      <Input
        type="search"
        value={query}
        aria-label="搜索页面与业务数据"
        placeholder="搜索页面与业务数据"
        role="combobox"
        aria-expanded={open}
        aria-autocomplete="list"
        aria-controls={open ? listboxId : undefined}
        aria-activedescendant={
          open && results.length
            ? `${listboxId}-option-${activeIndex}`
            : undefined
        }
        onChange={(e) => {
          setQuery(e.target.value)
          setActive(0)
        }}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        onKeyDown={(e) => {
          const next = stepActive(e.key, activeIndex, results.length)
          if (next !== null) {
            e.preventDefault()
            setActive(next)
          } else if (e.key === "Enter" && results[activeIndex]) {
            go(results[activeIndex])
          } else if (e.key === "Escape") {
            setQuery("")
            setCommitted("")
          }
        }}
        className="h-9 border-sidebar-border bg-white pl-8 text-compact group-data-[collapsible=icon]:hidden dark:bg-card"
      />
      {open ? (
        <SearchResultListbox
          listboxId={listboxId}
          query={q}
          groups={groups}
          activeIndex={activeIndex}
          onHover={setActive}
          onOpen={go}
        />
      ) : null}
    </div>
  )
}

/**
 * The palette's answer, verbatim from the old navigator: one listbox, options
 * flattened across groups (the combobox cursor and `aria-activedescendant`
 * address them by flat index), group labels as presentation rows. The empty
 * answer keeps the old「无匹配」row.
 */
export function SearchResultListbox({
  listboxId,
  query,
  groups,
  activeIndex,
  onHover,
  onOpen,
}: {
  listboxId: string
  query: string
  groups: readonly SearchGroup[]
  activeIndex: number
  onHover: (index: number) => void
  onOpen: (hit: SearchHit) => void
}) {
  let index = -1
  return (
    <ul
      id={listboxId}
      role="listbox"
      aria-label="搜索结果"
      className="absolute inset-x-0 top-full z-30 mt-1 max-h-64 overflow-auto rounded-lg bg-popover p-1 text-popover-foreground shadow-overlay ring-1 ring-foreground/10"
    >
      {groups.length ? (
        groups.map((group) => (
          <Fragment key={group.id}>
            <li
              role="presentation"
              className="select-none px-2 pb-1 pt-1.5 text-meta font-medium text-faint-foreground"
            >
              {group.label}
            </li>
            {group.hits.map((hit) => {
              index += 1
              const i = index
              const Icon = hit.icon
              const parts = highlightParts(hit.label, query)
              return (
                <li key={hit.key}>
                  <button
                    type="button"
                    id={`${listboxId}-option-${i}`}
                    role="option"
                    aria-selected={i === activeIndex}
                    onMouseEnter={() => onHover(i)}
                    /* Navigate on mousedown so the input never blurs first. */
                    onMouseDown={(e) => {
                      e.preventDefault()
                      onOpen(hit)
                    }}
                    className="flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-xs text-foreground hover:bg-sidebar-accent aria-selected:bg-sidebar-accent focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring"
                  >
                    <Icon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
                    <span className="min-w-0 truncate">
                      {parts ? (
                        <>
                          {parts[0]}
                          <span className="text-brand">{parts[1]}</span>
                          {parts[2]}
                        </>
                      ) : (
                        hit.label
                      )}
                    </span>
                    {hit.hint ? (
                      <span className="ml-auto shrink-0 truncate font-mono text-meta text-faint-foreground">
                        {hit.hint}
                      </span>
                    ) : null}
                  </button>
                </li>
              )
            })}
          </Fragment>
        ))
      ) : (
        <li className="px-2 py-1.5 text-xs text-muted-foreground">无匹配</li>
      )}
    </ul>
  )
}
