//! Group validation: one logical group of members, judged as a whole.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use crate::issue_keys::{KnownIssueKey, OzonVariantsCode};
use crate::records::ListingFieldDefinition;

use super::field::{
    BRAND_ATTRIBUTE_ID, CategoryVariantRule, VariantDimensions, VariantRefusal,
    resolve_variant_rule,
};
use super::value::{DimensionValue, values_equal};

/// The facts every member of one logical group must share.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct GroupIdentity {
    pub description_category_id: i64,
    pub type_id: i64,
    /// The member's brand, reduced to the dimension vocabulary: Ozon's brand
    /// attribute `85` as a confirmed dictionary value id
    /// ([`DimensionValue::Dictionary`]) when the category has a dictionary,
    /// its text ([`DimensionValue::Scalars`]) otherwise, and
    /// [`DimensionValue::Missing`] when the member carries none.
    pub brand: DimensionValue,
}

/// One member of a logical group.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct VariantMember {
    /// The member's identity in the caller's own domain — a listing row id,
    /// an offer id, a Seller product id. Only ever used to name a problem.
    pub member_id: String,
    pub identity: GroupIdentity,
    /// Values by dimension field key. An absent key is an unfilled dimension
    /// and compares exactly like [`DimensionValue::Missing`].
    #[serde(default)]
    pub values: BTreeMap<String, DimensionValue>,
}

/// One logical group as a single write sees it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct GroupWrite {
    /// **Every** member of the logical group, never only the rows this write
    /// sends. The judgement always uses this complete set.
    pub members: Vec<VariantMember>,
    /// The members this write actually sends — a subset of `members`. It
    /// changes nothing about the verdict above.
    ///
    /// It exists so that "one member" is visibly a subset of a larger group
    /// rather than a group of one: a single-row write is never refused merely
    /// for being a single row, and never judged against its own row alone.
    #[serde(default)]
    pub write_member_ids: Vec<String>,
}

/// One typed finding, shaped so that both entries can surface it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct VariantProblem {
    /// A declared key, so Listing and Store render it through the same
    /// coverage-checked table every other native issue uses.
    pub code: KnownIssueKey,
    /// The member at fault. `None` for a problem about the group or the
    /// category material rather than one row.
    #[serde(default)]
    pub member_id: Option<String>,
    /// The field at fault, when the problem is about one field. A duplicate
    /// complete combination is about the whole dimension set, so it names no
    /// single field.
    #[serde(default)]
    pub field_key: Option<String>,
}

impl VariantProblem {
    fn new(code: OzonVariantsCode, member_id: Option<String>, field_key: Option<String>) -> Self {
        Self {
            code: code.key(),
            member_id,
            field_key,
        }
    }
}

/// Judge one logical group against its category's own material.
///
/// Problems come back in a fixed order — the rule refusal first (it decides
/// the whole write and returns), then identity in member order, then
/// combinations in member order, then the write subset — so Cloud and the
/// browser compare equal *lists*, not merely equal sets.
///
/// An empty group is not a problem: there is nothing to judge. So is a group
/// of one, which is why `write_member_ids` is recorded separately — what is
/// being judged is the complete group, not the write.
pub fn validate_group(
    fields: &[ListingFieldDefinition],
    write: &GroupWrite,
) -> Vec<VariantProblem> {
    let dimensions = match resolve_variant_rule(fields) {
        CategoryVariantRule::Known(dimensions) => dimensions,
        CategoryVariantRule::Refused(refusal) => return vec![refusal_problem(&refusal)],
    };
    let mut problems = Vec::new();
    if let Some(first) = write.members.first() {
        let brand_key = fields
            .iter()
            .find(|field| field.attribute_id_i64() == Some(BRAND_ATTRIBUTE_ID))
            .map(|field| field.key.clone());
        for member in &write.members {
            if member.identity.description_category_id != first.identity.description_category_id
                || member.identity.type_id != first.identity.type_id
            {
                problems.push(VariantProblem::new(
                    OzonVariantsCode::CategoryMismatch,
                    Some(member.member_id.clone()),
                    None,
                ));
            }
            if member.identity.brand != first.identity.brand {
                problems.push(VariantProblem::new(
                    OzonVariantsCode::BrandMismatch,
                    Some(member.member_id.clone()),
                    brand_key.clone(),
                ));
            }
        }
    }
    problems.extend(combination_problems(fields, &dimensions, write));
    for member_id in &write.write_member_ids {
        if !write
            .members
            .iter()
            .any(|member| &member.member_id == member_id)
        {
            problems.push(VariantProblem::new(
                OzonVariantsCode::WriteMemberUnknown,
                Some(member_id.clone()),
                None,
            ));
        }
    }
    problems
}

/// Every pair of members must differ in at least one real dimension.
///
/// A category whose material resolved no dimension cannot tell two members
/// apart at all — that is a fact about the category, so it is reported once,
/// without a member. A category that does have dimensions reports the members
/// whose complete combination repeats an earlier member's, once per member.
fn combination_problems(
    fields: &[ListingFieldDefinition],
    dimensions: &VariantDimensions,
    write: &GroupWrite,
) -> Vec<VariantProblem> {
    if dimensions.dimension_keys.is_empty() {
        return if write.members.len() > 1 {
            vec![VariantProblem::new(
                OzonVariantsCode::NoDistinguishingDimension,
                None,
                Some(dimensions.model_field_key.clone()),
            )]
        } else {
            Vec::new()
        };
    }
    let combinations = write
        .members
        .iter()
        .map(|member| combination(dimensions, member))
        .collect::<Vec<_>>();
    let mut problems = Vec::new();
    for (index, combination) in combinations.iter().enumerate() {
        let repeats = combinations[..index]
            .iter()
            .any(|earlier| equal_combinations(fields, dimensions, earlier, combination));
        if repeats {
            problems.push(VariantProblem::new(
                OzonVariantsCode::CombinationDuplicate,
                Some(write.members[index].member_id.clone()),
                None,
            ));
        }
    }
    problems
}

/// One member's complete combination, with an unfilled dimension
/// materialised as [`DimensionValue::Missing`] so that it participates.
fn combination(dimensions: &VariantDimensions, member: &VariantMember) -> Vec<DimensionValue> {
    dimensions
        .dimension_keys
        .iter()
        .map(|key| {
            member
                .values
                .get(key)
                .cloned()
                .unwrap_or(DimensionValue::Missing)
        })
        .collect()
}

fn equal_combinations(
    fields: &[ListingFieldDefinition],
    dimensions: &VariantDimensions,
    left: &[DimensionValue],
    right: &[DimensionValue],
) -> bool {
    if left.len() != right.len() {
        return false;
    }
    dimensions
        .dimension_keys
        .iter()
        .zip(left.iter().zip(right))
        .all(|(key, (left, right))| match field_of(fields, key) {
            Some(field) => values_equal(field, left, right),
            // Unreachable: the keys came out of `fields` in
            // `resolve_variant_rule`. Answering "equal" is the fail-closed
            // side — a dimension this version cannot compare must not be the
            // reason two members get to claim they differ.
            None => true,
        })
}

fn field_of<'a>(
    fields: &'a [ListingFieldDefinition],
    key: &str,
) -> Option<&'a ListingFieldDefinition> {
    fields.iter().find(|field| field.key == key)
}

fn refusal_problem(refusal: &VariantRefusal) -> VariantProblem {
    VariantProblem {
        code: refusal.code,
        member_id: None,
        field_key: refusal.field_key.clone(),
    }
}
