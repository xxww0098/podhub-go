import { api } from "@/api/client"
import type { ListingRowView } from "@/bindings/listing-projection"
import { forgetListingRows, rememberListingRows, rowCacheScope, type RowCacheScope } from "@/bindings/listing-row-cache"
import { route } from "@/api/routes"
import type { components } from "@/api/schema"
import { isRecord } from "@/lib/utils"

const PREPARE_COUNTS = ["unprepared", "preparing", "attention", "ready", "sending", "sent"] as const
type Snapshot = Omit<components["schemas"]["ListingCardSnapshotData"], "rows"> & {
  rows: ListingRowView[]
  summary: Record<(typeof PREPARE_COUNTS)[number], number>
}

type Change = components["schemas"]["ListingRowEventData"]
type Handlers = {
  snapshotStarting: () => void
  snapshot: (snapshot: Snapshot) => void
  /** Coalesced stream delivery for one render frame. */
  upsertBatch: (rows: ListingRowView[], removed: ReadonlySet<string>) => void
  /** Applied after row events in the same frame. */
  invalidate: () => void
  permissionLost: () => void
  error: (reason: unknown) => void
  health?: (healthy: boolean) => void
}

function cursor(value: unknown): value is string {
  return typeof value === "string" && /^(0|[1-9]\d*)$/.test(value) && BigInt(value) <= 9_223_372_036_854_775_807n
}
function natural(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0
}

/** Validate the received boundary before any cache mutation or cursor advance. */
function row(value: unknown, cardId: string): value is ListingRowView {
  if (!isRecord(value) || typeof value.id !== "string" || value.card_id !== cardId ||
      !natural(value.revision) || !natural(value.view_revision) || value.view_revision < 1 ||
      !isRecord(value.draft) || !isRecord(value.draft.values) || !Array.isArray(value.draft.complex_values) ||
      !isRecord(value.payload) || !isRecord(value.source) || !isRecord(value.media) || !isRecord(value.ai) ||
      !Array.isArray(value.validation_issues) || !isRecord(value.projection)) return false
  const projection = value.projection
  const report = projection.readiness
  return ["awaiting_content", "recognizing", "recognition_failed", "rendering", "uploading", "media_failed", "candidates_pending", "build_stale", "fields_invalid", "ready_to_publish", "queued", "submitting", "outcome_unknown", "accepted", "publish_rejected", "operator_attested"].includes(String(projection.stage)) &&
    ["pending", "running", "ready", "failed"].includes(String(projection.ai)) &&
    ["pending", "rendering", "rendered", "uploading", "ready", "failed"].includes(String(projection.media)) &&
    ["dirty", "validating", "invalid", "valid"].includes(String(projection.fields)) &&
    (projection.media_failure_stage === undefined || projection.media_failure_stage === null || ["render", "upload"].includes(String(projection.media_failure_stage))) &&
    natural(projection.image_total) && natural(projection.image_completed) && projection.image_completed <= projection.image_total &&
    isRecord(report) && typeof report.ready_to_publish === "boolean" && typeof report.can_start_publish_attempt === "boolean" &&
    Array.isArray(report.blockers) && report.blockers.every((value) => typeof value === "string") &&
    Array.isArray(report.allowed_actions) && report.allowed_actions.every((value) => typeof value === "string")
}

function summary(value: unknown, rows: number): value is Snapshot["summary"] {
  if (!isRecord(value)) return false
  let total = 0
  for (const key of PREPARE_COUNTS) {
    if (!natural(value[key])) return false
    total += value[key] as number
  }
  return total === rows
}

type Member = {
  cardId: string
  applied: () => string
  listening: () => boolean
  onOpen: () => void
  onError: () => void
  onData: (kind: "row.upsert" | "row.remove", message: MessageEvent) => void
  onInvalidate: (message: MessageEvent) => void
  onControl: (kind: "reset" | "resync_required", message: MessageEvent) => void
  onPermission: () => void
}

type Hub = {
  members: Set<Member>
  source?: EventSource
  generation: number
}

const hubs = new Map<string, Hub>()

