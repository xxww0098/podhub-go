import type { WbCatalogRead } from "@/bindings/http-wb-catalog"
import type { WbMaterial } from "@/listing-core/wb-types"

/** HTTP → native material; Cloud owns usability and the expiry boundary. */
export function nativeWbMaterial(response: WbCatalogRead): WbMaterial {
  return {
    subjectId: response.subject_id, language: response.language,
    catalog: response.catalog ? {
      // The wire spells characteristics snake_case; the core's serde ABI is camelCase.
      fields: response.catalog.fields.map((field) => ({
        id: field.id, name: field.name, required: field.required, valueKind: field.value_kind,
        maxCount: field.max_count, unitName: field.unit_name ?? null, popular: field.popular,
        hasFilter: field.has_filter, isVariable: field.is_variable,
        requiredForCreate: field.required_for_create ?? null, namedField: field.named_field ?? null,
      })), contentDigest: response.catalog.content_digest,
      usable: response.catalog.usable,
    } : null,
    defaults: response.defaults ? {
      values: structuredClone(response.defaults.values), revision: response.defaults.revision,
      validatedCatalogDigest: response.defaults.validated_catalog_digest,
    } : null,
  }
}
