/** Local preview registry only. All sends/retries/reconciliation belong to S16 send-queue. */
import type { PlatformAdapter } from "./core"

export type PlatformRegistry = Readonly<Record<string, PlatformAdapter<never, unknown>>>

export function createPlatformRegistry<R extends PlatformRegistry>(adapters: R): R {
  for (const [key, adapter] of Object.entries(adapters)) {
    if (key !== adapter.platform) throw new Error(`platform adapter "${adapter.platform}" registered under "${key}"`)
  }
  return Object.freeze({ ...adapters })
}
