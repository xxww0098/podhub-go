export const STORE_COLOR_STORAGE_KEY = "podhub.store-colors.v1"

export const STORE_COLOR_PALETTE = [
  { id: "blue", label: "蓝色", color: "var(--store-blue)", ink: "var(--store-blue-ink)" },
  { id: "amber", label: "琥珀", color: "var(--store-amber)", ink: "var(--store-amber-ink)" },
  { id: "teal", label: "青色", color: "var(--store-teal)", ink: "var(--store-teal-ink)" },
  { id: "magenta", label: "紫红", color: "var(--store-magenta)", ink: "var(--store-magenta-ink)" },
  { id: "coral", label: "珊瑚", color: "var(--store-coral)", ink: "var(--store-coral-ink)" },
  { id: "indigo", label: "靛青", color: "var(--store-indigo)", ink: "var(--store-indigo-ink)" },
  { id: "olive", label: "橄榄", color: "var(--store-olive)", ink: "var(--store-olive-ink)" },
  { id: "cyan", label: "湖蓝", color: "var(--store-cyan)", ink: "var(--store-cyan-ink)" },
] as const

export type StoreColorId = (typeof STORE_COLOR_PALETTE)[number]["id"]
export type StoreColorPreferences = Record<string, StoreColorId>

const STORE_COLOR_IDS = new Set<StoreColorId>(
  STORE_COLOR_PALETTE.map((tone) => tone.id),
)

export function storeColorById(colorId: StoreColorId) {
  return STORE_COLOR_PALETTE.find((tone) => tone.id === colorId)!
}

/**
 * Produce one categorical colour per bound Store. Explicit preferences win;
 * missing, stale or duplicate preferences fall back to the first unused tone
 * in binding order so rows never silently collapse into the same background.
 */
export function resolveStoreColorAssignments(
  boundStoreIds: readonly string[],
  preferences: Readonly<StoreColorPreferences>,
): Record<string, StoreColorId> {
  const used = new Set<StoreColorId>()
  const resolved: Record<string, StoreColorId> = {}
  for (const [index, storeId] of boundStoreIds.entries()) {
    const preferred = preferences[storeId]
    const fallback =
      STORE_COLOR_PALETTE.find((tone) => !used.has(tone.id))?.id ??
      STORE_COLOR_PALETTE[index % STORE_COLOR_PALETTE.length]!.id
    const colorId = preferred && !used.has(preferred) ? preferred : fallback
    resolved[storeId] = colorId
    used.add(colorId)
  }
  return resolved
}

/** Assigning an unassigned colour updates the Store preference. Attempting to
 * choose a colour occupied by another bound Store is a no-op to preserve uniqueness. */
export function reassignStoreColor(
  preferences: Readonly<StoreColorPreferences>,
  boundStoreIds: readonly string[],
  storeId: string,
  colorId: StoreColorId,
): StoreColorPreferences {
  if (!boundStoreIds.includes(storeId)) return { ...preferences }
  const current = resolveStoreColorAssignments(boundStoreIds, preferences)
  const occupiedBy = boundStoreIds.find(
    (candidate) => candidate !== storeId && current[candidate] === colorId,
  )
  if (occupiedBy) return { ...preferences }
  return { ...preferences, [storeId]: colorId }
}

export function defaultStoreColors(
  preferences: Readonly<StoreColorPreferences>,
  boundStoreIds: readonly string[],
): StoreColorPreferences {
  const next = { ...preferences }
  for (const storeId of boundStoreIds) delete next[storeId]
  return next
}

export function parseStoreColorPreferences(raw: string | null): StoreColorPreferences {
  if (!raw) return {}
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {}
    return Object.fromEntries(
      Object.entries(parsed)
        .filter(
          (entry): entry is [string, StoreColorId] =>
            entry[0].length > 0 &&
            entry[0].length <= 500 &&
            typeof entry[1] === "string" &&
            STORE_COLOR_IDS.has(entry[1] as StoreColorId),
        ),
    )
  } catch {
    return {}
  }
}

export function loadStoreColorPreferences(): StoreColorPreferences {
  if (typeof window === "undefined") return {}
  try {
    return parseStoreColorPreferences(window.localStorage.getItem(STORE_COLOR_STORAGE_KEY))
  } catch {
    return {}
  }
}

export function saveStoreColorPreferences(preferences: StoreColorPreferences): void {
  if (typeof window === "undefined") return
  try {
    window.localStorage.setItem(STORE_COLOR_STORAGE_KEY, JSON.stringify(preferences))
  } catch {
    // A presentation preference must never block listing work when storage is
    // unavailable, private, or full. The current session still keeps the tone.
  }
}
