/** C: explicit coordinate open/refresh only. One read, no retry or cold fill. */
import { request } from "@/api/client"
import { route } from "@/api/routes"
import type { components, operations } from "@/api/schema"
import { assertWbJson } from "@/listing-core/wb-types"
import { isRecord } from "./http-listing-intents"

type Wire = components["schemas"]["WbCatalogResponse"]
export type WbCatalogRead = Omit<Wire, "issues"> & {
  /** Unknown future issue identities survive, without granting any actions. */
  issues: Array<Omit<components["schemas"]["WbMaterialIssue"], "key"> & { key: { platform: string; stage: string; code: string } }>
}
export type WbCoordinate = { subjectId: operations["catalogWBSubject"]["parameters"]["path"]["subject_id"]; language: components["schemas"]["WbLanguage"] }
export function wbCatalogContractError(): Error {
  return Object.assign(new Error("WB 类目响应无法对应当前类目和语言，请显式刷新；仍失败请联系管理员核对目录数据"), { code: "wb_catalog_contract_invalid" })
}
const integer = (value: unknown) => Number.isSafeInteger(value)
const nullableBoolean = (value: unknown) => value == null || typeof value === "boolean"
const nullableString = (value: unknown) => value == null || typeof value === "string"

function materialShape(value: unknown): value is WbCatalogRead {
  if (!isRecord(value) || !integer(value.subject_id) || !["ru", "en", "zh"].includes(String(value.language))
    || typeof value.usable !== "boolean" || !Array.isArray(value.issues)) return false
  if (!value.issues.every((issue) => {
    if (!isRecord(issue) || !isRecord(issue.key)) return false
    const key = issue.key
    return ["platform", "stage", "code"].every((name) => typeof key[name] === "string")
      && ["catalog", "defaults", "subject", "language", "variants", "vendor_code", "title", "dimensions", "characteristic", "payload"].includes(String(issue.field))
      && issue.scope === "material" && (issue.characteristic_id == null || integer(issue.characteristic_id))
  })) return false
  if (value.catalog != null) {
    const catalog = value.catalog
    if (!isRecord(catalog) || typeof catalog.content_digest !== "string" || typeof catalog.usable !== "boolean"
      || !integer(catalog.parent_id) || typeof catalog.subject_name !== "string" || typeof catalog.parent_name !== "string"
      || !integer(catalog.expires_at_ms) || !integer(catalog.fetched_at_ms) || !Array.isArray(catalog.fields)) return false
    if (!catalog.fields.every((field) => isRecord(field) && integer(field.id) && typeof field.name === "string"
      && ["required", "popular", "has_filter", "is_variable"].every((key) => typeof field[key] === "boolean")
      && ["max_count", "value_kind"].every((key) => integer(field[key]) && Number(field[key]) >= 0 && Number(field[key]) <= 0xffff_ffff)
      && nullableBoolean(field.required_for_create) && nullableBoolean(field.named_field) && nullableString(field.unit_name))) return false
  }
  if (value.defaults != null) {
    const defaults = value.defaults
    if (!isRecord(defaults) || !integer(defaults.revision) || typeof defaults.usable !== "boolean"
      || typeof defaults.validated_catalog_digest !== "string" || !isRecord(defaults.values)
      || !Object.entries(defaults.values).every(([id, field]) => /^-?\d+$/.test(id) && integer(Number(id))
        && (typeof field === "number" || (Array.isArray(field) && field.every((item) => typeof item === "string"))))) return false
  }
  return true
}

export async function readWbCatalog(coordinate: WbCoordinate, signal?: AbortSignal): Promise<WbCatalogRead> {
  if (!integer(coordinate.subjectId) || coordinate.subjectId <= 0 || !["ru", "en", "zh"].includes(coordinate.language)) throw wbCatalogContractError()
  const value = await request<unknown>("GET", `${route("catalogWbSubjectsBySubjectId", { subject_id: coordinate.subjectId })}?${new URLSearchParams({ language: coordinate.language })}`,
    undefined, {}, 15_000, undefined, { callerSignal: signal, reportOwner: "caller", responseBody: "json" })
  try { assertWbJson(value) } catch { throw wbCatalogContractError() }
  if (!materialShape(value) || value.subject_id !== coordinate.subjectId || value.language !== coordinate.language) throw wbCatalogContractError()
  return value
}
