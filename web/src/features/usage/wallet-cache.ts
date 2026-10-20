import { isCancelledError } from "@tanstack/react-query"
import { useSyncExternalStore } from "react"

import type { WalletView } from "@/bindings/commands"
import { accountHttp } from "@/bindings/http-account"
import { queryClient } from "@/lib/query-client"

/**
 * Header and 用量 both print the same prepaid wallet. TanStack Query owns the
 * snapshot now: the query cache is the single snapshot every observer renders,
 * `staleTime: 0` keeps `loadWallet` honest (a read is a read, never a TTL hit),
 * and `invalidateWallet` removes the key so a reply born before a Workspace
 * switch is fenced out — the in-flight promise resolves, but against a
 * destroyed query its data never lands in the cache.
 */
const WALLET_KEY = ["usage", "wallet"] as const

function walletHash(): string {
  return JSON.stringify(WALLET_KEY)
}

export function peekWallet(): WalletView | null {
  return queryClient.getQueryData<WalletView>(WALLET_KEY) ?? null
}

function subscribeToWrites(onStoreChange: () => void): () => void {
  // The query cache emits many shapes of event (observer add/remove, results
  // transitions, data writes). Only a fresh `data` payload on this key is a
  // notification worth relaying — the session-cache contract subscribers
  // were built against.
  const cache = queryClient.getQueryCache()
  return cache.subscribe((event) => {
    if (
      event.type === "updated" &&
      event.query.queryHash === walletHash() &&
      event.action?.type === "success"
    ) {
      onStoreChange()
    }
  })
}

export function subscribeWallet(onStoreChange: () => void): () => void {
  return subscribeToWrites(onStoreChange)
}

export function invalidateWallet(): void {
  queryClient.removeQueries({ queryKey: WALLET_KEY })
}

export function loadWallet(): Promise<WalletView | undefined> {
  // `removeQueries` silently cancels an in-flight fetch: the reply resolves
  // but Query routes it to `undefined` instead of the dead cache. Surface
  // that as an honest undefined instead of a rejected CancelledError — the
  // caller is asking for the wallet, and after an invalidate there is none.
  return queryClient
    .fetchQuery({
      queryKey: WALLET_KEY,
      queryFn: () => accountHttp.accountGetWallet(),
      // A read is a read: never short-circuit on staleTime. Concurrent callers
      // still share one in-flight promise (Query dedupes by key).
      staleTime: 0,
    })
    .catch((reason: unknown) => {
      if (isCancelledError(reason)) return undefined
      throw reason
    })
}

/**
 * Publish a balance the caller already holds — the recharge dialog's wallet
 * detail read carries the fresh wallet next to the order rows, so it lands in
 * the cache directly instead of forcing a second fetch.
 */
export function rememberWallet(value: WalletView): void {
  queryClient.setQueryData(WALLET_KEY, value)
}

/**
 * Read the snapshot outside React context — `renderToStaticMarkup` and
 * pre-Provider bootstraps never see a QueryClient, so `useQuery` there would
 * throw instead of painting the wallet the caller already loaded.
 */
function readWalletSnapshot(): WalletView | null {
  return peekWallet()
}

export function useWallet(): WalletView | null {
  // `getServerSnapshot` is the same read: the cache is module-level, so an SSR
  // pass and the client bootstrap agree on whatever was already committed.
  return useSyncExternalStore(subscribeWallet, readWalletSnapshot, readWalletSnapshot)
}
