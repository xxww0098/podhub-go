//! WHICH fields distinguish variants for one category, decided from that
//! category's own material.

use serde::{Deserialize, Serialize};

use crate::issue_keys::{KnownIssueKey, OzonVariantsCode};
use crate::records::ListingFieldDefinition;

/// Ozon's shared-model characteristic — the one field this version accepts as
/// a category's variant model. Re-exported from its single declaration
/// (`projections::OZON_MODEL_NAME_ATTRIBUTE_ID`) rather than repeated here.
pub use crate::projections::OZON_MODEL_NAME_ATTRIBUTE_ID as MODEL_ATTRIBUTE_ID;

/// Ozon's brand characteristic. One logical group is one product, so its
/// members must agree on the brand. The *key* carrying it is looked up in the
/// material (a category aliases it freely); only the attribute id is Ozon's.
pub const BRAND_ATTRIBUTE_ID: i64 = 85;

/// Whether this field's variant role comes from Ozon's `is_aspect` at all.
///
/// Only Seller attributes do. The fixed listing fields (`offer_id`, `price`, …)
/// are Listing's own and can never be a variant dimension, so their `aspect`
/// staying `None` does not mean "unknown" — it means the question does not
/// apply. This distinction is what keeps a fixed field from making every
/// category look like it needs a refresh.
pub fn declares_aspect(field: &ListingFieldDefinition) -> bool {
    field.attribute_id.is_some()
}

/// Whether this material was built with aspect metadata at all.
///
/// `false` is the old-material signal: an attribute field decodes with
/// `aspect == None`, which means the payload predates `is_aspect`. Cloud's
/// schema cache asks this to *notice* such a payload (it is replaced at the
/// cache TTL), and [`resolve_variant_rule`] refuses to *judge* it — the two
/// must agree about the fact, so both ask this one function.
pub fn carries_aspect_metadata(fields: &[ListingFieldDefinition]) -> bool {
    material_declares_aspect(
        fields
            .iter()
            .map(|field| (declares_aspect(field), field.aspect)),
    )
}

/// The same rule over the one fact it needs, so every material *shape* can ask
/// it without converting (and cloning) a whole payload.
///
/// Cloud's schema cache holds the wire field (`CatalogSchemaField`) while the
/// native snapshot holds a [`ListingFieldDefinition`]; both must answer the
/// same way, or the cache would call material current that the rule then
/// refuses (or the reverse). Cloud's
/// `listing::catalog::category_schema::carries_aspect_metadata` is the second
/// caller, and the two answers sitting side by side is the point of it.
pub fn material_declares_aspect(fields: impl IntoIterator<Item = (bool, Option<bool>)>) -> bool {
    fields
        .into_iter()
        .all(|(declares_aspect, aspect)| !declares_aspect || aspect.is_some())
}

/// The category's variant dimensions, once the material proves them.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct VariantDimensions {
    /// Field key of the plain `9048` model field: the shared model a whole
    /// logical group is imported under.
    pub model_field_key: String,
    /// Field key of every `is_aspect = true` field, in material order. Empty
    /// is a proof, not a default: a category whose material resolved every
    /// attribute to `false` really has no variant dimension.
    pub dimension_keys: Vec<String>,
}

/// Why this version cannot apply a variant rule to a category.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct VariantRefusal {
    /// A declared key, so Listing and Store surface it through the same
    /// coverage-checked table every other native issue uses.
    pub code: KnownIssueKey,
    /// The field the refusal is about, when it is about one field.
    #[serde(default)]
    pub field_key: Option<String>,
}

impl VariantRefusal {
    fn new(code: OzonVariantsCode, field_key: Option<String>) -> Self {
        Self {
            code: code.key(),
            field_key,
        }
    }
}

/// One category's variant rule — or the reason it cannot be decided.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", content = "value", rename_all = "snake_case")]
pub enum CategoryVariantRule {
    Known(VariantDimensions),
    Refused(VariantRefusal),
}

impl CategoryVariantRule {
    /// The dimensions, or `None` with the refusal already recorded.
    pub fn known(&self) -> Option<&VariantDimensions> {
        match self {
            Self::Known(dimensions) => Some(dimensions),
            Self::Refused(_) => None,
        }
    }
}

/// Decide which fields distinguish variants for this category material.
///
/// The order is deliberate, and each step is there for its own reason:
///
/// 1. **The model field is structural.** A refresh cannot conjure a `9048` a
///    category's material does not list, so "unsupported" is a stable answer
///    and not a request to try again. A `9048` that exists only inside a
///    complex group is refused for the same reason — this version has no
///    verified plain-model shape for it.
/// 2. **A complex aspect is a determined refusal.** This version has no
///    reliable normalisation for a dimension that lives in a repeated group,
///    and silently dropping the dimension would let two different variants be
///    written as one product. Refreshing cannot turn a complex group plain.
/// 3. **Only then does unknown metadata refuse.** It refuses the whole
///    category: "no dimensions" is never inferred from material that cannot
///    prove it.
pub fn resolve_variant_rule(fields: &[ListingFieldDefinition]) -> CategoryVariantRule {
    let model = fields
        .iter()
        .filter(|field| field.attribute_id_i64() == Some(MODEL_ATTRIBUTE_ID))
        .collect::<Vec<_>>();
    let Some(plain_model) = model.iter().find(|field| field.complex_id.is_none()) else {
        let code = if model.is_empty() {
            OzonVariantsCode::ModelFieldAbsent
        } else {
            OzonVariantsCode::ModelFieldComplex
        };
        return CategoryVariantRule::Refused(VariantRefusal::new(
            code,
            model.first().map(|field| field.key.clone()),
        ));
    };

    if let Some(field) = fields.iter().find(|field| {
        declares_aspect(field) && field.aspect == Some(true) && field.complex_id.is_some()
    }) {
        return CategoryVariantRule::Refused(VariantRefusal::new(
            OzonVariantsCode::DimensionComplex,
            Some(field.key.clone()),
        ));
    }

    if !carries_aspect_metadata(fields) {
        return CategoryVariantRule::Refused(VariantRefusal::new(
            OzonVariantsCode::MetadataUnknown,
            None,
        ));
    }

    CategoryVariantRule::Known(VariantDimensions {
        model_field_key: plain_model.key.clone(),
        dimension_keys: fields
            .iter()
            .filter(|field| declares_aspect(field) && field.aspect == Some(true))
            .map(|field| field.key.clone())
            .collect(),
    })
}
