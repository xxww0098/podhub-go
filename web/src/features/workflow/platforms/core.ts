/**
 * The contract every marketplace adapter meets, and nothing marketplace
 * specific (docs/adr/0109-marketplace-catalog-boundaries.md). An adapter owns
 * its own DTOs, field IDs, units and schema/language coordinate; this module
 * only knows "build and validate some frozen preview items". Ozon and Wildberries are the two real adapters that justify it.
 *
 * Build is pure local computation: no fetch, no Axum. A frozen item is a
 * preview of what the server will be asked to send — the server always
 * rechecks auth/tenant/store/revision, rebuilds the final body and owns
 * intent idempotency before anything is dispatched.
 */

/** One actionable problem. `message`/`remediation` are user-facing Chinese
 * written by this codebase; a raw external reason never goes there — it may
 * ride in `diagnostic`, which is for telemetry only and must not be rendered. */
export type PlatformIssue = Readonly<{
  platform: string
  stage: string
  /** The platform's own field coordinate (Ozon field key, `characteristic:<id>`,
   * `vendorCode`…); `null` when the issue is not about one field. */
  field: string | null
  code: string
  message: string
  remediation: string
  diagnostic?: string
}>

/** Which build stage produced a field's final value. */
export type Provenance = Readonly<{ field: string; stage: string }>

export type FrozenItem<Body> = Readonly<{
  /** The item's identity within its platform (row id, WB group key…). */
  key: string
  body: Body
  digest: string
  clientOperationId: string
  provenance: readonly Provenance[]
}>

export type BuildOutcome<Body> = Readonly<{
  frozen: readonly FrozenItem<Body>[]
  blocked: readonly Readonly<{ key: string; issues: readonly PlatformIssue[] }>[]
}>

export interface PlatformAdapter<Input, Body> {
  readonly platform: string
  /** Display name used in messages ("Ozon", "Wildberries"). */
  readonly label: string
  build(input: Input): Promise<BuildOutcome<Body>>
}

export function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const child of Object.values(value)) deepFreeze(child)
  }
  return value
}

/** `sha256:` + lowercase hex, the same spelling `listing-core` uses. */
export async function sha256(text: string): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)))
  return `sha256:${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`
}

/**
 * Cooperative time slicing for WASM-bound loops: after ~8ms of native work,
 * hand the thread back to the event loop before the next item, then restart
 * the budget. Each loop iteration already awaits native calls, so the extra
 * microtask on the fast path is invisible.
 */
export function createSliceBudget(): () => Promise<void> {
  let started = performance.now()
  return async () => {
    if (performance.now() - started < 8) return
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
    started = performance.now()
  }
}
