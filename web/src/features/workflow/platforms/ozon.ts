/**
 * Ozon adapter. Every field rule, the `/v3/product/import` body, its digest
 * and `clientOperationId` come from `listing-core` through WASM op 11
 * (`ops::freeze_listing`: build → validate → freeze, the same code the
 * server's submit pipeline runs). TypeScript never serializes or hashes an
 * Ozon Seller body; this file only routes rows through the core and turns
 * its answers into platform issues.
 *
 * Stages, each replaceable through `createOzonAdapter(core, { stages })`:
 * `rowIds` (blank/duplicate row identity, before any freeze) → per row
 * `prepare` (per-field operator rules, `ozon-fields.ts`) → `freezeRow` (op 11)
 * → `checkOffers` (duplicate offer per store). Per-field rules come through
 * `createOzonAdapter(core, { fields })`.
 */
import { draftAdmissionRefusal, draftRequestBytes, submitListingDrafts } from "@/bindings/http-listing-submit"
import { listingContractError, readListingIntents, releaseUnknownListingIntents } from "@/bindings/http-listing-intents"
import type { ListingCore } from "@/listing-core/wasm"
import { factFromIntent } from "../submit/queue/authority"
import type { PreparedRow, SendCapability, SendFact } from "../submit/queue/types"
import { capturePublishDiagnostic, normalizePublishDiagnostic } from "../model/publish-diagnostic"
import type {
  SubmitDraft,
  KnownIssueKey,
  BuildEvidence,
  CardPayload,
  FieldIssue,
  FreezeListingInput,
  FreezeListingOutput,
  FreezeRefusalReason,
  JsonRecord,
  LeanRow,
} from "@/listing-core/types"
import { createSliceBudget, deepFreeze, type FrozenItem, type PlatformAdapter, type PlatformIssue } from "./core"
import { applyOzonFieldRules, type OzonFieldRules } from "./ozon-fields"
import { createPublishDiagnosticOperation } from "../submit/queue/diagnostics"
import { commandErrorCode } from "@/lib/error-message"
import { listingLog, noteListingRow } from "@/lib/listing-log"
import { concreteToken } from "@/lib/listing-refusal"

export const OZON = "ozon"

/** Met by both `ListingCore` (sync, `wasm.ts`) and `ListingCoreClient`
 * (Promise, `client.ts`); the schema must already be resident. */
export type OzonFreezeCore = {
  editRow?: ListingCore["editRow"] | ((handle: number, input: Parameters<ListingCore["editRow"]>[1]) => Promise<ReturnType<ListingCore["editRow"]>>)
  freezeListing(handle: number, input: FreezeListingInput): FreezeListingOutput | Promise<FreezeListingOutput>
}

export type OzonRowInput = Readonly<{ rowId: string; storeId: string; row: LeanRow }>

export type OzonBuildInput = Readonly<{
  /** Resident `schema_load` handle for the Card's coordinate. */
  schemaHandle: number
  card: CardPayload
  rows: readonly OzonRowInput[]
  /** Caller's clock, stamped on the `manual` origins field rules write. */
  nowMs: number
}>

/** Local preview of one row's frozen import. */
export type OzonBody = Readonly<{
  rowId: string
  storeId: string
  offerId: string
  import: JsonRecord
  evidence: BuildEvidence
}>

type Blocked = { key: string; issues: PlatformIssue[] }

export type OzonStages = {
  /** Rows whose identity is unusable, keyed once per offending row id. */
  rowIds(rows: readonly OzonRowInput[]): Blocked[]
  prepare(core: OzonFreezeCore, input: OzonBuildInput, row: OzonRowInput, fields: OzonFieldRules): Promise<OzonRowInput | PlatformIssue[]>
  freezeRow(core: OzonFreezeCore, input: OzonBuildInput, row: OzonRowInput): Promise<FrozenItem<OzonBody> | PlatformIssue[]>
  /** Issues keyed by row id for rows that cannot be sent together. */
  checkOffers(frozen: readonly FrozenItem<OzonBody>[]): Map<string, PlatformIssue[]>
}

