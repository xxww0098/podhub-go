//! Wire shape for `schema_load`'s input buffer: the pinned Category Schema
//! plus the truncated-dictionary search hits the schema cache resolved for
//! it — the two halves `listing_core::ops::SchemaMaterial::new` takes.
//!
//! `DictionaryMaterials` itself carries no `Serialize`/`Deserialize`
//! (`rust/crates/listing-core/src/validate.rs`: it is a private-field bag built
//! through `insert`/`insert_searched`, not a wire type). Production's only
//! real caller (`src/listing/catalog/category_schema.rs`) only ever calls
//! `insert_searched` — the "member" half comes from
//! `ListingFieldDefinition.options` instead — so this wire format only needs
//! to round-trip that one half. Slice 11 (schema cache) owns firming up the
//! network response shape this eventually decodes; this is a provisional,
//! internal-only format until then.

use listing_core::ops::SchemaMaterial;
use listing_core::records::CategorySchemaSnapshot;
use listing_core::validate::DictionaryMaterials;
use serde::Deserialize;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SchemaLoadInput {
    snapshot: CategorySchemaSnapshot,
    #[serde(default)]
    search_materials: Vec<SearchMaterialEntry>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SearchMaterialEntry {
    description_category_id: i64,
    attribute_id: i64,
    dictionary_id: i64,
    value_id: i64,
    label: String,
}

/// Decodes a `schema_load` call's input buffer into a resident
/// [`SchemaMaterial`]. The caller (`lib.rs`'s `schema_load`) owns handing the
/// result a table slot; a decode failure is always `CORE_DECODE` — a bad
/// buffer never reaches "no such handle" territory.
pub(crate) fn decode_schema(bytes: &[u8]) -> Result<SchemaMaterial, serde_json::Error> {
    let input: SchemaLoadInput = serde_json::from_slice(bytes)?;
    let mut materials = DictionaryMaterials::default();
    for entry in input.search_materials {
        materials.insert_searched(
            entry.description_category_id,
            entry.attribute_id,
            entry.dictionary_id,
            entry.value_id,
            entry.label,
        );
    }
    Ok(SchemaMaterial::new(
        std::sync::Arc::new(input.snapshot),
        materials,
    ))
}
