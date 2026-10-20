import { createContext, useContext, useMemo, type ReactNode } from "react"
import { useAddress } from "@/hooks/use-address"
import { replaceAddress } from "@/lib/address"
import { observationApi } from "./observation-api"
import { observationScopeFromSearch, observationScopeKey, withObservationScope } from "./observation-scope"
import type { ObservationScope, ObservationScopes } from "./observation-types"
import { useObservationRead } from "./use-observation-read"

type ObservationContext = {
  scope: ObservationScope
  scopeKey: string
  scopes?: ObservationScopes
  scopesLoading: boolean
  scopesFailed: boolean
  reloadScopes: () => void
  changeScope: (next: ObservationScope) => void
}
const Context = createContext<ObservationContext | null>(null)

/** URL-owned viewing scope; it never selects or caches a real Workspace. */
export function ObservationScopeProvider({ enabled, children }: { enabled: boolean; children: ReactNode }) {
  const address = useAddress()
  const scope = useMemo(() => observationScopeFromSearch(address.search), [address.search])
  const scopes = useObservationRead("scopes", observationApi.scopes, "无法读取平台查看范围。", enabled)
  return (
    <Context value={{
      scope, scopeKey: observationScopeKey(scope), scopes: scopes.data,
      scopesLoading: scopes.loading, scopesFailed: scopes.failed,
      reloadScopes: () => { void scopes.load() },
      changeScope: (next) => replaceAddress({ search: withObservationScope(window.location.search, next) }),
    }}>
      {children}
    </Context>
  )
}

export function useObservationScope(): ObservationContext {
  const context = useContext(Context)
  if (!context) throw new Error("Observation scope provider is required")
  return context
}
