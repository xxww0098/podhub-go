// Browser half of the mock-network bootstrap acceptance (tests/mock-network.html),
// driven only by tests/run-mock-browser.ts. It proves the network boundary, not
// any business behaviour: no field rules, no platform adapter, no real API.
//
// The runner installs its context-level guard before this page exists, then
// calls `__mockNetworkRun(plan)`:
// - positive: read the real built listing-core WASM and one fixture JSON from
//   this origin (static), instantiate the WASM, and make one business call the
//   runner answers from a local mock;
// - negative: attempt every leak path the guard must catch — same-origin legacy
//   API / proxy prefixes, upload PUT, an allowlisted static path answering 302,
//   `/@fs/` outside installed packages, forbidden or encoded static paths,
//   cross-origin fetch, image, popup, Worker fetch, WebSockets, Service Worker,
//   and a late request — and swallow every failure, as business fallbacks
//   would. The runner must still fail.
// The page never replaces `window.fetch`: the outer context guard is the only
// boundary under test.
import { route } from "@/api/routes"
import wasmUrl from "../../wasm/dist/browser/listing-state.wasm?url"

import schemaFixtureUrl from "./fixtures/listing-core/decorative-wall-art-schema.json?url"

export type ProbeKind = "fetch" | "image" | "popup" | "worker-fetch" | "websocket" | "service-worker" | "late-fetch"

export type NegativeProbe = { kind: ProbeKind; url: string; method?: string }

export type MockNetworkPlan =
  | { scenario: "positive"; businessMarker: string }
  | { scenario: "negative"; probes: NegativeProbe[]; lateDelayMs: number }

/**
 * What the page itself saw of the Service Worker probe. Playwright's
 * `serviceWorkers: "block"` replaces `navigator.serviceWorker.register` with an
 * async no-op, so a blocked call resolves to `undefined`; a resolved call alone
 * is therefore no registration. The runner cross-checks this against the
 * context's own worker list and its request ledger.
 */
export type ServiceWorkerEvidence = {
  /** `registration` (a real ServiceWorkerRegistration), `undefined`, `rejected`, `unavailable` or the typeof of anything else. */
  registerReturned: string
  /** `getRegistrations()` length after the attempt; null if the page could not read it. */
  registrations: number | null
  /** Whether a Service Worker controls this page. */
  controlled: boolean
}

export type MockNetworkResult = {
  scenario: MockNetworkPlan["scenario"]
  ok: boolean
  failure?: string
  wasm?: { bytes: number; exports: number }
  fixture?: { bytes: number; topLevelKeys: number }
  business?: { status: number; answeredByMock: boolean }
  /** Page-side view only; the runner's ledger is the evidence. */
  probes?: { kind: ProbeKind; index: number; outcome: string }[]
  serviceWorker?: ServiceWorkerEvidence
}

export type MockNetworkWindow = {
  __mockNetworkReady?: boolean
  __mockNetworkRun?: (plan: MockNetworkPlan) => Promise<MockNetworkResult>
  __mockNetworkTeardown?: () => void
}

const PROBE_TIMEOUT_MS = 5_000

const workers: Worker[] = []
const timers: number[] = []
const popups: Window[] = []
const sockets: WebSocket[] = []

function show(result: MockNetworkResult) {
  const target = document.getElementById("result")
  if (target) target.textContent = JSON.stringify(result, null, 2)
}

// Same imports the listing-core fixture gives the module; only instantiation is checked here.
async function instantiateListingCore(bytes: ArrayBuffer): Promise<number> {
  let memory: WebAssembly.Memory | undefined
  const imports = {
    env: {
      fill_random(ptr: number, len: number) {
        if (!memory) throw new Error("fill_random called before instantiation finished")
        crypto.getRandomValues(new Uint8Array(memory.buffer, ptr, len))
      },
    },
  }
  const { instance } = await WebAssembly.instantiate(bytes, imports)
  memory = (instance.exports as unknown as { memory?: WebAssembly.Memory }).memory
  return Object.keys(instance.exports).length
}

async function runPositive(businessMarker: string): Promise<MockNetworkResult> {
  const wasmResponse = await fetch(wasmUrl)
  if (!wasmResponse.ok) return { scenario: "positive", ok: false, failure: `wasm status ${wasmResponse.status}` }
  const wasmBytes = await wasmResponse.arrayBuffer()
  const exports = await instantiateListingCore(wasmBytes)

  const fixtureResponse = await fetch(schemaFixtureUrl)
  if (!fixtureResponse.ok) return { scenario: "positive", ok: false, failure: `fixture status ${fixtureResponse.status}` }
  const fixtureText = await fixtureResponse.text()
  const fixture = JSON.parse(fixtureText) as Record<string, unknown>

  const businessResponse = await fetch(route("listingSubmit"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ fixture: "mock-network" }),
  })
  const answer = (await businessResponse.json()) as { fixture?: unknown }
  const answeredByMock = answer.fixture === businessMarker

  return {
    scenario: "positive",
    ok: exports > 0 && answeredByMock,
    failure: answeredByMock ? undefined : "business call was not answered by the local mock",
    wasm: { bytes: wasmBytes.byteLength, exports },
    fixture: { bytes: new TextEncoder().encode(fixtureText).byteLength, topLevelKeys: Object.keys(fixture).length },
    business: { status: businessResponse.status, answeredByMock },
  }
}

