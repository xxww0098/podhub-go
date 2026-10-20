import { useMemo, useState } from "react"

import {
  loadStoreColorPreferences,
  resolveStoreColorAssignments,
  saveStoreColorPreferences,
  type StoreColorPreferences,
} from "./store-colors"

/**
 * Store colours for the workbench table.
 *
 * Preferences are per browser (loaded on mount, saved on change) and the
 * assignment maps each store currently bound to the card onto a palette entry.
 */
export function useStoreColorPreferences(boundStoreIds: string[]) {
  const [storeColorPreferences, setStoreColorPreferences] =
    useState<StoreColorPreferences>(loadStoreColorPreferences)
  const storeColorAssignments = useMemo(
    () => resolveStoreColorAssignments(boundStoreIds, storeColorPreferences),
    [boundStoreIds, storeColorPreferences],
  )

  function updateStoreColors(next: StoreColorPreferences) {
    setStoreColorPreferences(next)
    saveStoreColorPreferences(next)
  }

  return { storeColorPreferences, storeColorAssignments, updateStoreColors }
}
