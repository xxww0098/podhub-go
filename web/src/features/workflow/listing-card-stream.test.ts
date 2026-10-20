import assert from "node:assert/strict"
import test from "node:test"
import { listingRow } from "../../../tests/listing-row-fixture"
import { connectListingCardStream } from "./listing-card-stream"

class Connection extends EventTarget {
  static instances: Connection[] = []
  onerror?: () => void
  closed = false
  readonly cardId: string
  constructor(readonly url: string) {
    super()
    const spec = new URL(url, "http://local").searchParams.get("cards") ?? ""
    this.cardId = decodeURIComponent(spec.split(",")[0]?.split(":")[0] || "card")
    Connection.instances.push(this)
  }
  close() { this.closed = true }
  send(kind: string, seq: string, extra: Record<string, unknown> = {}) {
    const cardId = typeof extra.cardId === "string" ? extra.cardId : this.cardId
    this.dispatchEvent(new MessageEvent(kind, { lastEventId: seq, data: JSON.stringify({ workspaceId: "1", seq, rowId: extra.rowId ?? "a", row: extra.row ?? listingRow({ card_id: cardId }), ...extra, cardId }) }))
  }
  sendCardInvalidate(seq: string, extra: Record<string, unknown> = {}) {
    this.dispatchEvent(new MessageEvent("card.invalidate", { lastEventId: seq, data: JSON.stringify({ workspaceId: "1", cardId: this.cardId, seq, reason: "template_changed", psdTemplateSha256: "sha2", ...extra }) }))
  }
}

function snapshotData(cursor: string, rows = [listingRow()], cardId = "card") {
  return {
    workspace_id: "1", card_id: cardId, cursor, rows,
    summary: { unprepared: rows.length, preparing: 0, attention: 0, ready: 0, sending: 0, sent: 0 },
  }
}

// Exercise the actual transport with deterministic reconnects; no real delays.
test("applied event cursor survives duplicates, failed application, gaps, resets and closure", async (t) => {
  const timers: Array<() => void> = []
  t.mock.method(globalThis, "setTimeout", (fn: () => void) => { timers.push(fn); return timers.length as any })
  t.mock.method(globalThis, "clearTimeout", () => {})
  let snapshotCursor = "4"
  t.mock.method(globalThis, "fetch", async () => Response.json({ data: snapshotData(snapshotCursor) }))
  const original = globalThis.EventSource
  globalThis.EventSource = Connection as any
  t.after(() => { globalThis.EventSource = original; Connection.instances = [] })
  const drain = async () => { for (let i = 0; i < 12; i++) await Promise.resolve() }
  const applied: string[] = []
  let fail = false
  let snapshots = 0
  let lost = false
  const stop = connectListingCardStream("card", {
    snapshotStarting() {}, snapshot() { snapshots++ },
    upsertBatch(rows, removed) { if (fail) throw new Error("application failed"); applied.push(...rows.map(() => "upsert"), ...[...removed].map(() => "remove")) },
    invalidate() { applied.push("invalidate") },
    permissionLost() { lost = true }, error() {},
  })
  await drain()
  let connection = Connection.instances.at(-1)!
  assert.match(connection.url, /card:4$/)
  connection.send("row.upsert", "5")
  connection.send("row.upsert", "5")
  timers.shift()!()
  assert.deepEqual(applied, ["upsert"])
  fail = true
  connection.send("row.upsert", "6")
  timers.shift()!()
  assert.equal(connection.closed, true)
  timers.shift()!(); await drain()
  connection = Connection.instances.at(-1)!
  assert.match(connection.url, /card:4$/, "failed batch delivery recovers through a snapshot")
  fail = false
  connection.send("row.remove", "6", { row: null })
  snapshotCursor = "6"
  connection.send("row.upsert", "8")
  timers.shift()!(); await drain()
  connection = Connection.instances.at(-1)!
  assert.match(connection.url, /card:4$/, "a gap replays from the last applied event")
  connection.send("row.upsert", "7", { row: { ...listingRow(), projection: {} } })
  timers.shift()!(); await drain()
  connection = Connection.instances.at(-1)!
  assert.match(connection.url, /card:6$/, "malformed data cannot advance the cursor")
  connection.send("reset", "", { reason: "snapshot_required" })
  timers.shift()!(); await drain()
  assert.ok(snapshots >= 3, "repeated invalid delivery recovers by snapshot before an explicit reset")
  connection = Connection.instances.at(-1)!
  connection.send("reset", "", { reason: "permission_changed" })
  assert.equal(lost, true)
  assert.equal(connection.closed, true)
  connection.send("row.upsert", "5")
  assert.deepEqual(applied, ["upsert"])
  stop()
})