function withTimeout(start: (settle: (outcome: string) => void) => void): Promise<string> {
  return new Promise((resolve) => {
    let done = false
    const settle = (outcome: string) => {
      if (done) return
      done = true
      resolve(outcome)
    }
    timers.push(window.setTimeout(() => settle("timeout"), PROBE_TIMEOUT_MS))
    start(settle)
  })
}

async function swallowFetch(url: string, method: string): Promise<string> {
  try {
    const response = await fetch(url, { method, body: method === "GET" ? undefined : "probe" })
    return `response:${response.status}`
  } catch {
    return "rejected"
  }
}

let serviceWorkerEvidence: ServiceWorkerEvidence | undefined

// Records the real return, registrations and controller; "registered" means any
// of them shows a worker, whatever register() resolved to.
async function probeServiceWorker(url: string): Promise<string> {
  if (!("serviceWorker" in navigator)) {
    serviceWorkerEvidence = { registerReturned: "unavailable", registrations: null, controlled: false }
    return "unavailable"
  }
  let registerReturned: string
  try {
    const returned: unknown = await navigator.serviceWorker.register(url)
    registerReturned =
      returned === undefined ? "undefined" : returned instanceof ServiceWorkerRegistration ? "registration" : typeof returned
  } catch {
    registerReturned = "rejected"
  }
  let registrations: number | null
  try {
    registrations = (await navigator.serviceWorker.getRegistrations()).length
  } catch {
    registrations = null
  }
  const controlled = navigator.serviceWorker.controller !== null
  serviceWorkerEvidence = { registerReturned, registrations, controlled }
  return registerReturned === "registration" || (registrations ?? 0) > 0 || controlled ? "registered" : `blocked:${registerReturned}`
}

const WORKER_SOURCE = `self.onmessage = async (event) => {
  try { const response = await fetch(event.data); self.postMessage("response:" + response.status) }
  catch { self.postMessage("rejected") }
}`

async function runProbe(probe: NegativeProbe, lateDelayMs: number): Promise<string> {
  switch (probe.kind) {
    case "fetch":
      return swallowFetch(probe.url, probe.method ?? "GET")
    case "image":
      return withTimeout((settle) => {
        const image = new Image()
        image.onload = () => settle("response:load")
        image.onerror = () => settle("rejected")
        image.src = probe.url
      })
    case "popup": {
      const opened = window.open(probe.url, "_blank")
      if (opened) popups.push(opened)
      return opened ? "opened" : "not-opened"
    }
    case "worker-fetch":
      return withTimeout((settle) => {
        const source = URL.createObjectURL(new Blob([WORKER_SOURCE], { type: "text/javascript" }))
        const worker = new Worker(source)
        workers.push(worker)
        worker.onmessage = (event: MessageEvent<string>) => settle(event.data)
        worker.onerror = () => settle("worker-error")
        worker.postMessage(probe.url)
      })
    case "websocket":
      return withTimeout((settle) => {
        try {
          const socket = new WebSocket(probe.url)
          sockets.push(socket)
          socket.onclose = (event) => settle(`close:${event.code}`)
        } catch {
          settle("rejected")
        }
      })
    case "service-worker":
      return probeServiceWorker(probe.url)
    case "late-fetch":
      // Fires after the run reports done: the runner must count it while it settles.
      timers.push(window.setTimeout(() => void swallowFetch(probe.url, probe.method ?? "GET"), lateDelayMs))
      return "scheduled"
  }
}

async function runNegative(probes: NegativeProbe[], lateDelayMs: number): Promise<MockNetworkResult> {
  const outcomes: NonNullable<MockNetworkResult["probes"]> = []
  for (const [index, probe] of probes.entries()) {
    outcomes.push({ kind: probe.kind, index, outcome: await runProbe(probe, lateDelayMs) })
  }
  const escaped = outcomes.filter((entry) => entry.outcome.startsWith("response:") || entry.outcome === "registered")
  return {
    scenario: "negative",
    ok: escaped.length === 0,
    failure: escaped.length === 0 ? undefined : `${escaped.length} probe(s) got a real answer`,
    probes: outcomes,
    serviceWorker: serviceWorkerEvidence,
  }
}

const host = window as unknown as MockNetworkWindow

host.__mockNetworkRun = async (plan) => {
  let result: MockNetworkResult
  try {
    result = plan.scenario === "positive" ? await runPositive(plan.businessMarker) : await runNegative(plan.probes, plan.lateDelayMs)
  } catch (error) {
    const failure = error instanceof Error ? `${error.name}: ${error.message}`.slice(0, 200) : "non-error thrown"
    result = { scenario: plan.scenario, ok: false, failure }
  }
  show(result)
  return result
}

host.__mockNetworkTeardown = () => {
  for (const worker of workers.splice(0)) worker.terminate()
  for (const timer of timers.splice(0)) window.clearTimeout(timer)
  for (const popup of popups.splice(0)) popup.close()
  for (const socket of sockets.splice(0)) socket.close()
}

host.__mockNetworkReady = true
