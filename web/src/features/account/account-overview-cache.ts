import { isCancelledError } from "@tanstack/react-query"
import { useSyncExternalStore } from "react"

import type {
  AccountOverview,
  AccountSessionView,
  EntitlementView,
  StackedAccountView,
  WorkspaceSummaryView,
} from "@/bindings/commands"
import { accountHttp } from "@/bindings/http-account"
import { onSessionSweep, queryClient } from "@/lib/query-client"
import { setErrorTelemetryContext } from "@/lib/error-telemetry"
import { setListingLogCollect } from "@/lib/listing-log"

/**
 * Shell, 账户, 工作空间 and 加购 all print the same session standing. Passing
 * AccountOverview down from App meant a 60s beat that called setState on the
 * authenticated tree rebuilt the active keep-alive pane. The query cache holds
 * the snapshot; identical reads are deduped by `sameAccountOverview` before
 * they ever become a render.
 *
 * `invalidateAccountOverview` is also an authority boundary: any reply that
 * was in flight when the key was removed belongs to the previous session, so
 * the generation stamp lets `peek` pretend the entry never landed. A `force`
 * probe or `remember` bumps the generation and republishes; the stale reply
 * resolves its caller but writes into a dead generation.
 */
export const ACCOUNT_OVERVIEW_POLL_MS = 60_000

const OVERVIEW_KEY = ["account", "overview"] as const
const OVERVIEW_HASH = JSON.stringify(OVERVIEW_KEY)

// The generation the current entry was committed under. `invalidate` bumps
// it so a stale `setData` landing on a rebuilt query still reads as absent.
let liveGeneration = 0
const entryGeneration = new Map<string, number>()

// The same cache observes login, account/Workspace changes and global logout.
// This key fences diagnostics in memory; it is never included in an event.
function syncErrorTelemetryContext(overview: AccountOverview | undefined): void {
  const account = overview?.accounts?.find((item) => item.active)
  const identity = account?.uuid ?? overview?.session.email
  setErrorTelemetryContext({
    sessionKey:
      overview?.session.authenticated && identity && overview.active_workspace?.uuid
        ? `${identity}:${overview.active_workspace.uuid}`
        : null,
    userId: account?.uuid,
    workspaceId: overview?.active_workspace?.uuid,
  })
  setListingLogCollect(overview?.client_log_collect === true)
}

// Telemetry follows every committed overview, whether it came from a fetch
// or a `rememberAccountOverview` publish.
queryClient.getQueryCache().subscribe((event) => {
  if (
    event.type === "updated" &&
    event.query.queryHash === OVERVIEW_HASH &&
    event.action?.type === "success"
  ) {
    // Only a write that survived the generation fence may restore
    // diagnostics: a stale reply that landed after an invalidate still
    // notifies the cache, but its identity belongs to the session just swept.
    syncErrorTelemetryContext(peekAccountOverview() ?? undefined)
  }
})

export function peekAccountOverview(): AccountOverview | null {
  const query = queryClient.getQueryCache().find({ queryKey: OVERVIEW_KEY })
  if (!query) return null
  // A reply committed before the last invalidate stays in the cache object,
  // but the generation stamp says it is not this session's fact.
  const stamp = entryGeneration.get(OVERVIEW_HASH)
  if (stamp !== liveGeneration) return null
  return (query.state.data as AccountOverview | undefined) ?? null
}

function subscribeToWrites(onStoreChange: () => void): () => void {
  const cache = queryClient.getQueryCache()
  return cache.subscribe((event) => {
    if (
      event.type === "updated" &&
      event.query.queryHash === OVERVIEW_HASH &&
      event.action?.type === "success"
    ) {
      onStoreChange()
    }
  })
}

export function subscribeAccountOverview(onStoreChange: () => void): () => void {
  return subscribeToWrites(onStoreChange)
}

export function invalidateAccountOverview(): void {
  liveGeneration += 1
  queryClient.removeQueries({ queryKey: OVERVIEW_KEY })
  syncErrorTelemetryContext(undefined)
}

// `invalidateAllSessionCaches` sweeps every query too — this module's
// generation must advance so a reply in flight at sign-out stays fenced.
onSessionSweep(() => {
  liveGeneration += 1
  syncErrorTelemetryContext(undefined)
})

function writeOverview(overview: AccountOverview): void {
  // Every committed write records the generation it belongs to; `peek` only
  // surfaces the value when it still matches the live generation.
  entryGeneration.set(OVERVIEW_HASH, liveGeneration)
  queryClient.setQueryData(OVERVIEW_KEY, overview)
}

export function rememberAccountOverview(overview: AccountOverview): void {
  if (!overview.session.authenticated) {
    invalidateAccountOverview()
    return
  }
  if (sameAccountOverview(peekAccountOverview(), overview)) {
    syncErrorTelemetryContext(overview)
    return
  }
  writeOverview(overview)
}

