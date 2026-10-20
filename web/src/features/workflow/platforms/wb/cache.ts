import { readWbCatalog, type WbCatalogRead, type WbCoordinate } from "@/bindings/http-wb-catalog"
import type { WbMaterial, WbSchemaHandle } from "@/listing-core/wb-types"
import { sha256 } from "../core"
import { nativeWbMaterial } from "./material"

export type WbCacheScope = { accountId: string; workspaceUuid: string; sessionFence: string }
export type WbResident = Readonly<{ platform: "wb"; key: string; handle: WbSchemaHandle; response: WbCatalogRead }>
export function createWbCache(options: {
  core: { readonly generation?: number; loadWbMaterial(material: WbMaterial): WbSchemaHandle | Promise<WbSchemaHandle>; dropWbMaterial(handle: WbSchemaHandle): void | Promise<void> }
  scope: WbCacheScope
  current(): boolean
  read?: typeof readWbCatalog
  now?: () => number
}) {
  const entries = new Map<string, WbResident>()
  const materials = new Map<string, WbCatalogRead>()
  const reads = new Map<string, { count: number; pending?: Promise<WbResident> }>()
  let generation = options.core.generation
  let epoch = 0
  let closed = false
  const scope = { ...options.scope }
  const keyOf = (coordinate: WbCoordinate) => JSON.stringify([scope.accountId, scope.workspaceUuid, "wb", coordinate.subjectId, coordinate.language, scope.sessionFence])
  function synchronize() {
    if (generation !== options.core.generation) { generation = options.core.generation; entries.clear(); epoch++ }
  }
  const current = () => !closed && options.current()
  function get(coordinate: WbCoordinate): WbResident | undefined {
    synchronize()
    const entry = current() ? entries.get(keyOf(coordinate)) : undefined
    return entry ? { ...entry, response: structuredClone(entry.response) } : undefined
  }
  async function load(coordinate: WbCoordinate, refresh: boolean, signal?: AbortSignal): Promise<WbResident> {
    synchronize()
    if (!current() || signal?.aborted) throw new Error("WB material scope is no longer current")
    const key = keyOf(coordinate)
    const budget = reads.get(key) ?? { count: 0 }
    reads.set(key, budget)
    if (budget.pending) return budget.pending
    const existing = get(coordinate)
    if (!refresh && existing) return existing
    // Explicit reopen after an instance restart may reuse local material without a C read.
    const local = !refresh ? materials.get(key) : undefined
    if (!local && budget.count >= (refresh ? 2 : 1)) throw new Error("WB coordinate read budget exhausted; reopen the coordinate explicitly")
    if (!local) budget.count++
    const captured = epoch
    const valid = () => current() && !signal?.aborted && captured === epoch && generation === options.core.generation
    const job = (async () => {
      const response = local ?? await (options.read ?? readWbCatalog)(coordinate, signal)
      if (!valid()) throw new Error("WB material response arrived after its scope changed")
      const defaultsDigest = await sha256(JSON.stringify(response.defaults ?? null))
      if (!valid()) throw new Error("WB material scope changed before native loading")
      const handle = await options.core.loadWbMaterial(nativeWbMaterial(response))
      if (!valid()) {
        if (generation === options.core.generation) await options.core.dropWbMaterial(handle)
        throw new Error("WB native material arrived after its scope changed")
      }
      const resident = Object.freeze({ platform: "wb" as const, handle, response: structuredClone(response),
        key: JSON.stringify([key, response.catalog?.content_digest ?? null, response.defaults?.revision ?? null, defaultsDigest]) })
      entries.set(key, resident)
      materials.set(key, structuredClone(response))
      if (existing) await options.core.dropWbMaterial(existing.handle)
      return { ...resident, response: structuredClone(resident.response) }
    })().finally(() => { budget.pending = undefined })
    budget.pending = job
    return job
  }
  return {
    get,
    /** No HTTP: refuses an expired lease instead of secretly refreshing during build. */
    requireHandle(coordinate: WbCoordinate): WbSchemaHandle {
      const entry = get(coordinate)
      if (!entry) throw new Error("WB material is not resident; explicitly open this coordinate")
      const catalog = entry.response.catalog
      const now = (options.now ?? Date.now)()
      if (!Number.isSafeInteger(now)) throw new Error("WB material lease cannot be checked with an invalid clock")
      if (catalog && now > catalog.expires_at_ms) throw new Error("WB material lease expired; explicitly refresh this coordinate")
      if (!entry.response.usable && catalog?.usable === true) throw new Error("WB metadata is not usable; ask the curator to review it against the current catalog")
      return entry.handle
    },
    open: (coordinate: WbCoordinate, signal?: AbortSignal) => load(coordinate, false, signal),
    refresh: (coordinate: WbCoordinate, signal?: AbortSignal) => load(coordinate, true, signal),
    /** Trap invalidation makes zero calls into the retired instance. */
    invalidate() { epoch++; entries.clear() },
    async close() {
      synchronize(); closed = true; epoch++
      const handles = [...entries.values()].map((entry) => entry.handle)
      entries.clear(); materials.clear()
      for (const handle of handles) await options.core.dropWbMaterial(handle)
    },
  }
}
