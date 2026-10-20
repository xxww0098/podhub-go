use std::collections::BTreeMap;

use serde::Serialize;
use sha2::{Digest, Sha256};

pub use super::records::{
    CategorySchemaSnapshot, ListingFieldConstraints, ListingFieldDefinition, ListingFieldEditor,
};

/// Bumped 1 → 2 when `SemanticFieldIdentity` gained `aspect`.
///
/// The version is part of the hashed material, so **no material hashed under
/// the old shape can ever hash to the same value as material hashed under the
/// new one** — every Schema Revision moved, and a Draft or a cache entry
/// pinned to 1 cannot be mistaken for a 2 whose aspect facts happen to be
/// absent. That is deliberate: the whole point of the `None` aspect state is
/// that it means *unknown*, and an unknown-vs-known difference must never be
/// invisible to the revision.
///
/// The second half of the same contract is `ListingFieldDefinition::aspect`
/// itself: it is the *completeness marker*. Material written before this
/// change decodes with every attribute field's `aspect` at `None`, so
/// `variants::carries_aspect_metadata` answers "refresh me" instead of "this
/// category has no variant dimensions". Bumping the version alone would move
/// the hash without telling anyone which way; the per-field marker alone
/// would leave old and new material colliding on a revision. Both are needed.
const SCHEMA_FORMAT_VERSION: u32 = 2;
const NORMALIZATION_RULESET_VERSION: u32 = 1;
const VALIDATION_RULESET_VERSION: u32 = 1;
const SERIALIZER_RULESET_VERSION: u32 = 1;

/// Semantic identity of one field for Schema Revision hashing.
/// Presentation (label, group, description) is intentionally absent — see
/// CONTEXT.md's Schema Revision.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct SemanticFieldIdentity {
    pub key: String,
    pub editor: ListingFieldEditor,
    pub required: bool,
    pub collection: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_value_count: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dictionary_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub attribute_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub complex_id: Option<String>,
    pub complex_group_collection: bool,
    pub read_only: bool,
    /// Ozon `is_aspect` — the variant-dimension fact a grouping write is
    /// judged against. Always serialized, so `null` (unknown) is a value in
    /// the material and cannot be confused with `false`.
    pub aspect: Option<bool>,
    /// Dictionary option ids only — display strings do not enter the revision.
    pub option_ids: Vec<String>,
    pub options_truncated: bool,
}

/// Semantic identity of one complex group (no display name).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct SemanticComplexGroupIdentity {
    pub complex_id: i64,
    pub collection: bool,
    pub field_keys: Vec<String>,
}

/// Hash the semantic surface of a Category Schema into a Schema Revision.
///
/// Used by the workflow → Listing bridge so pure presentation changes never
/// produce `IncompatibleSchemaUpgrade`.
pub fn semantic_schema_revision(
    description_category_id: i64,
    type_id: i64,
    recipe_id: i64,
    recipe_revision: i64,
    catalog_schema_version: u32,
    fields: &[SemanticFieldIdentity],
    complex_groups: &[SemanticComplexGroupIdentity],
) -> String {
    #[derive(Serialize)]
    struct SemanticMaterial<'a> {
        schema_format_version: u32,
        normalization_ruleset_version: u32,
        validation_ruleset_version: u32,
        serializer_ruleset_version: u32,
        description_category_id: i64,
        type_id: i64,
        recipe_id: i64,
        recipe_revision: i64,
        catalog_schema_version: u32,
        fields: &'a [SemanticFieldIdentity],
        complex_groups: &'a [SemanticComplexGroupIdentity],
    }

    // option_ids are an unordered set. Field order and field_keys stay as given.
    let mut canonical_fields = fields.to_vec();
    for field in &mut canonical_fields {
        field.option_ids.sort();
    }

    let material = SemanticMaterial {
        schema_format_version: SCHEMA_FORMAT_VERSION,
        normalization_ruleset_version: NORMALIZATION_RULESET_VERSION,
        validation_ruleset_version: VALIDATION_RULESET_VERSION,
        serializer_ruleset_version: SERIALIZER_RULESET_VERSION,
        description_category_id,
        type_id,
        recipe_id,
        recipe_revision,
        catalog_schema_version,
        fields: &canonical_fields,
        complex_groups,
    };
    let encoded = serde_json::to_vec(&material).expect("semantic schema material serializes");
    let digest = Sha256::digest(encoded);
    format!("sha256:{digest:x}")
}

