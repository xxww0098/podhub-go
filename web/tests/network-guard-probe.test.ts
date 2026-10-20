/**
 * Negative probe for the default-deny bootstrap, driven from the real scripts.
 *
 * Ordinary runs (the selector unset) only confirm the preload guard is the
 * global fetch, so `bun run check` stays green. The guard comes from the
 * web/package.json `test` script (`bun test --preload ./tests/network-guard.preload.ts
 * --parallel`); a direct targeted run must pass that `--preload` itself.
 *
 * PODHUB_NETWORK_GUARD_PROBE picks one independent negative scenario, set on the
 * root `bun run test` / `bun run check` (or a direct run with the explicit preload):
 *
 * - `body`: the test body makes unregistered requests and swallows every
 *   rejection the way business fallbacks do; the run must exit non-zero with a
 *   `[network-guard] FAIL` line from the guard's afterEach.
 * - `late`: the test body only schedules one request and returns; the request
 *   is attempted afterwards, while this file's afterEach waits for it (bounded
 *   by LATE_WAIT_MS, and only when this scenario scheduled something). The body
 *   makes no request, so a failure can only come from the late attempt: the run
 *   must exit non-zero with a `[network-guard] FAIL` line — attributed to the
 *   scheduling test or, depending on hook order, to "outside any test" by the
 *   next beforeEach / afterAll.
 *
 * `[network-guard-probe]` lines prove the run reached the test phase and, for
 * `late`, that the request really was attempted after its test returned, so a
 * build or dependency failure is never mistaken for the guard working. A
 * `[network-guard-probe] ERROR` line (unknown selector, late request never
 * attempted) is a broken probe, not guard evidence. The probe never starts a
 * check itself.
 */
import assert from "node:assert/strict"
import test from "node:test"

import type { NetworkGuard } from "./network-guard.preload.ts"

type AsyncHook = (fn: () => Promise<void> | void) => void

const PROBE_MARKER = "[network-guard-probe]"
const SELECTOR = process.env.PODHUB_NETWORK_GUARD_PROBE ?? ""
const LATE_DELAY_MS = 25
const LATE_WAIT_MS = 2_000

if (SELECTOR !== "" && SELECTOR !== "body" && SELECTOR !== "late") {
  throw new Error(`${PROBE_MARKER} ERROR unknown PODHUB_NETWORK_GUARD_PROBE=${SELECTOR.slice(0, 16)}; use body or late`)
}

function installedGuard(): NetworkGuard {
  const guard = (globalThis as unknown as Record<symbol, NetworkGuard | undefined>)[Symbol.for("podhub.network-guard")]
  assert.ok(guard, "tests/network-guard.preload.ts is not installed in this worker: run via the web/package.json test script or pass --preload")
  return guard
}

async function swallowed(url: string, init?: RequestInit): Promise<string> {
  try {
    await fetch(url, init)
    return "resolved"
  } catch (error) {
    // Deliberately swallowed: the failure must come from the guard hooks, not from here.
    return error instanceof Error ? error.message : String(error)
  }
}

/** The late request of the current test, settled once it was actually attempted. */
let lateAttempt: Promise<string> | null = null

async function awaitLateAttempt(): Promise<void> {
  const attempt = lateAttempt
  if (!attempt) return
  lateAttempt = null
  let timer: ReturnType<typeof setTimeout> | undefined
  const expiry = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), LATE_WAIT_MS)
  })
  const outcome = await Promise.race([attempt, expiry]).finally(() => clearTimeout(timer))
  if (outcome === null) {
    throw new Error(`${PROBE_MARKER} ERROR late request was never attempted within ${LATE_WAIT_MS}ms; not guard evidence`)
  }
  const refused = outcome.startsWith("[network-guard] blocked")
  console.error(`${PROBE_MARKER} late request attempted after its test returned; ${refused ? "the guard refused it" : "NOT refused by the guard"}`)
}

// File-scoped: waits only for a late request this file's `late` scenario scheduled.
const hooksSpecifier: string = "bun:test"
const hooks = (await import(hooksSpecifier)) as { afterEach: AsyncHook }
hooks.afterEach(awaitLateAttempt)

// First in the file, so an attempt attributed to "outside any test" also meets the next test's beforeEach.
test("network guard probe (late): a request attempted after its test returned still fails the run", () => {
  installedGuard()
  if (SELECTOR !== "late") return
  console.error(`${PROBE_MARKER} test phase reached; late: scheduling one caught request for after this test returns`)
  lateAttempt = new Promise((resolve) => {
    setTimeout(() => void swallowed("http://localhost:14920/api/late-probe").then(resolve), LATE_DELAY_MS)
  })
})

test("network guard probe (body): caught requests in a test body still fail the run", async () => {
  const guard = installedGuard()
  assert.equal(globalThis.fetch, guard.fetch)
  if (SELECTOR !== "body") return
  console.error(`${PROBE_MARKER} test phase reached; body: issuing caught unregistered requests`)
  await swallowed("/api/network-guard-probe", { method: "POST", body: "probe" })
  await swallowed("http://127.0.0.1:8080/api/health")
  await swallowed("https://network-guard-probe.invalid/probe")
})