function reconnect(workspaceId: string) {
  const hub = hubs.get(workspaceId)
  if (!hub) return
  const live = [...hub.members]
  hub.source?.close()
  hub.source = undefined
  if (live.length === 0) {
    hubs.delete(workspaceId)
    return
  }
  const generation = ++hub.generation
  const spec = live
    .map((member) => `${encodeURIComponent(member.cardId)}:${encodeURIComponent(member.applied())}`)
    .join(",")
  const connection = new EventSource(`${route("listingEvents")}?cards=${spec}`, { withCredentials: true })
  hub.source = connection
  const active = () => hubs.get(workspaceId) === hub && hub.generation === generation && hub.source === connection
  connection.addEventListener("open", () => {
    if (!active()) return
    for (const member of hub.members) if (member.listening()) member.onOpen()
  })
  for (const kind of ["row.upsert", "row.remove"] as const) {
    connection.addEventListener(kind, (message) => {
      if (!active()) return
      let cardId = ""
      try {
        const change: unknown = JSON.parse((message as MessageEvent).data)
        if (isRecord(change) && typeof change.cardId === "string") cardId = change.cardId
      } catch { /* the member reports the bad payload */ }
      const member = [...hub.members].find((item) => item.cardId === cardId)
      member?.onData(kind, message as MessageEvent)
    })
  }
  connection.addEventListener("card.invalidate", (message) => {
    if (!active()) return
    let cardId = ""
    try {
      const change: unknown = JSON.parse((message as MessageEvent).data)
      if (isRecord(change) && typeof change.cardId === "string") cardId = change.cardId
    } catch { /* a malformed event is reported by its member when scoped */ }
    const member = [...hub.members].find((item) => item.cardId === cardId)
    member?.onInvalidate(message as MessageEvent)
  })
  for (const kind of ["reset", "resync_required"] as const) {
    connection.addEventListener(kind, (message) => {
      if (!active()) return
      let cardId = ""
      let reason = ""
      try {
        const reset: unknown = JSON.parse((message as MessageEvent).data)
        if (isRecord(reset)) {
          if (typeof reset.cardId === "string") cardId = reset.cardId
          if (typeof reset.reason === "string") reason = reset.reason
        }
      } catch { /* member retry */ }
      if (reason === "permission_changed") {
        const members = [...hub.members]
        hub.source?.close()
        hub.members.clear()
        hubs.delete(workspaceId)
        for (const member of members) member.onPermission()
        return
      }
      const member = [...hub.members].find((item) => item.cardId === cardId) ?? [...hub.members][0]
      member?.onControl(kind, message as MessageEvent)
    })
  }
  connection.onerror = () => {
    if (!active()) return
    // One connection serves every card in this workspace; the error belongs
    // to all of them, or only member zero would ever back off or retry.
    for (const member of hub.members) member.onError()
  }
}

function bind(workspaceId: string, member: Member): () => void {
  let hub = hubs.get(workspaceId)
  if (!hub) {
    hub = { members: new Set(), generation: 0 }
    hubs.set(workspaceId, hub)
  }
  hub.members.add(member)
  return () => {
    const current = hubs.get(workspaceId)
    if (!current) return
    current.members.delete(member)
    if (current.members.size === 0) {
      current.source?.close()
      hubs.delete(workspaceId)
      return
    }
    reconnect(workspaceId)
  }
}