/// The semantic surface of one field for revision hashing (presentation
/// absent).
fn semantic_field_identities(fields: &[ListingFieldDefinition]) -> Vec<SemanticFieldIdentity> {
    fields
        .iter()
        .map(|field| SemanticFieldIdentity {
            key: field.key.clone(),
            editor: field.editor,
            required: field.required,
            collection: field.constraints.collection,
            max_value_count: field.constraints.max_value_count,
            dictionary_id: field.constraints.dictionary_id.clone(),
            attribute_id: field.attribute_id.clone(),
            complex_id: field.complex_id.clone(),
            complex_group_collection: field.complex_group_collection,
            read_only: field.read_only,
            aspect: field.aspect,
            option_ids: field
                .options
                .iter()
                .map(|option| option.id.clone())
                .collect(),
            options_truncated: field.options_truncated,
        })
        .collect::<Vec<_>>()
}

fn semantic_complex_groups(fields: &[ListingFieldDefinition]) -> Vec<SemanticComplexGroupIdentity> {
    let mut grouped = BTreeMap::<i64, SemanticComplexGroupIdentity>::new();
    for field in fields {
        let Some(complex_id) = field.complex_id_i64() else {
            continue;
        };
        let group = grouped
            .entry(complex_id)
            .or_insert_with(|| SemanticComplexGroupIdentity {
                complex_id,
                collection: field.complex_group_collection,
                field_keys: Vec::new(),
            });
        group.collection |= field.complex_group_collection;
        group.field_keys.push(field.key.clone());
    }
    grouped.into_values().collect::<Vec<_>>()
}

/// The content digest of a snapshot's semantic material — what "same revision,
/// same content" means for the `listing_schema_revisions` registry
/// (db-write-amp 04). Display material is intentionally absent, so a
/// label-only catalog refresh re-hashes equal under an unchanged revision.
pub fn snapshot_semantic_digest(snapshot: &CategorySchemaSnapshot) -> String {
    semantic_schema_revision(
        snapshot.description_category_id,
        snapshot.type_id,
        snapshot.recipe_id,
        snapshot.recipe_revision,
        snapshot.catalog_schema_version,
        &semantic_field_identities(&snapshot.fields),
        &semantic_complex_groups(&snapshot.fields),
    )
}

/// Build the snapshot — Schema Revision included — from field material.
/// The Cloud schema cache reuses this so a cached payload can never carry a
/// revision of its own.
pub fn snapshot_from_live_fields(
    description_category_id: i64,
    type_id: i64,
    fields: Vec<ListingFieldDefinition>,
) -> CategorySchemaSnapshot {
    let semantic_fields = semantic_field_identities(&fields);
    let complex_groups = semantic_complex_groups(&fields);
    let schema_revision = format!(
        "workflow:{}",
        semantic_schema_revision(
            description_category_id,
            type_id,
            0,
            0,
            0,
            &semantic_fields,
            &complex_groups,
        )
    );
    CategorySchemaSnapshot {
        category_key: format!("workflow:{description_category_id}:{type_id}"),
        label: format!("Ozon {description_category_id} / {type_id}"),
        description_category_id,
        type_id,
        schema_revision,
        recipe_id: 0,
        recipe_revision: 0,
        catalog_schema_version: 0,
        fields,
    }
}