test("closing while a snapshot is in flight prevents the old Card from applying", async (t) => {
  let resolve!: (response: Response) => void
  t.mock.method(globalThis, "fetch", () => new Promise<Response>((done) => { resolve = done }))
  let applied = false
  const stop = connectListingCardStream("card", { snapshotStarting() {}, snapshot() { applied = true }, upsertBatch() {}, invalidate() {}, permissionLost() {}, error() {} })
  stop()
  resolve(Response.json({ data: snapshotData("0", []) }))
  for (let i = 0; i < 12; i++) await Promise.resolve()
  assert.equal(applied, false)
})

test("a refused snapshot stops instead of retrying inaccessible Workspace data", async (t) => {
  t.mock.method(globalThis, "fetch", async () => Response.json({ code: "FORBIDDEN" }, { status: 403 }))
  let lost = false
  const stop = connectListingCardStream("card", { snapshotStarting() {}, snapshot() { assert.fail() }, upsertBatch() {}, invalidate() {}, permissionLost() { lost = true }, error() { assert.fail() } })
  for (let i = 0; i < 12; i++) await Promise.resolve()
  assert.equal(lost, true)
  stop()
})

test("a newer HTTP row cannot skip another row's earlier stream event", async (t) => {
  const { listingRowDraftView } = await import("./workflow-actions")
  const store = await import("./workbench/listing-workbench-store")
  const card = {} as import("@/bindings/commands").WorkflowDraftView
  const initial = listingRow()
  t.mock.method(globalThis, "fetch", async () => Response.json({ data: snapshotData("106", [initial]) }))
  const original = globalThis.EventSource
  globalThis.EventSource = Connection as any
  store.resetListingWorkbench()
  const scope = store.listingWorkbenchScope()
  t.after(() => { globalThis.EventSource = original; Connection.instances = []; store.resetListingWorkbench() })
  const apply = (row: typeof initial) => store.receiveListingProducts([{ product: listingRowDraftView(row, card), readiness: row.projection.readiness }], new Set(), scope)
  const stop = connectListingCardStream("card", { snapshotStarting() {}, snapshot(snapshot) { snapshot.rows.forEach(apply) },
    upsertBatch(rows, removed) { rows.forEach(apply); store.receiveListingProducts([], removed, scope) }, invalidate() {}, permissionLost() { assert.fail() }, error(reason) { assert.fail(String(reason)) },
  })
  t.after(stop)
  for (let i = 0; i < 12; i++) await Promise.resolve()
  const httpRow = listingRow({ view_revision: 108 })
  store.projectListingProducts((current) => ({ ...current, a: listingRowDraftView(httpRow, card) }))
  const connection = Connection.instances.at(-1)!
  connection.send("row.upsert", "107", { rowId: "b", row: listingRow({ id: "b" }) })
  connection.send("row.upsert", "108", { row: initial })
  await new Promise<void>((resolve) => globalThis.setTimeout(resolve, 0))
  assert.equal(store.peekListingWorkbench().productBases.a?.lifecycle.view_revision, 108)
  assert.ok(store.peekListingWorkbench().productBases.b, "HTTP row A cannot acknowledge row B's event")
  connection.send("row.remove", "109", { rowId: "b", row: null })
  await new Promise<void>((resolve) => globalThis.setTimeout(resolve, 0))
  store.projectListingProducts((current) => ({ ...current, b: listingRowDraftView(listingRow({ id: "b", view_revision: 1000 }), card) }))
  assert.equal(store.peekListingWorkbench().productBases.b, undefined, "a late HTTP row cannot undo its stream tombstone")
})