export function loadAccountOverview(options?: {
  force?: boolean
}): Promise<AccountOverview | undefined> {
  // `force` is the post-mutation probe: it must start its own request rather
  // than join an in-flight poll, because a reply born before the write
  // committed server-side would otherwise mask the fresh standing. It still
  // publishes through the cache so the shell paints what the probe learns.
  if (options?.force) {
    // Fence every in-flight read first: the poll that is still out was born
    // before this mutation committed, and its reply must not overwrite what
    // the probe is about to learn. Removing the query destroys its retryer
    // so the stale reply lands in no cache at all.
    invalidateAccountOverview()
    const bornAs = liveGeneration
    return accountHttp
      .accountGetOverview()
      .then((overview) => {
        if (overview.session.authenticated) {
          // Commit under the generation this probe was born into: an
          // invalidate landing between the request and the reply still
          // fences the write.
          entryGeneration.set(OVERVIEW_HASH, bornAs)
          queryClient.setQueryData(OVERVIEW_KEY, overview)
        }
        return overview
      })
      .catch((reason: unknown) => {
        if (isCancelledError(reason)) return undefined
        throw reason
      })
  }
  return queryClient
    .fetchQuery({
      queryKey: OVERVIEW_KEY,
      // Stamp the generation this request was born under, inside the
      // resolver: `setData` notifies subscribers before this promise's
      // `.then` runs, and an invalidate that lands between request and reply
      // has to fence the write.
      queryFn: () => {
        const bornAs = liveGeneration
        return accountHttp.accountGetOverview().then((overview) => {
          // Only stamp when this request's generation is still live: a reply
          // that outlived an invalidate must not overwrite the stamp a newer
          // probe already committed.
          if (bornAs === liveGeneration) {
            entryGeneration.set(OVERVIEW_HASH, bornAs)
          }
          return overview
        })
      },
      // A read is a read: never short-circuit. Concurrent callers still share
      // one in-flight promise (Query dedupes by key), and `sameAccountOverview`
      // dedupes identical payloads before subscribers ever render them.
      staleTime: 0,
    })
    .catch((reason: unknown) => {
      if (isCancelledError(reason)) return undefined
      throw reason
    })
}

function readOverviewSnapshot(): AccountOverview | null {
  return peekAccountOverview()
}

export function useAccountOverview(): AccountOverview | null {
  // `useSyncExternalStore` lets a `renderToStaticMarkup` fixture or a
  // pre-Provider bootstrap paint the committed snapshot without needing a
  // QueryClient in the tree.
  return useSyncExternalStore(subscribeToWrites, readOverviewSnapshot, readOverviewSnapshot)
}

/** Unchanged standing must not `setState` — the 60s beat is not news. */
export function sameAccountOverview(
  current?: AccountOverview | null,
  next?: AccountOverview | null,
): boolean {
  if (current === next) return true
  if (!current || !next) return false
  return (
    sameSession(current.session, next.session) &&
    current.account_mode === next.account_mode &&
    current.owned_count === next.owned_count &&
    current.owned_limit === next.owned_limit &&
    sameEntitlement(current.entitlement, next.entitlement) &&
    sameWorkspace(current.active_workspace, next.active_workspace) &&
    sameWorkspaces(current.workspaces, next.workspaces) &&
    // Fields the shell renders directly: a change the comparators above
    // ignore would be deduped away forever.
    current.is_agent === next.is_agent &&
    current.client_log_collect === next.client_log_collect &&
    sameAccounts(current.accounts, next.accounts) &&
    sameWorkspaces(current.unusable_workspaces ?? [], next.unusable_workspaces ?? [])
  )
}

function sameSession(current: AccountSessionView, next: AccountSessionView): boolean {
  return (
    current.authenticated === next.authenticated &&
    current.is_admin === next.is_admin &&
    current.email === next.email &&
    current.name === next.name &&
    current.role === next.role &&
    current.supplier_id === next.supplier_id &&
    current.avatar_url === next.avatar_url &&
    current.name_changed_at_ms === next.name_changed_at_ms
  )
}

function sameEntitlement(
  current?: EntitlementView,
  next?: EntitlementView,
): boolean {
  if (current === next) return true
  if (!current || !next) return false
  const a = current.limits
  const b = next.limits
  return (
    current.plan === next.plan &&
    current.features.ai_relay === next.features.ai_relay &&
    current.features.ocr === next.features.ocr &&
    current.features.batch_listing === next.features.batch_listing &&
    current.features.field_package === next.features.field_package &&
    a.stores === b.stores &&
    a.stores_used === b.stores_used &&
    a.seats === b.seats &&
    a.seats_used === b.seats_used &&
    a.s3_upload_bytes_monthly === b.s3_upload_bytes_monthly &&
    a.s3_upload_bytes_used === b.s3_upload_bytes_used &&
    a.ai_tokens_monthly === b.ai_tokens_monthly &&
    a.ai_tokens_used === b.ai_tokens_used &&
    a.ai_calls_per_day === b.ai_calls_per_day
  )
}

function sameAccounts(
  current: StackedAccountView[] | undefined,
  next: StackedAccountView[] | undefined,
): boolean {
  const a = current ?? []
  const b = next ?? []
  if (a.length !== b.length) return false
  return a.every((account, index) => {
    const other = b[index]
    return (
      other !== undefined &&
      account.uuid === other.uuid &&
      account.email === other.email &&
      account.name === other.name &&
      account.active === other.active &&
      account.avatar_url === other.avatar_url
    )
  })
}

function sameWorkspaces(
  current: WorkspaceSummaryView[],
  next: WorkspaceSummaryView[],
): boolean {
  if (current.length !== next.length) return false
  return current.every((workspace, index) => sameWorkspace(workspace, next[index]))
}

function sameWorkspace(
  current?: WorkspaceSummaryView,
  next?: WorkspaceSummaryView,
): boolean {
  if (current === next) return true
  if (!current || !next) return false
  return (
    current.id === next.id &&
    current.uuid === next.uuid &&
    current.name === next.name &&
    current.plan === next.plan &&
    current.role === next.role &&
    current.is_owned === next.is_owned &&
    current.avatar_url === next.avatar_url &&
    current.member_count === next.member_count
  )
}
