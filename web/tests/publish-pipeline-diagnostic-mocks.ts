/** Inbox transport only. The production singleton remains the event/capture owner. */
import { route } from "@/api/routes"
import { approvedDiagnosticField, diagnosticSha256, DIAGNOSTIC_CODES, DIAGNOSTIC_STAGES, type DiagnosticFieldSummary } from "@/lib/diagnostic-summary"
import { recordBusiness, type BusinessEvent, type InboxEvidence } from "./publish-pipeline-metrics"

const keys = ["schemaVersion", "diagnosticId", "traceId", "platform", "stage", "field", "code", "occurredAt", "payloadSha256", "summary"]
const summaryKeys = ["field", "fieldId", "valueType", "length", "enumValue"]
function plainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype
}
function approvedSummary(value: unknown): value is DiagnosticFieldSummary {
  if (!plainObject(value) || Object.keys(value).length !== summaryKeys.length || Object.keys(value).some((key) => !summaryKeys.includes(key))
    || !approvedDiagnosticField(value.field) || typeof value.valueType !== "string"
    || !["null", "boolean", "number", "string", "array", "object"].includes(value.valueType)) return false
  const sized = ["string", "array", "object"].includes(value.valueType)
  if (sized ? typeof value.length !== "number" || !Number.isSafeInteger(value.length) || value.length < 0 || value.length > 2_147_483_647
    : value.length !== null) return false
  const catalogAddress = value.field.startsWith("attributes[") || value.field.startsWith("characteristics[")
    || ["description_category_id", "type_id", "subjectID"].includes(value.field)
  const catalogValue = /(?:^|\.)(?:id|complex_id|dictionary_value_id|description_category_id|type_id|subjectID)$/.test(value.field)
  if (value.fieldId !== null && (!catalogAddress || !catalogValue || value.valueType !== "number"
    || typeof value.fieldId !== "number" || !Number.isSafeInteger(value.fieldId) || value.fieldId < 0)) return false
  return value.enumValue === null || value.valueType === "string" && typeof value.enumValue === "string"
    && (value.field === "currency_code" ? ["RUB", "USD", "EUR", "CNY"].includes(value.enumValue)
      : value.field === "dimension_unit" ? ["mm", "cm", "m"].includes(value.enumValue)
        : value.field === "weight_unit" && ["g", "kg"].includes(value.enumValue))
}
export function createDiagnosticMocks() {
  let failOnce = false
  // Exactly one held loss request, bounded by submit's 7.5 MiB limit. Never exported.
  let expected: { text: string; hash: string } | undefined
  return {
    failNext() { failOnce = true },
    async observeLoss(text: string) {
      if (new TextEncoder().encode(text).length > 7.5 * 1024 * 1024) throw new Error("Fixture loss body exceeded submit limit")
      expected = { text, hash: await diagnosticSha256(text) }
    },
    copyMatches(text: unknown, hash: unknown) { return !!expected && text === expected.text && hash === expected.hash },
    forgetOriginal() { expected = undefined },
    async handle(url: URL, method: string, init: RequestInit | undefined, base: Pick<BusinessEvent, "request" | "method" | "path" | "requestBytes">): Promise<Response | undefined> {
      if (url.origin !== location.origin || url.pathname !== route("eventsInbox") || method !== "POST") return undefined
      const boundary = { ...base, category: "E", operation: "inbox" } as const
      recordBusiness({ ...boundary, event: "dispatch" })
      try {
        if (url.search || typeof init?.body !== "string") throw new Error("Unexpected inbox envelope")
        const body: unknown = JSON.parse(init.body)
        if (!plainObject(body) || !Array.isArray(body.events) || body.events.length === 0 || body.events.length > 20
          || Object.keys(body).join() !== "events") throw new Error("Invalid fixture inbox batch")
        const entries: unknown[] = body.events
        const events: InboxEvidence[] = entries.map((entry) => {
          if (!plainObject(entry) || typeof entry.id !== "string" || !entry.id || typeof entry.kind !== "string" || !entry.kind
            || typeof entry.schema_version !== "number" || !Number.isSafeInteger(entry.schema_version) || entry.schema_version < 1
            || Object.keys(entry).length !== 4
            || Object.keys(entry).some((key) => !["id", "kind", "schema_version", "payload_json"].includes(key))) throw new Error("Invalid fixture inbox event")
          // All event kinds are counted. Only the approved diagnostic projection enters metrics.
          const evidence: InboxEvidence = { id: entry.id, kind: entry.kind, schemaVersion: entry.schema_version }
          if (entry.kind === "desktop_error_log.v4") {
            if (typeof entry.payload_json !== "string") throw new Error("Diagnostic payload_json must be JSON text")
            const event: unknown = JSON.parse(entry.payload_json)
            if (entry.schema_version !== 4 || !plainObject(event) || event.schemaVersion !== 4
              || Object.keys(event).length !== keys.length || Object.keys(event).some((key) => !keys.includes(key))
              || typeof event.diagnosticId !== "string" || event.diagnosticId !== entry.id || !/^[A-Za-z0-9_.-]{1,128}$/.test(event.diagnosticId)
              || typeof event.traceId !== "string" || !/^[A-Za-z0-9_.-]{1,128}$/.test(event.traceId)
              || typeof event.platform !== "string" || !/^[a-z][a-z0-9_-]{0,31}$/.test(event.platform)
              || typeof event.stage !== "string" || !Object.hasOwn(DIAGNOSTIC_STAGES, event.stage)
              || typeof event.code !== "string" || !Object.hasOwn(DIAGNOSTIC_CODES, event.code)
              || (event.field !== null && !approvedDiagnosticField(event.field))
              || typeof event.occurredAt !== "string" || event.occurredAt.length > 40
              || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.test(event.occurredAt)
              || (event.payloadSha256 !== null && (typeof event.payloadSha256 !== "string" || !/^[a-f0-9]{64}$/.test(event.payloadSha256)))
              || !Array.isArray(event.summary) || event.summary.length > 64 || !event.summary.every(approvedSummary)) throw new Error("Inbox privacy contract mismatch")
            const occurredAt = Date.parse(event.occurredAt)
            if (!Number.isFinite(occurredAt) || occurredAt < 0) throw new Error("Invalid diagnostic occurrence time")
            Object.assign(evidence, { diagnosticId: event.diagnosticId, traceId: event.traceId, payloadSha256: event.payloadSha256,
              platform: event.platform, stage: event.stage, code: event.code, summary: event.summary })
          }
          return evidence
        })
        if (new Set(events.map((entry) => entry.id)).size !== events.length) throw new Error("Duplicate fixture inbox event ID")
        const ledger = { ...boundary, events }
        if (failOnce) {
          failOnce = false
          recordBusiness({ ...ledger, event: "response", status: 503, acceptedIds: [] })
          return Response.json({ error: "Fixture inbox temporarily unavailable", code: "inbox_unavailable" }, { status: 503 })
        }
        const accepted = events.map((event) => event.id)
        recordBusiness({ ...ledger, event: "response", status: 200, acceptedIds: accepted })
        return Response.json({ data: { accepted, rejected: [] } })
      } catch (reason) {
        recordBusiness({ ...boundary, category: "unexpected", event: "rejection" })
        throw reason
      }
    },
  }
}