export type OzonAdapterOptions = Readonly<{ stages?: Partial<OzonStages>; fields?: OzonFieldRules }>

const FALLBACK_REMEDIATION: Record<FreezeRefusalReason, string> = {
  row_id_invalid: "刷新页面重新载入该商品后再发送",
  schema_stale: "重新打开上架方案同步类目字段后再发送",
  coordinate_mismatch: "在正确的上架方案下重新生成该商品",
  candidates_unresolved: "在候选审阅中确认或拒绝 AI 候选值后再发送",
  validation_failed: "按字段提示修改该商品后再发送",
  freeze_failed: "检查商品名称与媒体后重试",
}

function ozonIssue(issue: Omit<PlatformIssue, "platform">): PlatformIssue {
  return { platform: OZON, ...issue }
}

export function issueFromCore(reason: FreezeRefusalReason, stage: "freeze" | "validate", issue: FieldIssue): PlatformIssue {
  const detail = issue.parameters.detail
  return ozonIssue({
    stage,
    field: issue.field_key || null,
    code: issue.code,
    message: issue.message,
    remediation: issue.remediation ?? FALLBACK_REMEDIATION[reason],
    ...(detail ? { diagnostic: JSON.stringify(detail) } : {}),
  })
}

function fieldName(address: FieldIssue["address"]): string {
  return address.kind === "plain" ? address.field_key : `${address.group_key}/${address.item_id}/${address.field_key}`
}

