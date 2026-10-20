import type { components } from "@/api/schema"

export type DiagnosticEvent = Omit<components["schemas"]["DesktopErrorLogV4"], "schema_version"> & { schema_version: 4 }
export type DiagnosticCode = components["schemas"]["DiagnosticCode"]
export type DiagnosticStage = components["schemas"]["DiagnosticStage"]
export type DiagnosticFieldSummary = components["schemas"]["DiagnosticFieldSummary"]

// Wire privacy grammar, shared with migration/src/diagnostic_v3_projection/summary.rs.
const NAMES = new Set([
  "name", "offer_id", "price", "old_price", "vat", "currency_code", "height", "width", "depth", "weight",
  "dimension_unit", "weight_unit", "description_category_id", "type_id", "attributes", "id", "complex_id",
  "values", "dictionary_value_id", "value", "subjectID", "vendorCode", "title", "description", "brand",
  "dimensions", "length", "weightBrutto", "characteristics", "sizes", "techSize", "wbSize", "skus",
  "request", "atMs", "bytes", "ms", "memoryBytes", "imageIndex", "rows", "status", "attempt", "method", "path", "code",
])
export const DIAGNOSTIC_CODES = Object.freeze({
  contract_violation: true, unclassified_server: true, wasm_exception: true, result_unknown: true,
} satisfies Record<DiagnosticCode, true>)
export const DIAGNOSTIC_STAGES = Object.freeze({
  import: true, edit: true, prepare: true, validate: true, build: true, freeze: true, preview: true,
  pre_dispatch: true, submit: true, reconcile: true, repair: true, result: true,
} satisfies Record<DiagnosticStage, true>)

export function approvedDiagnosticField(value: unknown): value is string {
  return typeof value === "string" && value.length <= 128 && value.split(".").every((part) => {
    const match = /^([A-Za-z0-9_]+)((?:\[\d{1,6}\])*)$/.exec(part)
    return !!match && NAMES.has(match[1]!)
  })
}

function enumValue(field: string, value: unknown): DiagnosticFieldSummary["enum_value"] {
  switch (field) {
    case "currency_code": return value === "RUB" || value === "USD" || value === "EUR" || value === "CNY" ? value : null
    case "dimension_unit": return value === "mm" || value === "cm" || value === "m" ? value : null
    case "weight_unit": return value === "g" || value === "kg" ? value : null
    default: return null
  }
}

/** Parse ONLY the owner's exact JSON text. Unknown names are omitted, values never copied. */
export function summarizeDiagnosticJson(text: string): DiagnosticFieldSummary[] {
  const out: DiagnosticFieldSummary[] = []
  const addresses = new Set<string>()
  const walk = (value: unknown, field: string, depth: number) => {
    if (out.length >= 64 || depth > 8 || !approvedDiagnosticField(field) || addresses.has(field)) return
    addresses.add(field)
    const valueType: DiagnosticFieldSummary["value_type"] = value === null ? "null" : Array.isArray(value) ? "array"
      : typeof value === "object" ? "object" : typeof value === "string" ? "string" : typeof value === "boolean" ? "boolean" : "number"
    // One UTF16 surrogate pair is one Unicode scalar; avoid allocating an array of the whole original.
    const length = typeof value === "string" ? value.replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g, "x").length : Array.isArray(value) ? value.length
      : value && typeof value === "object" ? Object.keys(value).length : null
    const catalogAddress = field.startsWith("attributes[") || field.startsWith("characteristics[")
      || ["description_category_id", "type_id", "subjectID"].includes(field)
    const catalogValue = /(?:^|\.)(?:id|complex_id|dictionary_value_id|description_category_id|type_id|subjectID)$/.test(field)
    const fieldId = catalogAddress && catalogValue && typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null
    out.push({ field, field_id: fieldId, value_type: valueType, length, enum_value: enumValue(field, value) })
    if (Array.isArray(value)) {
      for (let i = 0; i < value.length && out.length < 64; i++) walk(value[i], `${field}[${i}]`, depth + 1)
    } else if (value && typeof value === "object") {
      for (const [key, child] of Object.entries(value)) {
        if (out.length >= 64) break
        if (!NAMES.has(key)) continue
        walk(child, `${field}.${key}`, depth + 1)
      }
    }
  }
  try {
    const root: unknown = JSON.parse(text)
    if (root && typeof root === "object" && !Array.isArray(root)) {
      for (const [key, value] of Object.entries(root)) {
        if (out.length >= 64) break
        if (!NAMES.has(key)) continue
        walk(value, key, 0)
      }
    }
  } catch { /* Invalid original JSON still hashes exactly, without an invented summary. */ }
  return out
}

export async function diagnosticSha256(text: string): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))
  return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join("")
}
