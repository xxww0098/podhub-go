/** Public DTO fixtures only; no Seller credentials or remote resources. */
import type { WbCatalogRead } from "@/bindings/http-wb-catalog"
import type { WbMaterial, WbProductConfig } from "@/listing-core/wb-types"
import { nativeWbMaterial } from "@/features/workflow/platforms/wb/material"
export const wbFixtureState = { empty: false }

export const wbCatalogFixture: WbCatalogRead = {
  subject_id: 105, language: "ru", usable: true, issues: [],
  catalog: {
    parent_id: 1, subject_name: "Постеры", parent_name: "Декор", content_digest: `sha256:${"a".repeat(64)}`,
    fetched_at_ms: 1_790_000_000_000, expires_at_ms: 9_000_000_000_000, usable: true,
    fields: [
      { id: 100, name: "Цвет", required: true, value_kind: 1, max_count: 2 },
      { id: 200, name: "Вес", required: false, value_kind: 4, max_count: 0 },
      { id: 300, name: "Состав", required: false, required_for_create: true, value_kind: 1, max_count: 0 },
      { id: 400, name: "Legacy", required: false, value_kind: 0, max_count: 0 },
    ].map((field) => ({ unit_name: null, popular: false, has_filter: false, is_variable: false, required_for_create: null, named_field: null, ...field })),
  },
  defaults: { values: { "100": ["red"], "200": 5 }, revision: 3, validated_catalog_digest: `sha256:${"a".repeat(64)}`, usable: true },
}
export function wbMaterialFixture(): WbMaterial { return nativeWbMaterial(structuredClone(wbCatalogFixture)) }
export function wbConfigFixture(): WbProductConfig {
  return { subjectId: 105, language: "ru", variants: [{ vendorCode: "ART-7", title: "  Постер  ", brand: " ", characteristics: { "300": ["хлопок"] } }] }
}

export type WbCoordinateSample = "valid" | "second-only" | "both" | "group" | "variant"
/** Inputs only. All refusals and their coordinates still come from compiled Rust. */
export function wbCoordinateConfigFixture(sample: WbCoordinateSample): WbProductConfig {
  const config = wbConfigFixture()
  config.variants.push({ ...structuredClone(config.variants[0]!), vendorCode: "ART-8" })
  if (sample === "second-only" || sample === "both") config.variants[1]!.characteristics!["100"] = ["   "]
  if (sample === "both") config.variants[0]!.characteristics!["100"] = ["   "]
  if (sample === "group") config.subjectId = 106
  if (sample === "variant") config.variants[1]!.vendorCode = ""
  return config
}

/** The mock C response reads this public DTO; selecting it never loads metadata. */
export function setWbMaterialFixture(sample: "valid" | "blank-default"): void {
  wbCatalogFixture.defaults!.values = { "100": [sample === "blank-default" ? "   " : "red"], "200": 5 }
}