const defaultStages: OzonStages = {
  rowIds(rows) {
    const counts = new Map<string, number>()
    for (const { rowId } of rows) counts.set(rowId, (counts.get(rowId) ?? 0) + 1)
    return [...counts].flatMap(([rowId, count]): Blocked[] => {
      if (!rowId.trim() || rowId.trim() !== rowId) {
        return [{ key: rowId, issues: [ozonIssue({ stage: "identity", field: "row_id", code: "row_id_invalid", message: "商品标识为空或含首尾空格，无法生成唯一的提交标识", remediation: "刷新页面重新载入该商品后再发送" })] }]
      }
      if (count > 1) {
        return [{ key: rowId, issues: [ozonIssue({ stage: "identity", field: "row_id", code: "row_id_duplicate", message: `同一商品在本次发送中出现了 ${count} 次`, remediation: "刷新页面后重新选择要发送的商品" })] }]
      }
      return []
    })
  },
  async prepare(core, input, row, fields) {
    if (Object.keys(fields).length === 0) return row
    if (!Number.isSafeInteger(input.nowMs) || input.nowMs < 0) {
      return [ozonIssue({ stage: "field", field: null, code: "clock_invalid", message: "当前时间无效，无法记录字段修改", remediation: "刷新页面后重试" })]
    }
    const prepared = applyOzonFieldRules(row.row, input.card, fields)
    if ("draft" in prepared) {
      if (!core.editRow) throw new Error("Field edits require native editRow")
      // A callback is not an operator's AI-review decision. Let the native
      // preflight refuse unresolved candidates before op2 can record an edit.
      const preflight = await core.freezeListing(input.schemaHandle, { card: input.card, row: row.row, rowId: row.rowId })
      if (preflight.status === "refused" && preflight.reason === "candidates_unresolved") {
        return preflight.issues.map((issue) => issueFromCore(preflight.reason, preflight.issueStage, issue))
      }
      const edited = await core.editRow(input.schemaHandle, { card: input.card, row: row.row, nowMs: input.nowMs, edit: { kind: "draft", draft: prepared.draft } })
      return { ...row, row: edited.row }
    }
    const { field, code, diagnostic } = prepared.refusal
    return [ozonIssue({
      stage: "field",
      field,
      code,
      message: `字段「${field}」的自定义规则没有给出可用的值`,
      remediation: "检查该字段的自定义规则，或移除该规则后重试",
      ...(diagnostic ? { diagnostic } : {}),
    })]
  },
  async freezeRow(core, input, { rowId, storeId, row }) {
    const started = performance.now()
    listingLog({ module: "freeze", event: "freeze.start", rowId })
    const finish = (level: "info" | "warn" | "error", errorCode?: string, outcome?: string) => {
      const code = concreteToken(errorCode)
      listingLog({
        level, module: "freeze", event: "freeze.end", rowId,
        durationMs: performance.now() - started,
        ...(code ? { errorCode: code } : {}),
        ...((outcome || code) ? { fields: { ...(outcome ? { outcome } : {}), ...(code ? { refusal: code } : {}) } } : {}),
      })
    }
    if (!storeId.trim()) {
      finish("warn", "target_store_missing", "refused")
      return [ozonIssue({ stage: "store", field: "store", code: "target_store_missing", message: "商品尚未绑定目标 Ozon 店铺", remediation: "为该商品选择目标店铺后再发送" })]
    }
    let output: FreezeListingOutput
    try {
      output = await core.freezeListing(input.schemaHandle, { card: input.card, row, rowId })
    } catch (error) {
      finish("error", "core_unavailable", "refused")
      return [ozonIssue({
        stage: "freeze",
        field: null,
        code: "core_unavailable",
        message: "本地上架内核无法处理该商品",
        remediation: "刷新页面重新加载类目字段后重试；仍失败请联系管理员",
        diagnostic: String(error),
      })]
    }
    if (output.status === "refused") {
      finish("warn", output.reason, "refused")
      return output.issues.map((issue) => issueFromCore(output.reason, output.issueStage, issue))
    }
    noteListingRow(rowId, { offerId: output.offerId })
    finish("info", undefined, "frozen")
    return {
      key: rowId,
      body: { rowId, storeId, offerId: output.offerId, import: output.import, evidence: output.evidence },
      digest: output.digest,
      clientOperationId: output.clientOperationId,
      provenance: output.evidence.sources.map((source) => {
        const [address, layer] = source as [FieldIssue["address"], string]
        return { field: fieldName(address), stage: layer }
      }),
    }
  },
  checkOffers(frozen) {
    const holders = new Map<string, string[]>()
    for (const item of frozen) {
      const slot = JSON.stringify([item.body.storeId, item.body.offerId])
      holders.set(slot, [...(holders.get(slot) ?? []), item.key])
    }
    const issues = new Map<string, PlatformIssue[]>()
    for (const [slot, rowIds] of holders) {
      if (rowIds.length < 2) continue
      const offerId = (JSON.parse(slot) as string[])[1]
      for (const rowId of rowIds) {
        issues.set(rowId, [ozonIssue({
          stage: "freeze",
          field: "offer_id",
          code: "offer_id_duplicate",
          message: `货号 ${offerId} 在同一店铺的本次发送中重复`,
          remediation: "修改其中一个商品的货号（offer_id）后再发送",
        })])
      }
    }
    return issues
  },
}

export function createOzonAdapter(core: OzonFreezeCore, options: OzonAdapterOptions = {}): PlatformAdapter<OzonBuildInput, OzonBody> {
  const stages = { ...defaultStages, ...options.stages }
  const fields = { ...options.fields }
  for (const key of Object.keys(fields)) {
    if (!key.trim()) throw new Error("Ozon field rule registered under a blank field key")
  }
  return {
    platform: OZON,
    label: "Ozon",
    async build(input) {
      if (input.rows.length === 0) {
        return deepFreeze({ frozen: [], blocked: [{ key: "rows", issues: [ozonIssue({ stage: "identity", field: null, code: "rows_empty", message: "没有可发送的 Ozon 商品", remediation: "先选择要发送到 Ozon 的商品" })] }] })
      }
      const blocked = stages.rowIds(input.rows)
      const refused = new Set(blocked.map((item) => item.key))
      const frozen: FrozenItem<OzonBody>[] = []
      // Sequential: one WASM instance serves one call at a time.
      const tick = createSliceBudget()
      for (const row of input.rows) {
        if (refused.has(row.rowId)) continue
        const prepared = await stages.prepare(core, input, row, fields)
        const result = Array.isArray(prepared) ? prepared : await stages.freezeRow(core, input, prepared)
        if (Array.isArray(result)) blocked.push({ key: row.rowId, issues: result })
        else frozen.push(result)
        if (Array.isArray(result) && result.some((issue) => issue.code === "core_unavailable")) {
          return deepFreeze({ frozen: [], blocked: input.rows.map((entry) => blocked.find((item) => item.key === entry.rowId) ?? { key: entry.rowId, issues: result }) })
        }
        await tick()
      }
      const conflicts = stages.checkOffers(frozen)
      return deepFreeze({
        frozen: frozen.filter((item) => !conflicts.has(item.key)),
        blocked: [...blocked, ...[...conflicts].map(([key, issues]) => ({ key, issues }))],
      })
    },
  }
}

