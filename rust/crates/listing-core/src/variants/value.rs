//! What one member's value for one variant dimension means.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use crate::WorkflowDraftValue;
use crate::bridge::workflow_value_text;
use crate::records::{ChoiceValue, ListingFieldDefinition, RawDraftValue};
use crate::validate::{is_dictionary_editor, semantically_equal};

/// One member's value for one variant dimension.
///
/// Deliberately this module's own vocabulary rather than the workbench's
/// Draft: Listing converts a draft into it and Store converts Seller
/// attribute facts into it, and neither protocol model crosses into the
/// other's territory.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", content = "value", rename_all = "snake_case")]
pub enum DimensionValue {
    /// Nothing filled in. This is a **value**, not an absent field: two
    /// members that both leave an optional dimension empty share it, and a
    /// member that fills it in differs from both.
    Missing,
    /// Dictionary choices as confirmed value ids. The same id under two
    /// translations is one value; order is irrelevant.
    Dictionary(Vec<String>),
    /// One or more non-dictionary values, in the member's own order.
    Scalars(Vec<String>),
}

/// Reduce one draft value to the vocabulary above.
///
/// Dictionary editors keep the confirmed value ids and drop the labels — a
/// label is a translation, never an identity. Everything else keeps the
/// crate's canonical scalar text (`bridge::workflow_value_text`). Any empty
/// value, of any kind, is [`DimensionValue::Missing`].
pub fn dimension_value(
    field: &ListingFieldDefinition,
    value: Option<&WorkflowDraftValue>,
) -> DimensionValue {
    let Some(value) = value else {
        return DimensionValue::Missing;
    };
    if is_dictionary_editor(field.editor) {
        let ids = match value {
            WorkflowDraftValue::SingleSelect(choice) => {
                vec![choice.dictionary_value_id.to_string()]
            }
            WorkflowDraftValue::MultiSelect(choices) => choices
                .iter()
                .map(|choice| choice.dictionary_value_id.to_string())
                .collect(),
            // A dictionary field holding a non-selection is not a choice;
            // the validate stage owns that refusal, so it reads as empty
            // here rather than inventing an identity.
            _ => Vec::new(),
        };
        return if ids.is_empty() {
            DimensionValue::Missing
        } else {
            DimensionValue::Dictionary(ids)
        };
    }
    let scalars = match value {
        WorkflowDraftValue::TextList(values) | WorkflowDraftValue::UrlList(values) => {
            values.clone()
        }
        WorkflowDraftValue::IntegerList(values) => values.iter().map(ToString::to_string).collect(),
        WorkflowDraftValue::DecimalList(values) => values.iter().map(ToString::to_string).collect(),
        WorkflowDraftValue::BooleanList(values) => values.iter().map(ToString::to_string).collect(),
        other => vec![workflow_value_text(other)],
    };
    let scalars = scalars
        .into_iter()
        .filter(|scalar| !scalar.trim().is_empty())
        .collect::<Vec<_>>();
    if scalars.is_empty() {
        DimensionValue::Missing
    } else {
        DimensionValue::Scalars(scalars)
    }
}

/// Reduce a draft to the dimensions under judgement.
///
/// Every key in `dimension_keys` the material defines gets an entry, so a
/// dimension the operator left empty appears as [`DimensionValue::Missing`]
/// rather than as a hole — the caller never decides what "unfilled" means.
/// The caller passes `dimension_keys` and `fields` as the pair they came from
/// (`variants::VariantDimensions` and its material), so an undefined key
/// cannot arise.
pub fn dimension_values(
    fields: &[ListingFieldDefinition],
    dimension_keys: &[String],
    values: &BTreeMap<String, WorkflowDraftValue>,
) -> BTreeMap<String, DimensionValue> {
    dimension_keys
        .iter()
        .filter_map(|key| {
            let field = fields.iter().find(|field| &field.key == key)?;
            Some((key.clone(), dimension_value(field, values.get(key))))
        })
        .collect()
}

/// Compare two members' values for one dimension.
///
/// The rules are `validate::semantically_equal`'s — dictionary choices by
/// confirmed value id, numbers numerically, booleans by bit, text trimmed —
/// and this function only adapts the vocabulary to them. Two deliberate
/// choices sit on top:
///
/// - an unfilled value equals only another unfilled value, so a missing
///   optional dimension participates in the combination like any other value;
/// - a multi-value dimension compares as a **set**: order cannot change the
///   verdict.
pub(super) fn values_equal(
    field: &ListingFieldDefinition,
    left: &DimensionValue,
    right: &DimensionValue,
) -> bool {
    match (left, right) {
        (DimensionValue::Missing, DimensionValue::Missing) => true,
        (DimensionValue::Missing, _) | (_, DimensionValue::Missing) => false,
        (DimensionValue::Dictionary(left), DimensionValue::Dictionary(right)) => {
            semantically_equal(
                field,
                &RawDraftValue::ManyChoices(choices(left)),
                &RawDraftValue::ManyChoices(choices(right)),
            )
        }
        (DimensionValue::Dictionary(_), DimensionValue::Scalars(_))
        | (DimensionValue::Scalars(_), DimensionValue::Dictionary(_)) => false,
        (DimensionValue::Scalars(left), DimensionValue::Scalars(right)) => {
            scalars_equal(field, left, right)
        }
    }
}

fn choices(ids: &[String]) -> Vec<ChoiceValue> {
    ids.iter()
        .map(|id| ChoiceValue {
            id: id.clone(),
            label: String::new(),
        })
        .collect()
}

fn scalars_equal(field: &ListingFieldDefinition, left: &[String], right: &[String]) -> bool {
    if left.len() != right.len() {
        return false;
    }
    if let ([left], [right]) = (left, right) {
        return scalar_equal(field, left, right);
    }
    // A set, so each left value claims an unclaimed equal right value. The
    // element rule stays `semantically_equal`'s; no second value comparison
    // is invented here.
    let mut claimed = vec![false; right.len()];
    left.iter().all(|left| {
        let Some(index) = right
            .iter()
            .enumerate()
            .position(|(index, right)| !claimed[index] && scalar_equal(field, left, right))
        else {
            return false;
        };
        claimed[index] = true;
        true
    })
}

/// One scalar, through `semantically_equal`'s own editor rule. A value the
/// rule cannot parse at all (e.g. `abc` for an integer) does not equal even
/// itself there — that is the crate's existing answer, and the validate stage
/// refuses such a value long before a grouping write could matter.
fn scalar_equal(field: &ListingFieldDefinition, left: &str, right: &str) -> bool {
    semantically_equal(
        field,
        &RawDraftValue::Text(left.to_owned()),
        &RawDraftValue::Text(right.to_owned()),
    )
}