/// Fixed (non-attribute) fields every live Category Schema carries. `pub`
/// because the async `CategorySchemaBuilder` that assembles these with live
/// attribute fields lives in Cloud's `listing::catalog::schema_builder` (this
/// crate may not depend on `seller_api`/`futures_util`).
pub fn live_fixed_fields() -> Vec<ListingFieldDefinition> {
    [
        (
            "offer_id",
            "Offer ID",
            ListingFieldEditor::Text,
            true,
            false,
        ),
        ("name", "Name", ListingFieldEditor::Text, true, false),
        ("price", "Price", ListingFieldEditor::Decimal, true, false),
        (
            "description_category_id",
            "Description category",
            ListingFieldEditor::Integer,
            true,
            true,
        ),
        (
            "type_id",
            "Product type",
            ListingFieldEditor::Integer,
            true,
            true,
        ),
        ("barcode", "Barcode", ListingFieldEditor::Text, false, false),
        ("width", "Width", ListingFieldEditor::Integer, true, false),
        ("height", "Height", ListingFieldEditor::Integer, true, false),
        ("depth", "Depth", ListingFieldEditor::Integer, true, false),
        (
            "dimension_unit",
            "Dimension unit",
            ListingFieldEditor::Text,
            true,
            false,
        ),
        ("weight", "Weight", ListingFieldEditor::Integer, true, false),
        (
            "weight_unit",
            "Weight unit",
            ListingFieldEditor::Text,
            true,
            false,
        ),
        ("images", "Images", ListingFieldEditor::UrlList, true, false),
        (
            "images360",
            "360 images",
            ListingFieldEditor::UrlList,
            false,
            false,
        ),
        (
            "primary_image",
            "Primary image",
            ListingFieldEditor::Url,
            false,
            false,
        ),
        (
            "color_image",
            "Color image",
            ListingFieldEditor::Url,
            false,
            false,
        ),
        (
            "currency_code",
            "Currency",
            ListingFieldEditor::Text,
            false,
            false,
        ),
        (
            "old_price",
            "Old price",
            ListingFieldEditor::Decimal,
            false,
            false,
        ),
        ("vat", "VAT", ListingFieldEditor::Decimal, true, false),
    ]
    .into_iter()
    .map(
        |(key, label, editor, required, read_only)| ListingFieldDefinition {
            key: key.to_owned(),
            label: label.to_owned(),
            group: "Fixed".to_owned(),
            editor,
            required,
            constraints: ListingFieldConstraints {
                collection: matches!(editor, ListingFieldEditor::UrlList),
                max_value_count: matches!(key, "images" | "images360").then_some(15),
                dictionary_id: None,
            },
            read_only,
            ..ListingFieldDefinition::default()
        },
    )
    .collect()
}

/// `pub` for the same reason as [`live_fixed_fields`]: only Cloud's
/// `CategorySchemaBuilder` (async, in `catalog::schema_builder`) calls this now.
pub fn infer_editor(
    raw_type: &str,
    collection: bool,
    has_dictionary: bool,
    options_truncated: bool,
) -> ListingFieldEditor {
    let normalized = raw_type
        .trim()
        .to_ascii_lowercase()
        .replace(['-', ' '], "_");
    let scalar = match normalized.as_str() {
        "integer" | "int" | "int32" | "int64" | "long" => ListingFieldEditor::Integer,
        "decimal" | "float" | "double" | "number" | "numeric" => ListingFieldEditor::Decimal,
        "boolean" | "bool" => ListingFieldEditor::Boolean,
        "url" | "uri" | "link" => ListingFieldEditor::Url,
        "url_list" | "urls" | "uri_list" | "link_list" => ListingFieldEditor::UrlList,
        "enum" | "enumeration" | "select" | "dictionary" => ListingFieldEditor::SingleSelect,
        "multiselect" | "multi_select" | "multi_enum" | "enum_list" => {
            ListingFieldEditor::MultiSelect
        }
        "string" | "text" | "char" | "textarea" | "rich_text" | "richtext" => {
            ListingFieldEditor::Text
        }
        _ => return ListingFieldEditor::Text,
    };
    if has_dictionary {
        if options_truncated {
            return ListingFieldEditor::DictionarySearch;
        }
        return if collection {
            ListingFieldEditor::MultiSelect
        } else {
            ListingFieldEditor::SingleSelect
        };
    }
    if collection {
        match scalar {
            ListingFieldEditor::Url | ListingFieldEditor::UrlList => ListingFieldEditor::UrlList,
            ListingFieldEditor::MultiSelect | ListingFieldEditor::SingleSelect => {
                ListingFieldEditor::MultiSelect
            }
            other => other,
        }
    } else {
        scalar
    }
}

#[cfg(test)]
mod tests;