test("out-of-order and stale events do not advance the applied cursor", async (t) => {
  const timers: Array<() => void> = []
  t.mock.method(globalThis, "setTimeout", (fn: () => void) => { timers.push(fn); return timers.length as any })
  t.mock.method(globalThis, "clearTimeout", () => {})
  t.mock.method(globalThis, "fetch", async () => Response.json({ data: snapshotData("4") }))
  const original = globalThis.EventSource
  globalThis.EventSource = Connection as any
  t.after(() => { globalThis.EventSource = original; Connection.instances = [] })
  const drain = async () => { for (let i = 0; i < 12; i++) await Promise.resolve() }
  const applied: string[] = []
  const stop = connectListingCardStream("card", {
    snapshotStarting() {}, snapshot() {},
    upsertBatch(rows) { applied.push(...rows.map(() => "upsert")) }, invalidate() {}, permissionLost() {}, error() {},
  })
  t.after(stop)
  await drain()
  let connection = Connection.instances.at(-1)!
  connection.send("row.upsert", "7")
  assert.equal(applied.length, 0)
  assert.equal(connection.closed, true)
  timers.shift()!()
  await drain()
  connection = Connection.instances.at(-1)!
  assert.match(connection.url, /card:4$/)
  connection.send("row.upsert", "3")
  assert.equal(applied.length, 0)
  assert.match(connection.url, /card:4$/)
})

test("resync_required and a stale cursor recover by snapshot", async (t) => {
  const timers: Array<() => void> = []
  t.mock.method(globalThis, "setTimeout", (fn: () => void) => { timers.push(fn); return timers.length as any })
  t.mock.method(globalThis, "clearTimeout", () => {})
  let snapshots = 0
  t.mock.method(globalThis, "fetch", async () => Response.json({ data: snapshotData("4") }))
  const original = globalThis.EventSource
  globalThis.EventSource = Connection as any
  t.after(() => { globalThis.EventSource = original; Connection.instances = [] })
  const drain = async () => { for (let i = 0; i < 12; i++) await Promise.resolve() }
  const stop = connectListingCardStream("card", {
    snapshotStarting() {}, snapshot() { snapshots++ },
    upsertBatch() {}, invalidate() {}, permissionLost() {}, error() {},
  })
  t.after(stop)
  await drain()
  assert.equal(snapshots, 1)
  Connection.instances.at(-1)!.send("resync_required", "", { reason: "resync_required" })
  timers.shift()!()
  await drain()
  assert.equal(snapshots, 2)
})

test("healthy SSE slows polling signal and batches a burst to the newest row", async (t) => {
  const timers: Array<() => void> = []
  t.mock.method(globalThis, "setTimeout", (fn: () => void) => { timers.push(fn); return timers.length as any })
  t.mock.method(globalThis, "clearTimeout", () => {})
  t.mock.method(globalThis, "fetch", async () => Response.json({ data: snapshotData("0") }))
  const original = globalThis.EventSource
  globalThis.EventSource = Connection as any
  t.after(() => { globalThis.EventSource = original; Connection.instances = [] })
  const healthy: boolean[] = []
  const batches: Array<{ rows: ReturnType<typeof listingRow>[]; removed: ReadonlySet<string> }> = []
  const stop = connectListingCardStream("card", {
    snapshotStarting() {}, snapshot() {},
    upsertBatch(rows, removed) { batches.push({ rows: rows as ReturnType<typeof listingRow>[], removed }) },
    invalidate() {},
    permissionLost() {}, error() {}, health(value) { healthy.push(value) },
  })
  t.after(stop)
  for (let i = 0; i < 12; i++) await Promise.resolve()
  const connection = Connection.instances.at(-1)!
  connection.dispatchEvent(new Event("open"))
  for (let i = 1; i <= 1000; i++) {
    connection.send("row.upsert", String(i), { row: listingRow({ view_revision: i }) })
  }
  connection.send("row.remove", "1001", { rowId: "gone", row: null })
  assert.equal(batches.length, 0, "a burst waits for one frame")
  timers.shift()!()
  const batch = batches.at(0)
  assert.ok(batch)
  assert.equal(batches.length, 1)
  assert.equal(batch.rows.length, 1)
  assert.equal(batch.rows[0]!.view_revision, 1000)
  assert.deepEqual([...batch.removed], ["gone"])
  assert.deepEqual(healthy, [true])
  connection.onerror?.()
  assert.deepEqual(healthy, [true, false])
  timers.shift()!()
  for (let i = 0; i < 12; i++) await Promise.resolve()
  Connection.instances.at(-1)!.dispatchEvent(new Event("open"))
  assert.deepEqual(healthy, [true, false, true])
})

