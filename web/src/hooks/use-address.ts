import { useMemo, useSyncExternalStore } from "react"

import { addressOf, currentHref, subscribeAddress, type Address } from "@/lib/address"

/**
 * The address as React state.
 *
 * Every write must go through `replaceAddress`: `history.replaceState` on its
 * own changes the URL without telling React, and the shell would keep painting
 * the previous address.
 */
export function useAddressHref(): string {
  return useSyncExternalStore(subscribeAddress, currentHref, currentHref)
}

export function useAddress(): Address {
  const href = useAddressHref()
  return useMemo(() => addressOf(href), [href])
}
