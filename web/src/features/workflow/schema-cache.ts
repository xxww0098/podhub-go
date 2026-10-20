/** Resident-only schema lookup. C reads happen only through explicit open/refresh. */
import type { SchemaLoadInput } from "@/listing-core/types"

export type SchemaIdentity = {
  platform: string
  coordinate: readonly (string | number)[]
  language: string
  materialDigest: string
  defaultsRevision: string
  sessionFence: string
}
export type ResidentSchema<P extends string = string> = Readonly<{ platform: P; handle: number; generation: number }>
const keyOf = (key: SchemaIdentity) => JSON.stringify([key.platform, key.coordinate, key.language, key.materialDigest, key.defaultsRevision, key.sessionFence])

export function createSchemaCache(core: {
  readonly generation?: number
  loadSchema(input: SchemaLoadInput): number | Promise<number>
  dropSchema(handle: number): void | Promise<void>
}) {
  let generation = 0
  const resident = new Map<string, ResidentSchema>()
  const pending = new Map<string, Promise<ResidentSchema>>()
  let instanceGeneration = core.generation
  function synchronize() {
    if (instanceGeneration === core.generation) return
    instanceGeneration = core.generation
    generation += 1; resident.clear(); pending.clear()
  }
  return {
    get(identity: SchemaIdentity): ResidentSchema | undefined { synchronize(); return resident.get(keyOf(identity)) },
    /** Call only on explicit open/refresh, with already-owned local material. */
    async load(identity: SchemaIdentity, material: SchemaLoadInput): Promise<ResidentSchema> {
      synchronize()
      const key = keyOf(identity)
      const cached = resident.get(key)
      if (cached) return cached
      const existing = pending.get(key)
      if (existing) return existing
      const captured = generation
      const job: Promise<ResidentSchema> = Promise.resolve().then(() => core.loadSchema(material)).then((handle) => {
        synchronize()
        if (captured !== generation) throw new Error("Schema generation changed while loading local material")
        const value = Object.freeze({ platform: identity.platform, handle, generation })
        resident.set(key, value)
        return value
      }).finally(() => { if (pending.get(key) === job) pending.delete(key) })
      pending.set(key, job)
      return job
    },
    /** Trap: no calls (including schema_drop) may reach the poisoned instance. */
    invalidate(): void { generation += 1; resident.clear(); pending.clear() },
    async close(): Promise<void> {
      synchronize()
      const entries = [...resident.values()]
      resident.clear(); pending.clear(); generation += 1
      for (const entry of entries) await core.dropSchema(entry.handle)
    },
  }
}