test("an unflushed frame is replayed after disconnect and discarded on permission loss", async (t) => {
  const timers: Array<() => void> = []
  t.mock.method(globalThis, "setTimeout", (fn: () => void) => { timers.push(fn); return timers.length as any })
  t.mock.method(globalThis, "clearTimeout", () => {})
  t.mock.method(globalThis, "fetch", async () => Response.json({ data: snapshotData("0") }))
  const original = globalThis.EventSource
  globalThis.EventSource = Connection as any
  t.after(() => { globalThis.EventSource = original; Connection.instances = [] })
  let deliveries = 0
  const stop = connectListingCardStream("card", {
    snapshotStarting() {}, snapshot() {},
    upsertBatch() { deliveries++ }, invalidate() {}, permissionLost() {}, error() {},
  })
  t.after(stop)
  for (let i = 0; i < 12; i++) await Promise.resolve()
  let connection = Connection.instances.at(-1)!
  connection.send("row.upsert", "1")
  connection.onerror?.()
  timers.shift()!()
  for (let i = 0; i < 12; i++) await Promise.resolve()
  connection = Connection.instances.at(-1)!
  assert.match(connection.url, /card:0$/, "unflushed events remain replayable")
  connection.send("row.upsert", "1")
  connection.send("reset", "", { reason: "permission_changed" })
  assert.equal(deliveries, 0, "permission loss drops the pending frame")
})

test("a valid prefix cancelled by a bad event still reaches snapshot fallback", async (t) => {
  const timers: Array<() => void> = []
  t.mock.method(globalThis, "setTimeout", (fn: () => void) => { timers.push(fn); return timers.length as any })
  t.mock.method(globalThis, "clearTimeout", () => {})
  let snapshots = 0
  t.mock.method(globalThis, "fetch", async () => { snapshots++; return Response.json({ data: snapshotData("0") }) })
  const original = globalThis.EventSource
  globalThis.EventSource = Connection as any
  t.after(() => { globalThis.EventSource = original; Connection.instances = [] })
  const stop = connectListingCardStream("card", {
    snapshotStarting() {}, snapshot() {}, upsertBatch() {}, invalidate() {}, permissionLost() {}, error() {},
  })
  t.after(stop)
  for (let i = 0; i < 12; i++) await Promise.resolve()
  for (let attempt = 0; attempt < 6; attempt++) {
    const connection = Connection.instances.at(-1)!
    connection.send("row.upsert", "1", { row: listingRow({ view_revision: 1 }) })
    connection.send("row.upsert", "2", { row: { ...listingRow({ view_revision: 2 }), projection: {} } })
    while (timers.length) timers.shift()!()
    for (let i = 0; i < 12; i++) await Promise.resolve()
    if (snapshots > 1) break
  }
  assert.ok(snapshots > 1, "repeated cancelled prefixes eventually require a fresh snapshot")
})