/** Final S16 capability: LocalRows only, op12 items, never Cloud row projections. */
export function createOzonSendCapability(options: {
  core: OzonFreezeCore & {
    projectSubmitDraft(input: Parameters<ListingCore["projectSubmitDraft"]>[0]): SubmitDraft | Promise<SubmitDraft>
    issueManifest(): KnownIssueKey[] | Promise<KnownIssueKey[]>
  }
  schemaHandle(): number
  card(): CardPayload
  cardId: string
  repair?: SendCapability["repair"]
  canRepair?: SendCapability["canRepair"]
}): SendCapability {
  const adapter = createOzonAdapter(options.core)
  let manifest: KnownIssueKey[] | undefined
  async function loadManifest(signal: AbortSignal): Promise<void> {
    signal.throwIfAborted()
    if (manifest) return
    let abort!: () => void
    const cancelled = new Promise<never>((_resolve, reject) => {
      abort = () => reject(signal.reason)
      signal.addEventListener("abort", abort, { once: true })
    })
    try {
      const loaded = await Promise.race([Promise.resolve().then(() => {
        signal.throwIfAborted()
        return options.core.issueManifest()
      }), cancelled])
      signal.throwIfAborted()
      // Only a live local load initializes knowledge; late cancelled work cannot.
      manifest ??= loaded
    } finally { signal.removeEventListener("abort", abort) }
  }
  const knownIssue = (stage: string, code: string) => manifest?.some((key) => key.platform === OZON && key.stage === stage && key.code === code) === true
  return {
    async prepare(rows, signal) {
      await loadManifest(signal)
      const items: PreparedRow[] = []
      const blocked: Array<{ rowId: string; issues: readonly PlatformIssue[] }> = []
      const tick = createSliceBudget()
      for (const local of rows) {
        if (signal.aborted) break
        const built = await adapter.build({ schemaHandle: options.schemaHandle(), card: options.card(), nowMs: Date.now(), rows: [
          { rowId: local.id, storeId: local.storeId ?? "", row: local.row as LeanRow },
        ] })
        blocked.push(...built.blocked.map((item) => ({ rowId: item.key, issues: item.issues })))
        for (const frozen of built.frozen) items.push({
          rowId: local.id, revision: local.rev, offerId: frozen.body.offerId,
          digest: frozen.digest, previewOperationId: frozen.clientOperationId,
          body: await options.core.projectSubmitDraft({ rowId: local.id, row: local.row as LeanRow }),
        })
        if (built.blocked.some((entry) => entry.issues.some((issue) => issue.code === "core_unavailable"))) {
          const detail = await capturePublishDiagnostic({ platform: OZON, stage: "freeze", code: "core_unavailable" })
          throw Object.assign(new Error("Native instance unavailable; end this action before explicitly reloading local material"),
            detail?.event ? { publishDiagnostic: { diagnosticId: detail.diagnosticId, traceId: detail.event.trace_id } } : {})
        }
        await tick()
      }
      return { items, blocked }
    },
    bytes(destination, items) { return draftRequestBytes({ card_id: options.cardId, store_id: destination, items: items.map((item) => item.body as SubmitDraft) }) },
    async send(destination, items, request) {
      const started = performance.now()
      for (const item of items) {
        noteListingRow(item.rowId, { offerId: item.offerId })
        listingLog({ module: "submit", event: "submit.start", rowId: item.rowId })
      }
      const finish = (rowId: string, state: string, errorCode?: string, intentId?: string) => {
        if (intentId) noteListingRow(rowId, { intentId })
        const failed = state !== "accepted" && state !== "pending"
        const code = concreteToken(errorCode)
        listingLog({
          module: "submit", event: "submit.end", rowId,
          level: failed ? "warn" : "info",
          durationMs: performance.now() - started,
          ...(code ? { errorCode: code } : {}),
          fields: { outcome: state, ...(code ? { refusal: code } : {}) },
        })
      }
      const operation = createPublishDiagnosticOperation(request.diagnostics)
      const attach = async (fact: SendFact, issue?: { phase: string; code: string; trace_id: string }, outcomeUnknown = false) => {
        const issueProblem = issue && { platform: OZON, stage: issue.phase, code: issue.code, traceId: issue.trace_id }
        const problem = issueProblem && (normalizePublishDiagnostic(issueProblem) || !outcomeUnknown) ? issueProblem
          : fact.state === "unknown" ? { platform: OZON, stage: "submit", family: "control" as const,
            code: fact.code === "listing_contract_invalid" ? "contract_invalid" : "result_unconfirmed", traceId: issue?.trace_id }
          : undefined
        if (!problem) return fact
        const detail = await operation.capture(problem)
        return detail?.event ? { ...fact, diagnostic: { eventKey: detail.diagnosticId,
          diagnosticId: detail.diagnosticId, traceId: detail.event.trace_id } }
          : fact.state === "unknown" ? { ...fact, diagnosticClassified: true as const } : fact
      }
      try {
        const result = await submitListingDrafts({ card_id: options.cardId, store_id: destination, items: items.map((item) => item.body as SubmitDraft) },
          request.deadlineAt, operation.onEvidence, operation.onDispatch)
        const facts = new Map<string, SendFact>()
        for (const item of result.items) {
          const fact: SendFact = item.intent ? factFromIntent(item.intent, knownIssue)
            : item.outcome === "skipped" && (item.issues ?? []).every((issue) => knownIssue("validate", issue.code))
              ? { state: "rejected", canResume: true, code: item.skip_reason ?? undefined, receipt: item }
              : { state: "unknown", code: "listing_contract_invalid", receipt: item }
          facts.set(item.row_id, await attach(fact, item.intent?.current_issue ?? undefined, item.intent?.state === "outcome_unknown"))
        }
        // Omitted items are Unknown with this actual request's bytes, never a reconstructed draft.
        for (const item of items) if (!facts.has(item.rowId)) facts.set(item.rowId, await attach({ state: "unknown", code: "send_result_unknown" }))
        for (const [rowId, fact] of facts) finish(rowId, fact.state, fact.code, fact.intentId)
        return facts
      } catch (error) {
        const admission = draftAdmissionRefusal(error)
        if (!admission) {
          const code = !operation.wasDispatched() || ["listing_contract_invalid", "cloud_bad_response"].includes(commandErrorCode(error) ?? "")
            ? "contract_invalid" : "result_unconfirmed"
          const detail = await operation.capture({ platform: OZON, stage: "submit", family: "control", code })
          if (detail?.event && error instanceof Error) {
            try { Object.assign(error, { publishDiagnostic: { diagnosticId: detail.diagnosticId, traceId: detail.event.trace_id } }) }
            catch { /* A frozen failure still retains its original rejection semantics. */ }
          }
          for (const item of items) finish(item.rowId, "unknown", code)
          throw error // Preserve the existing transport rejection and scheduler Unknown semantics.
        }
        for (const item of items) finish(item.rowId, "rejected", admission)
        return new Map<string, SendFact>(items.map((item) => [item.rowId, { state: "rejected", canResume: true, admission, code: admission }]))
      } finally { operation.clear() }
    },
    async reconcile(destination, rows, signal) {
      if (rows.length === 0 || rows.length > 100 || new Set(rows.map((row) => row.rowId)).size !== rows.length
        || rows.some((row) => !row.rowId.trim() || row.rowId.trim() !== row.rowId || row.rowId.includes(",")
          || !Number.isSafeInteger(row.revision) || row.revision < 0
          || row.identity && (!row.identity.intentId.trim() || !row.identity.serverOperationId.trim()
            || !Number.isSafeInteger(row.identity.serverRevision) || row.identity.serverRevision < 0))
        || rows.some((row) => row.identity) && rows.some((row) => !row.identity)) throw listingContractError()
      const pins = rows.map((row) => ({ ...row, identity: row.identity && { ...row.identity } }))
      await loadManifest(signal)
      signal.throwIfAborted()
      // Identity and row-history queries share the same one-request / 100-row budget.
      const page = await readListingIntents(destination, pins[0]!.identity
        ? { intentIds: pins.map((row) => row.identity!.intentId) } : { rowIds: pins.map((row) => row.rowId) }, signal)
      const complete = !page.next_cursor
      return { complete, rows: pins.map((pin) => {
        const intents = page.items.filter((entry) => entry.listing_row_id === pin.rowId)
        const candidates = intents.map((intent) => {
          const fact = factFromIntent(intent, knownIssue)
          return { rowId: pin.rowId, intentId: intent.id, serverOperationId: intent.client_operation_id,
            serverRevision: intent.row_revision, state: fact.state, taskId: fact.taskId, code: fact.code }
        })
        const intent = complete && intents.length === 1 && pin.identity && intents[0]!.id === pin.identity.intentId
          && intents[0]!.client_operation_id === pin.identity.serverOperationId && intents[0]!.row_revision === pin.identity.serverRevision ? intents[0] : undefined
        // Even a single latest accepted candidate cannot establish a lost operation link.
        // Project authority here; no raw API Intent DTO enters the neutral read port.
        const fact = intent && factFromIntent(intent, knownIssue)
        return { rowId: pin.rowId, candidates, ...(fact ? { fact: {
          state: fact.state, intentId: fact.intentId, serverOperationId: fact.serverOperationId, serverRevision: fact.serverRevision,
          taskId: fact.taskId, code: fact.code, canResume: fact.canResume,
        } } : {}) }
      }) }
    },
    async releaseUnknown(destination, locks, signal) {
      const ids = locks.flatMap((lock) => lock.intentId ? [lock.intentId] : [])
      const rowIds = [...new Set(locks.map((lock) => lock.rowId))]
      if (ids.length !== locks.length || ids.length === 0 || ids.length > 100) return { releasedIntentIds: [], complete: false, unresolvedIntentIds: [] }
      const released = await releaseUnknownListingIntents(ids, signal)
      const proven = released.released_intent_ids.filter((id) => {
        const captured = locks.find((lock) => lock.intentId === id)
        return captured !== undefined && released.intents.some((intent) => intent.id === id && intent.state === "superseded" && intent.store_id === destination
          && intent.listing_row_id === captured?.rowId && intent.client_operation_id === captured.serverOperationId)
      })
      // The release receipt alone never unlocks: re-read after it to catch concurrent admissions.
      const current = await readListingIntents(destination, { rowIds }, signal)
      return {
        releasedIntentIds: proven,
        complete: !current.next_cursor && rowIds.every((id) => current.items.some((intent) => intent.listing_row_id === id)),
        unresolvedIntentIds: current.items.filter((intent) => intent.state !== "superseded" || !proven.includes(intent.id)).map((intent) => intent.id),
      }
    },
    ...(options.repair ? { repair: options.repair } : {}),
    ...(options.canRepair ? { canRepair: options.canRepair } : {}),
  }
}
