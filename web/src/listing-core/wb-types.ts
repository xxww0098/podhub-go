/** Mirrors listing-core::wb, not Seller HTTP or browser field rules. */
import type { components } from "@/api/schema"
import type { KnownIssueKey } from "./types"

export type WbLanguage = components["schemas"]["WbLanguage"]
export type WbFields = Record<string, string[] | number>
/** The compiled core's own serde ABI (camelCase); the wire spells it snake_case. */
export type WbCharacteristicAbi = {
  id: number
  name: string
  required: boolean
  valueKind: number
  maxCount: number
  unitName: string | null
  popular: boolean
  hasFilter: boolean
  isVariable: boolean
  requiredForCreate: boolean | null
  namedField: boolean | null
}
export type WbMaterial = {
  subjectId: number
  language: WbLanguage
  catalog: { fields: WbCharacteristicAbi[]; contentDigest: string; usable: boolean } | null
  defaults: { values: WbFields; revision: number; validatedCatalogDigest: string } | null
}
export type WbDimensions = { length?: number; width?: number; height?: number; weightBrutto?: number }
export type WbSize = { techSize?: string; wbSize?: string; price?: number; skus?: string[] }
export type WbDocument = { type?: number; number?: string; productNumber?: string; tradeName?: string; applicant?: string; startDate?: string; endDate?: string; isEndless?: boolean }
export type WbVariantConfig = {
  vendorCode: string
  title?: string | null
  brand?: string | null
  description?: string | null
  kizMarked?: boolean | null
  wholesale?: { enabled?: boolean; quantum?: number } | null
  dimensions?: WbDimensions | null
  sizes?: WbSize[]
  documents?: { items?: WbDocument[]; excludeDocuments?: boolean } | null
  characteristics?: WbFields
  cleared?: number[]
}
export type WbProductConfig = { subjectId: number; language: WbLanguage; variants: WbVariantConfig[] }
export type WbCardGroup = {
  subjectID: number
  variants: Array<Omit<WbVariantConfig, "characteristics" | "cleared"> & { characteristics?: Array<{ id: number; value: string[] | number }> }>
}
export type WbIssue = {
  key: Extract<KnownIssueKey, { platform: "wb" }>
  field: components["schemas"]["WbMaterialIssueField"]
  characteristicId: number | null
  variantIndex: number | null
  scope: "material" | "group" | "variant"
}
export type WbPreview = { group: WbCardGroup | null; uploadBytes: number[] | null; issues: WbIssue[] }
/** Object identity is checked by its owning native instance, including after restart. */
export type WbSchemaHandle = Readonly<{ platform: "wb"; handle: number }>

/** Only JSON representability is checked here. Native owns every field rule.
 * In particular JSON.stringify(NaN) must never turn an invalid number into null. */
export function assertWbJson(value: unknown): void {
  const active = new Set<object>()
  function visit(entry: unknown): void {
    if (entry === null || typeof entry === "boolean" || entry === undefined) return
    if (typeof entry === "number") {
      if (!Number.isFinite(entry) || (Number.isInteger(entry) && !Number.isSafeInteger(entry))) throw new TypeError("WB JSON number cannot be represented without loss")
      return
    }
    if (typeof entry === "string") {
      if (/\p{Cs}/u.test(entry)) throw new TypeError("WB JSON text contains an unpaired surrogate")
      return
    }
    if (typeof entry !== "object" || active.has(entry)) throw new TypeError("WB input is not an acyclic JSON value")
    if (!Array.isArray(entry) && Object.getPrototypeOf(entry) !== Object.prototype && Object.getPrototypeOf(entry) !== null) throw new TypeError("WB input must contain plain JSON records")
    active.add(entry)
    if (Array.isArray(entry)) {
      for (const child of entry) {
        if (child === undefined) throw new TypeError("WB JSON array contains an absent value")
        visit(child)
      }
    } else for (const [key, child] of Object.entries(entry)) {
      visit(key)
      if (/^-?\d+$/.test(key) && !Number.isSafeInteger(Number(key))) throw new TypeError("WB JSON field identity exceeds safe integer precision")
      visit(child)
    }
    active.delete(entry)
  }
  visit(value)
}