test("snapshot reconnect never starts prepare or recognize", async (t) => {
  const timers: Array<() => void> = []
  t.mock.method(globalThis, "setTimeout", (fn: () => void) => { timers.push(fn); return timers.length as any })
  t.mock.method(globalThis, "clearTimeout", () => {})
  const urls: string[] = []
  t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL) => {
    const url = String(input)
    urls.push(url)
    if (/prepare|recognize|ai\/settle|jobs\/.*claim/i.test(url)) {
      throw new Error(`refresh must not buy OCR: ${url}`)
    }
    return Response.json({ data: snapshotData("1") })
  })
  const original = globalThis.EventSource
  globalThis.EventSource = Connection as any
  t.after(() => { globalThis.EventSource = original; Connection.instances = [] })
  const drain = async () => { for (let i = 0; i < 12; i++) await Promise.resolve() }
  const stop = connectListingCardStream("card", {
    snapshotStarting() {}, snapshot() {}, upsertBatch() {}, invalidate() {}, permissionLost() {}, error() {},
  })
  t.after(stop)
  await drain()
  Connection.instances.at(-1)!.onerror?.()
  timers.shift()!()
  await drain()
  Connection.instances.at(-1)!.send("reset", "", { reason: "snapshot_required" })
  timers.shift()!()
  await drain()
  assert.ok(urls.every((url) => url.includes("/snapshot")))
  assert.ok(urls.length >= 2)
})

