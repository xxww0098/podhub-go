import { diagnosticProperty, newDiagnosticId, safeDiagnosticTrace } from "./diagnostic-context"
import { diagLog } from "./diag-log"
import type { createDiagnosticMemory, DiagnosticDetail, ExactOperation } from "./diagnostic-memory"
import type { DiagnosticPublishAction } from "./diagnostic-window"
import {
  approvedDiagnosticField, DIAGNOSTIC_CODES, DIAGNOSTIC_STAGES, diagnosticSha256, summarizeDiagnosticJson,
  type DiagnosticCode, type DiagnosticEvent, type DiagnosticStage,
} from "./diagnostic-summary"

export type DiagnosticCaptureInput = Readonly<{
  /** The canonical solution table supplies one of these four reportable categories. */
  code: DiagnosticCode
  platform: string
  stage: DiagnosticStage
  field: string | null
  /** ListingIssue evidence wins; HTTP x-request-id comes next. OCR requestId is not trace evidence. */
  traceEvidence?: Readonly<{ listingIssueTraceId?: string | null; requestHeaderTraceId?: string | null }>
  exactOperation?: ExactOperation | null
  /** Local dispatch/report ownership only. Omit for preparation; old action responses stay held. */
  publishAction?: DiagnosticPublishAction | null
}>
type CaptureDeps = {
  memory: ReturnType<typeof createDiagnosticMemory>
  generation: () => number
  enqueue: (event: DiagnosticEvent, publishAction: DiagnosticPublishAction | null) => void
  now?: () => number
  uuid?: () => string
  digest?: (text: string) => Promise<string>
}

/** Call once at problem normalization, outside render. Reusing that input object reuses its ID. */
export function createDiagnosticCapture(deps: CaptureDeps) {
  let generation = deps.generation()
  let captured = new WeakMap<object, Promise<DiagnosticDetail | null>>()
  const normalize = async (input: DiagnosticCaptureInput): Promise<DiagnosticDetail | null> => {
    const current = deps.generation()
    const code = diagnosticProperty(input, "code")
    const stage = diagnosticProperty(input, "stage")
    const platform = diagnosticProperty(input, "platform")
    const field = diagnosticProperty(input, "field")
    if (typeof code !== "string" || !Object.hasOwn(DIAGNOSTIC_CODES, code)
      || typeof stage !== "string" || !Object.hasOwn(DIAGNOSTIC_STAGES, stage)
      || typeof platform !== "string" || !/^[a-z][a-z0-9_-]{0,31}$/.test(platform)
      || !(field === null || approvedDiagnosticField(field))) return null
    try {
      const diagnosticId = (deps.uuid ?? newDiagnosticId)()
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(diagnosticId)) return null
      const evidence = diagnosticProperty(input, "traceEvidence")
      const traceId = safeDiagnosticTrace(diagnosticProperty(evidence, "listingIssueTraceId"))
        ?? safeDiagnosticTrace(diagnosticProperty(evidence, "requestHeaderTraceId")) ?? diagnosticId
      const operation = diagnosticProperty(input, "exactOperation")
      const provenance = diagnosticProperty(operation, "provenance")
      const jsonText = diagnosticProperty(operation, "jsonText")
      const original: ExactOperation | null = typeof jsonText === "string"
        && (provenance === "native_freeze" || provenance === "submitted_http_body") ? { provenance, jsonText } : null
      const action = diagnosticProperty(input, "publishAction")
      const publishAction = action && typeof action === "object" ? action as DiagnosticPublishAction : null
      const occurredAt = new Date((deps.now ?? Date.now)()).toISOString()
      if (Date.parse(occurredAt) < 0) return null
      // UTF8 of the ENTIRE unchanged text; not JSON.stringify, not the summary, not a clipped prefix.
      const payloadSha256 = original ? await (deps.digest ?? diagnosticSha256)(original.jsonText) : null
      if (payloadSha256 !== null && !/^[0-9a-f]{64}$/.test(payloadSha256)) return null
      if (deps.generation() !== current) return null
      const event: DiagnosticEvent = {
        schema_version: 4, diagnostic_id: diagnosticId, platform, stage: stage as DiagnosticStage,
        field, code: code as DiagnosticCode, occurred_at: occurredAt, trace_id: traceId, payload_sha256: payloadSha256,
        summary: original ? summarizeDiagnosticJson(original.jsonText) : [],
      }
      if (new TextEncoder().encode(JSON.stringify(event)).length > 16_384) return null
      deps.memory.retain(event, original)
      deps.enqueue(event, publishAction)
      try { diagLog("[diagnostic]", "captured", { diagnosticId, traceId, platform, stage, field, code }) }
      catch { /* A console sink cannot invalidate an already captured diagnostic. */ }
      return deps.memory.detail(diagnosticId)
    } catch { return null }
  }
  return (input: DiagnosticCaptureInput): Promise<DiagnosticDetail | null> => {
    if (generation !== deps.generation()) { generation = deps.generation(); captured = new WeakMap() }
    if (!input || typeof input !== "object") return Promise.resolve(null)
    let result = captured.get(input)
    if (!result) { result = normalize(input); captured.set(input, result) }
    return result
  }
}