/** HTTP responses never touch this owner's applied SSE cursor. */
export function connectListingCardStream(cardId: string, handlers: Handlers): () => void {
  let stopped = false
  let generation = 0
  let listening = -1
  let workspaceId = ""
  let applied = "0"
  let received = "0"
  let timer: ReturnType<typeof setTimeout> | undefined
  let failures = 0
  let lastError = ""
  let unbind = () => {}
  let bound = false
  const pendingRows = new Map<string, ListingRowView>()
  const pendingRemovals = new Set<string>()
  let pendingInvalidation = false
  let frame: number | undefined
  /** Taken before the snapshot GET this stream's events continue from. */
  let cacheScope: RowCacheScope | undefined

  function flushBatch() {
    frame = undefined
    if (!pendingRows.size && !pendingRemovals.size && !pendingInvalidation) return
    const rows = [...pendingRows.values()]
    const removed = new Set(pendingRemovals)
    const invalidate = pendingInvalidation
    pendingRows.clear()
    pendingRemovals.clear()
    pendingInvalidation = false
    try {
      if (rows.length || removed.size) handlers.upsertBatch(rows, removed)
      if (cacheScope) {
        rememberListingRows(rows, cacheScope)
        forgetListingRows(removed, cacheScope)
      }
      if (invalidate) handlers.invalidate()
      applied = received
      failures = 0
      lastError = ""
    } catch (reason) {
      retry(true, reason)
    }
  }
  function scheduleBatch() {
    if (frame !== undefined) return
    if (typeof requestAnimationFrame === "function") frame = requestAnimationFrame(flushBatch)
    else frame = setTimeout(flushBatch, 0) as unknown as number
  }
  function cancelBatch() {
    if (frame !== undefined) {
      if (typeof cancelAnimationFrame === "function") cancelAnimationFrame(frame)
      else clearTimeout(frame)
      frame = undefined
    }
    pendingRows.clear()
    pendingRemovals.clear()
    pendingInvalidation = false
    received = applied
  }
  function close() {
    const hub = hubs.get(workspaceId)
    hub?.source?.close()
    if (hub) hub.source = undefined
  }
  function open() {
    if (stopped || !workspaceId) return
    listening = ++generation
    reconnect(workspaceId)
  }
  function retry(snapshot: boolean, reason?: unknown) {
    close()
    generation++
    cancelBatch()
    handlers.health?.(false)
    if (stopped || timer) return
    const message = reason instanceof Error ? reason.message : String(reason ?? "")
    if (message && message !== lastError) { lastError = message; handlers.error(reason) }
    const needsSnapshot = snapshot || failures > 0
    const delay = Math.min(30_000, 1000 * 2 ** Math.min(failures++, 5))
    timer = setTimeout(() => {
      timer = undefined
      if (!stopped) { if (needsSnapshot) void loadSnapshot(); else open() }
    }, delay)
  }
  const member: Member = {
    cardId,
    applied: () => applied,
    listening: () => !stopped && generation === listening,
    onOpen() { if (generation === listening) handlers.health?.(true) },
    onError() { if (generation === listening) retry(false) },
    onPermission() {
      stopped = true
      generation++
      cancelBatch()
      handlers.permissionLost()
    },
    onData(kind, message) {
      if (stopped || generation !== listening) return
      try {
        const change: unknown = JSON.parse(message.data)
        if (!isRecord(change) || change.workspaceId !== workspaceId || change.cardId !== cardId ||
            !cursor(change.seq) || typeof change.rowId !== "string" || message.lastEventId !== change.seq ||
            (kind === "row.upsert" ? !row(change.row, cardId) || change.row.id !== change.rowId : change.row !== null)) {
          throw new Error("卡片更新格式无效，正在重新读取")
        }
        const next = BigInt(change.seq)
        if (next <= BigInt(received)) return
        if (next !== BigInt(received) + 1n) throw new Error("卡片更新存在缺口，正在补读")
        if (kind === "row.upsert") {
          const nextRow = (change as unknown as Change).row as ListingRowView
          // A newer upsert supersedes a removal pending in the same frame —
          // skipping it here would lose this row version until a snapshot.
          pendingRemovals.delete(change.rowId)
          const previous = pendingRows.get(change.rowId)
          if (!previous || previous.view_revision <= nextRow.view_revision) pendingRows.set(change.rowId, nextRow)
          scheduleBatch()
        } else {
          pendingRows.delete(change.rowId)
          pendingRemovals.add(change.rowId)
          scheduleBatch()
        }
        received = change.seq
      } catch (reason) { retry(false, reason) }
    },
    onControl(_kind, message) {
      if (stopped || generation !== listening) return
      try {
        const reset = JSON.parse(message.data)
        if (!isRecord(reset) || reset.workspaceId !== workspaceId || reset.cardId !== cardId) throw new Error("卡片更新作用域无效")
        if (reset.reason === "permission_changed") {
          stopped = true
          close()
          cancelBatch()
          handlers.permissionLost()
        } else retry(true)
      } catch (reason) { retry(false, reason) }
    },
    onInvalidate(message) {
      if (stopped || generation !== listening) return
      try {
        const change: unknown = JSON.parse(message.data)
        if (!isRecord(change) || change.workspaceId !== workspaceId || change.cardId !== cardId ||
            !cursor(change.seq) || typeof change.reason !== "string" ||
            typeof change.psdTemplateSha256 !== "string" ||
            message.lastEventId !== change.seq) {
          throw new Error("卡片更新格式无效，正在重新读取")
        }
        const next = BigInt(change.seq)
        if (next <= BigInt(received)) return
        if (next !== BigInt(received) + 1n) throw new Error("卡片更新存在缺口，正在补读")
        pendingInvalidation = true
        received = change.seq
        scheduleBatch()
      } catch (reason) { retry(false, reason) }
    },
  }

  async function loadSnapshot() {
    const current = ++generation
    const scope = rowCacheScope()
    try {
      handlers.snapshotStarting()
      const snapshot = await api.get<Snapshot>(route("listingCardsByIdSnapshot", { id: cardId }))
      if (stopped || current !== generation) return
      if (!isRecord(snapshot) || typeof snapshot.workspace_id !== "string" || snapshot.card_id !== cardId || !cursor(snapshot.cursor) ||
          !Array.isArray(snapshot.rows) || !snapshot.rows.every((value) => row(value, cardId)) ||
          new Set(snapshot.rows.map((value) => value.id)).size !== snapshot.rows.length ||
          !summary(snapshot.summary, snapshot.rows.length)) throw new Error("卡片快照格式无效")
      handlers.snapshot(snapshot)
      rememberListingRows(snapshot.rows, scope)
      cacheScope = scope
      workspaceId = snapshot.workspace_id
      applied = snapshot.cursor
      received = snapshot.cursor
      failures = 0
      if (!bound) {
        unbind = bind(workspaceId, member)
        bound = true
      }
      open()
    } catch (reason) {
      if (stopped || current !== generation) return
      if (isRecord(reason) && (reason.code === "unauthenticated" || [401, 403, 404].includes(Number(reason.status)))) {
        stopped = true
        close()
        handlers.permissionLost()
      } else retry(true, reason)
    }
  }
  void loadSnapshot()
  return () => {
    stopped = true
    generation++
    close()
    if (timer) clearTimeout(timer)
    cancelBatch()
    unbind()
  }
}