test("card switch, refresh and reconnect keep a manual edit and do not re-prepare", async (t) => {
  const { listingRowDraftView } = await import("./workflow-actions")
  const store = await import("./workbench/listing-workbench-store")
  const { leftoverStageRetries } = await import("./prepare/preparation-branches")
  const { workbenchLiveStatus } = await import("./workbench/workbench-live-status")
  const { NO_GUIDED_PREPARATION, NO_PREPARATION_ACTIVITY, NO_PREPARATION_PROGRESS } = await import("./prepare/preparation-tracks")
  const card = {} as import("@/bindings/commands").WorkflowDraftView
  const timers: Array<() => void> = []
  t.mock.method(globalThis, "setTimeout", (fn: () => void) => { timers.push(fn); return timers.length as any })
  t.mock.method(globalThis, "clearTimeout", () => {})
  const urls: string[] = []
  t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL) => {
    const url = String(input)
    urls.push(url)
    if (/prepare|recognize|ai\/settle|jobs\/.*claim/i.test(url)) {
      throw new Error(`refresh must not re-prepare: ${url}`)
    }
    const cardId = decodeURIComponent(url.match(/cards\/([^/]+)/)?.[1] ?? "card-a")
    const row = listingRow({
      id: "a", card_id: cardId,
      revision: cardId === "card-a" ? 20 : 4,
      view_revision: cardId === "card-a" ? 20 : 4,
      draft: { values: { name: { kind: "text", value: cardId === "card-a" ? "Nastennaya kartina" : "B" } }, complex_values: [] },
      projection: { ...listingRow().projection, ai: "ready", media: "ready" },
    })
    return Response.json({ data: snapshotData(cardId === "card-a" ? "20" : "4", [row], cardId) })
  })
  const original = globalThis.EventSource
  globalThis.EventSource = Connection as any
  store.resetListingWorkbench()
  t.after(() => { globalThis.EventSource = original; Connection.instances = []; store.resetListingWorkbench() })
  const drain = async () => { for (let i = 0; i < 12; i++) await Promise.resolve() }
  const apply = (row: ReturnType<typeof listingRow>) =>
    store.receiveListingProducts([{ product: listingRowDraftView(row, card), readiness: row.projection.readiness }], new Set(), store.listingWorkbenchScope())
  const stopA = connectListingCardStream("card-a", {
    snapshotStarting() {}, snapshot(snapshot) { snapshot.rows.forEach(apply) },
    upsertBatch(rows) { rows.forEach(apply) }, invalidate() {}, permissionLost() {}, error(reason) { assert.fail(String(reason)) },
  })
  await drain()
  const opened = store.peekListingWorkbench().productDrafts.a!
  store.editListingProduct("a", {
    ...opened,
    draft: { ...opened.draft, values: { ...opened.draft.values, name: { kind: "text", value: "mine" } } },
  })
  Connection.instances.at(-1)!.send("row.upsert", "21", {
    row: listingRow({
      id: "a", card_id: "card-a", revision: 21, view_revision: 21,
      draft: { values: { name: { kind: "text", value: "Nastennaya kartina" } }, complex_values: [] },
      projection: { ...listingRow().projection, ai: "ready", media: "ready" },
    }),
  })
  timers.shift()!()
  assert.equal(store.peekListingWorkbench().productDrafts.a?.draft.values.name?.value, "mine")
  assert.equal(store.peekListingWorkbench().productBases.a?.lifecycle.view_revision, 21)
  stopA()
  store.resetListingWorkbench()
  const stopB = connectListingCardStream("card-b", {
    snapshotStarting() {}, snapshot(snapshot) { snapshot.rows.forEach(apply) },
    upsertBatch(rows) { rows.forEach(apply) }, invalidate() {}, permissionLost() {}, error(reason) { assert.fail(String(reason)) },
  })
  t.after(stopB)
  await drain()
  assert.equal(store.peekListingWorkbench().productDrafts.a?.draft.values.name?.value, "B")
  Connection.instances.find((connection) => connection.cardId === "card-a")?.send("row.upsert", "22", {
    row: listingRow({
      id: "a", card_id: "card-a", revision: 1, view_revision: 1,
      draft: { values: { name: { kind: "text", value: "stale A" } }, complex_values: [] },
    }),
  })
  assert.equal(store.peekListingWorkbench().productDrafts.a?.draft.values.name?.value, "B")
  assert.ok((store.peekListingWorkbench().productBases.a?.lifecycle.view_revision ?? 0) >= 4)
  Connection.instances.at(-1)!.onerror?.()
  timers.shift()!()
  await drain()
  Connection.instances.at(-1)!.send("reset", "", { reason: "snapshot_required" })
  timers.shift()!()
  await drain()
  assert.ok(urls.every((url) => url.includes("/snapshot")))
  assert.ok(urls.some((url) => url.includes("card-b")))
  const leftovers = leftoverStageRetries(
    [{ id: "a", ai: "done", render: "done", upload: "done" }],
    { deliver: { active: false, failedRowIds: ["a"] } },
  )
  assert.deepEqual(leftovers, { ai: [], render: [], deliver: [] })
  const cards = workbenchLiveStatus({
    queueRunning: false, queuePaused: false, storeConfigured: true,
    progress: { ...NO_PREPARATION_PROGRESS, deliver: { total: 1, settled: 1, failed: 0, failedRowIds: [], active: false } },
    guided: NO_GUIDED_PREPARATION,
    activity: NO_PREPARATION_ACTIVITY,
    rows: [{ id: "a", ai: "done", render: "done", upload: "done" }],
    retryDisabled: false,
  })
  assert.equal(cards.some((item) => item.action?.key?.startsWith("retry-")), false)
})

