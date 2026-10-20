import { approvedDiagnosticField } from "./diagnostic-summary"

export type DiagnosticContext = Readonly<{ platform: string; stage: string; field: string | null; traceId: string }>
/** Local operation metadata only. Objects/response bodies are never exact payload evidence. */
export type DiagnosticContextInput = {
  platform?: string
  stage?: string
  field?: string | null
  traceId?: string
  rawPayload?: { kind: "runtime" | "http" | "ozon_fields" | "wb_fields"; data: unknown } | null
}

/** Own data properties only: never invoke caller getters, including Proxy accessors. */
export function diagnosticProperty(source: unknown, key: string): unknown {
  try {
    if (!source || typeof source !== "object") return undefined
    const property = Object.getOwnPropertyDescriptor(source, key)
    return property && "value" in property ? property.value : undefined
  } catch { return undefined }
}

export function safeDiagnosticTrace(value: unknown): string | null {
  return typeof value === "string" && /^[A-Za-z0-9_.-]{1,128}$/.test(value) ? value : null
}

export function newDiagnosticId(): string {
  return crypto.randomUUID().toLowerCase()
}

/** No v3 sanitizer or producer: legacy callers retain only safe local context. */
export function createDiagnosticContext(input?: DiagnosticContextInput): { context: DiagnosticContext } {
  const platform = diagnosticProperty(input, "platform")
  const stage = diagnosticProperty(input, "stage")
  const field = diagnosticProperty(input, "field")
  return { context: Object.freeze({
    platform: typeof platform === "string" && /^[a-z][a-z0-9_-]{0,31}$/i.test(platform) ? platform.toLowerCase() : "web",
    stage: typeof stage === "string" && /^[a-z][a-z0-9_.-]{0,63}$/.test(stage) ? stage : "runtime",
    field: approvedDiagnosticField(field) ? field : null,
    traceId: safeDiagnosticTrace(diagnosticProperty(input, "traceId")) ?? newDiagnosticId(),
  }) }
}

/** Symbols only: never exception messages, source URLs, local paths or argument text. */
export function safeErrorFrames(reason: unknown, componentStack?: unknown): string[] {
  const frames: string[] = []
  const seen = new Set<unknown>()
  const append = (stack: unknown) => {
    if (typeof stack !== "string") return
    for (const line of stack.split("\n").slice(0, 100)) {
      const symbol = /^\s*at\s+(?:async\s+)?([A-Za-z_$<>][A-Za-z0-9_.$<>-]*)\s*(?:\(|$)/.exec(line)?.[1]
        ?? /^([A-Za-z_$][A-Za-z0-9_.$<>-]*)@/.exec(line)?.[1]
      if (symbol && /^[A-Za-z0-9_:<>.$-]{1,200}$/.test(symbol) && !frames.includes(symbol)) frames.push(symbol)
      if (frames.length === 20) break
    }
  }
  try {
    for (let error = reason; error instanceof Error && !seen.has(error) && seen.size < 8; error = error.cause) {
      seen.add(error)
      append(error.stack)
      if (frames.length === 20) break
    }
    append(componentStack)
  } catch { /* Diagnostics survive hostile Error getters. */ }
  return frames.slice(0, 20)
}