test("one workspace shares one EventSource across its cards", async (t) => {
  const timers: Array<() => void> = []
  t.mock.method(globalThis, "setTimeout", (fn: () => void) => { timers.push(fn); return timers.length as any })
  t.mock.method(globalThis, "clearTimeout", () => {})
  t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL) => {
    const cardId = decodeURIComponent(String(input).match(/cards\/([^/]+)/)?.[1] ?? "card-a")
    const cursor = cardId === "card-b" ? "0" : "4"
    return Response.json({ data: snapshotData(cursor, [listingRow({ card_id: cardId, id: "a" })], cardId) })
  })
  const original = globalThis.EventSource
  globalThis.EventSource = Connection as any
  let stopA = () => {}
  let stopB = () => {}
  t.after(() => {
    stopA()
    stopB()
    globalThis.EventSource = original
    Connection.instances = []
  })
  const drain = async () => { for (let i = 0; i < 12; i++) await Promise.resolve() }
  const seen: string[] = []
  stopA = connectListingCardStream("card-a", {
    snapshotStarting() {}, snapshot() {},
    upsertBatch(rows) { seen.push(...rows.map((row) => row.card_id)) },
    invalidate() { seen.push("invalidate:card-a") },
    permissionLost() {}, error(reason) { assert.fail(String(reason)) },
  })
  await drain()
  stopB = connectListingCardStream("card-b", {
    snapshotStarting() {}, snapshot() {},
    upsertBatch(rows) { seen.push(...rows.map((row) => `b:${row.card_id}`)) },
    invalidate() { seen.push("invalidate:card-b") },
    permissionLost() {}, error(reason) { assert.fail(String(reason)) },
  })
  await drain()
  const open = Connection.instances.filter((connection) => !connection.closed)
  assert.equal(open.length, 1)
  assert.match(open[0]!.url, /card-a:4/)
  assert.match(open[0]!.url, /card-b:0/)
  open[0]!.send("row.upsert", "5", { cardId: "card-a", row: listingRow({ card_id: "card-a", id: "a" }) })
  open[0]!.send("row.upsert", "1", { cardId: "card-b", row: listingRow({ card_id: "card-b", id: "a" }) })
  open[0]!.sendCardInvalidate("6", { cardId: "card-a" })
  while (timers.length) timers.shift()!()
  assert.deepEqual(seen, ["card-a", "invalidate:card-a", "b:card-b"])
  assert.equal(Connection.instances.filter((connection) => !connection.closed).length, 1)
})

test("card invalidate applies coalesced after the frame's rows and keeps the sequence dense", async (t) => {
  const timers: Array<() => void> = []
  t.mock.method(globalThis, "setTimeout", (fn: () => void) => { timers.push(fn); return timers.length as any })
  t.mock.method(globalThis, "clearTimeout", () => {})
  let snapshots = 0
  t.mock.method(globalThis, "fetch", async () => { snapshots++; return Response.json({ data: snapshotData("4") }) })
  const original = globalThis.EventSource
  globalThis.EventSource = Connection as any
  t.after(() => { globalThis.EventSource = original; Connection.instances = [] })
  const drain = async () => { for (let i = 0; i < 12; i++) await Promise.resolve() }
  const events: string[] = []
  const stop = connectListingCardStream("card", {
    snapshotStarting() {}, snapshot() {},
    upsertBatch(rows) { events.push(...rows.map(() => "upsert")) },
    invalidate() { events.push("invalidate") },
    permissionLost() {}, error() {},
  })
  t.after(stop)
  await drain()
  assert.equal(snapshots, 1)
  let connection = Connection.instances.at(-1)!
  connection.send("row.upsert", "5")
  connection.sendCardInvalidate("6")
  connection.sendCardInvalidate("6", { psdTemplateSha256: "ignored" })
  assert.equal(events.length, 0, "delivery waits for one frame")
  timers.shift()!()
  assert.deepEqual(events, ["upsert", "invalidate"], "rows apply first, the invalidation coalesces to one call")
  assert.equal(connection.closed, false, "a handled card event must not reset the stream")
  connection.send("row.upsert", "7")
  timers.shift()!()
  assert.deepEqual(events, ["upsert", "invalidate", "upsert"], "the consumed seq keeps later events dense")
  assert.equal(snapshots, 1, "no snapshot rebuild happened")
  // A malformed card event never advances the cursor: the first failure only
  // reconnects from the applied cursor, and the replayed malformed event then
  // forces the snapshot fallback.
  connection.sendCardInvalidate("8", { psdTemplateSha256: 47 })
  timers.shift()!()
  await drain()
  connection = Connection.instances.at(-1)!
  assert.match(connection.url, /card:7$/, "the malformed event cannot advance the applied cursor")
  assert.equal(snapshots, 1, "the first failure reconnects instead of snapshotting")
  connection.sendCardInvalidate("8", { psdTemplateSha256: 47 })
  timers.shift()!()
  await drain()
  assert.ok(snapshots >= 2, "the repeated malformed event recovers through a snapshot")
})

test("a row-only client recovers from the seq a card event consumes by snapshot and never keeps stale media sendable", async (t) => {
  const { listingRowDraftView } = await import("./workflow-actions")
  const store = await import("./workbench/listing-workbench-store")
  const card = {} as import("@/bindings/commands").WorkflowDraftView
  const timers: Array<() => void> = []
  t.mock.method(globalThis, "setTimeout", (fn: () => void) => { timers.push(fn); return timers.length as any })
  t.mock.method(globalThis, "clearTimeout", () => {})
  let snapshotCount = 0
  const appliedBatches: Array<number[]> = []
  t.mock.method(globalThis, "fetch", async () => {
    snapshotCount++
    const preChange = listingRow({ id: "a", revision: 28, view_revision: 28, projection: { ...listingRow().projection, media: "ready" } })
    const postChange = listingRow({ id: "a", revision: 30, view_revision: 30, projection: { ...listingRow().projection, media: "failed" } })
    return Response.json({ data: snapshotData(snapshotCount === 1 ? "28" : "30", [snapshotCount === 1 ? preChange : postChange]) })
  })
  const original = globalThis.EventSource
  globalThis.EventSource = Connection as any
  store.resetListingWorkbench()
  const scope = store.listingWorkbenchScope()
  t.after(() => { globalThis.EventSource = original; Connection.instances = []; store.resetListingWorkbench() })
  const apply = (rows: ReturnType<typeof listingRow>[]) =>
    store.receiveListingProducts(rows.map((rowValue) => ({ product: listingRowDraftView(rowValue, card), readiness: rowValue.projection.readiness })), new Set(), scope)
  const stop = connectListingCardStream("card", {
    snapshotStarting() {}, snapshot(snapshot) { apply(snapshot.rows) },
    upsertBatch(rows) { apply(rows as ReturnType<typeof listingRow>[]); appliedBatches.push(rows.map((rowValue) => rowValue.view_revision)) },
    invalidate() { assert.fail("a row-only client never applies the card event") },
    permissionLost() {}, error() {},
  })
  t.after(stop)
  for (let i = 0; i < 12; i++) await Promise.resolve()
  assert.equal(snapshotCount, 1)
  assert.equal(store.peekListingWorkbench().productBases.a?.lifecycle.view_revision, 28)
  // The wire carries the card event at 29, but a row-only (deployed) client
  // has no listener for it — the seq is simply consumed, on the live
  // connection AND on every replay. The next row event at 30 violates the
  // continuity gate: first failure reconnects from the applied cursor, and
  // the replayed gap forces the snapshot rebuild (the D-05 designed path).
  const sendPostChangeRow = () =>
    Connection.instances.at(-1)!.send("row.upsert", "30", { rowId: "a", row: listingRow({ id: "a", revision: 30, view_revision: 30, projection: { ...listingRow().projection, media: "failed" } }) })
  sendPostChangeRow()
  timers.shift()!()
  for (let i = 0; i < 12; i++) await Promise.resolve()
  assert.match(Connection.instances.at(-1)!.url, /card:28$/, "the first failure reconnects from the applied cursor")
  sendPostChangeRow()
  timers.shift()!()
  for (let i = 0; i < 12; i++) await Promise.resolve()
  assert.equal(snapshotCount, 2, "the replayed gap forces the snapshot rebuild (D-05 designed recovery)")
  const connection = Connection.instances.at(-1)!
  assert.match(connection.url, /card:30$/, "the client resumes from the fresh snapshot")
  assert.equal(store.peekListingWorkbench().productBases.a?.lifecycle.view_revision, 30, "the post-change authority replaces the local facts")
  assert.ok(appliedBatches.at(-1) === undefined || appliedBatches.at(-1)!.every((viewRevision) => viewRevision >= 30), "no stale media state is ever delivered after the rebuild")
  connection.send("row.upsert", "31", { rowId: "a", row: listingRow({ id: "a", revision: 31, view_revision: 31 }) })
  timers.shift()!()
  assert.deepEqual(appliedBatches.at(-1), [31], "the rebuilt client continues densely")
})
