//! Rule-level evidence for the variant module.
//!
//! The Ozon ids below exist **only here**: the module resolves dimensions from
//! `is_aspect` and the one model attribute, never from a remembered size or
//! colour id. `a_synthetic_category_with_other_ids_resolves_the_same_way` is
//! what holds that claim down.

use std::collections::BTreeMap;

use super::*;
use crate::records::{ListingFieldConstraints, ListingFieldDefinition, ListingFieldEditor};
use crate::{WorkflowDraftSelection, WorkflowDraftValue};

const CATEGORY: i64 = 17_028_964;
const TYPE: i64 = 94_897;
const SIZE_ATTRIBUTE_ID: i64 = 4382;
const COLOUR_ATTRIBUTE_ID: i64 = 10_096;
const LENGTH_ATTRIBUTE_ID: i64 = 8779;
const LENGTH_SECOND_ATTRIBUTE_ID: i64 = 8780;
const BRAND_BRANDLESS_ID: &str = "126745801";

fn field(
    key: &str,
    attribute_id: i64,
    aspect: Option<bool>,
    editor: ListingFieldEditor,
    dictionary_id: Option<i64>,
) -> ListingFieldDefinition {
    ListingFieldDefinition {
        key: key.to_owned(),
        label: key.to_owned(),
        group: "属性".to_owned(),
        editor,
        attribute_id: Some(attribute_id.to_string()),
        constraints: ListingFieldConstraints {
            dictionary_id: dictionary_id.map(|id| id.to_string()),
            ..ListingFieldConstraints::default()
        },
        aspect,
        ..ListingFieldDefinition::default()
    }
}

fn text(key: &str, attribute_id: i64, aspect: Option<bool>) -> ListingFieldDefinition {
    field(key, attribute_id, aspect, ListingFieldEditor::Text, None)
}

fn choice(
    key: &str,
    attribute_id: i64,
    aspect: Option<bool>,
    dictionary_id: i64,
) -> ListingFieldDefinition {
    field(
        key,
        attribute_id,
        aspect,
        ListingFieldEditor::SingleSelect,
        Some(dictionary_id),
    )
}

/// `17028964 / 94897` — the coordinate the spec read back from a real Seller.
/// Size `4382` and colour `10096` are the aspects; length `8779` / `8780` are
/// not. The model field is plain `9048`.
fn real_category() -> Vec<ListingFieldDefinition> {
    vec![
        choice("attribute_85", BRAND_ATTRIBUTE_ID, Some(false), 28_732_849),
        text("attribute_9048", MODEL_ATTRIBUTE_ID, Some(false)),
        choice("attribute_4382", SIZE_ATTRIBUTE_ID, Some(true), 1_001),
        choice("attribute_10096", COLOUR_ATTRIBUTE_ID, Some(true), 1_002),
        text("attribute_8779", LENGTH_ATTRIBUTE_ID, Some(false)),
        text("attribute_8780", LENGTH_SECOND_ATTRIBUTE_ID, Some(false)),
    ]
}

/// The spec's category with the aspect metadata stripped, exactly how a
/// payload written before this change decodes.
fn old_material() -> Vec<ListingFieldDefinition> {
    real_category()
        .into_iter()
        .map(|mut field| {
            field.aspect = None;
            field
        })
        .collect()
}

fn identity(brand: DimensionValue) -> GroupIdentity {
    GroupIdentity {
        description_category_id: CATEGORY,
        type_id: TYPE,
        brand,
    }
}

fn member(member_id: &str, values: &[(&str, DimensionValue)]) -> VariantMember {
    VariantMember {
        member_id: member_id.to_owned(),
        identity: identity(DimensionValue::Dictionary(vec![
            BRAND_BRANDLESS_ID.to_owned(),
        ])),
        values: values
            .iter()
            .map(|(key, value)| ((*key).to_owned(), value.clone()))
            .collect(),
    }
}

fn ids(ids: &[&str]) -> DimensionValue {
    DimensionValue::Dictionary(ids.iter().map(|id| (*id).to_owned()).collect())
}

/// A complete group: every member is what the write sends.
fn group(members: Vec<VariantMember>) -> GroupWrite {
    GroupWrite {
        write_member_ids: members.iter().map(|m| m.member_id.clone()).collect(),
        members,
    }
}

fn codes(problems: &[VariantProblem]) -> Vec<&'static str> {
    problems.iter().map(|problem| problem.code.code()).collect()
}

#[test]
fn the_verified_real_category_resolves_its_aspect_dimensions() {
    let dimensions = resolve_variant_rule(&real_category())
        .known()
        .cloned()
        .expect("the verified category is supported");
    assert_eq!(dimensions.model_field_key, "attribute_9048");
    assert_eq!(
        dimensions.dimension_keys,
        ["attribute_4382", "attribute_10096"]
    );
}

/// The same shape with other numbers: nothing in the module may remember
/// `4382` or `10096`, and the model field is found by attribute id even when
/// the category gives it an unrelated key.
#[test]
fn a_synthetic_category_with_other_ids_resolves_the_same_way() {
    let fields = vec![
        text("model", MODEL_ATTRIBUTE_ID, Some(false)),
        choice("first", 111_111, Some(true), 7_001),
        choice("second", 222_222, Some(true), 7_002),
        text("third", 333_333, Some(false)),
    ];
    let dimensions = resolve_variant_rule(&fields)
        .known()
        .cloned()
        .expect("supported");
    assert_eq!(dimensions.model_field_key, "model");
    assert_eq!(dimensions.dimension_keys, ["first", "second"]);
}

#[test]
fn two_real_dimension_combinations_pass() {
    let problems = validate_group(
        &real_category(),
        &group(vec![
            member(
                "offer-a",
                &[
                    ("attribute_4382", ids(&["10"])),
                    ("attribute_10096", ids(&["20"])),
                ],
            ),
            member(
                "offer-b",
                &[
                    ("attribute_4382", ids(&["11"])),
                    ("attribute_10096", ids(&["20"])),
                ],
            ),
        ]),
    );
    assert!(problems.is_empty(), "{problems:?}");
}

#[test]
fn a_duplicate_complete_combination_is_refused_and_names_the_later_member() {
    let problems = validate_group(
        &real_category(),
        &group(vec![
            member(
                "offer-a",
                &[
                    ("attribute_4382", ids(&["10"])),
                    ("attribute_10096", ids(&["20"])),
                ],
            ),
            member(
                "offer-b",
                &[
                    ("attribute_4382", ids(&["10"])),
                    ("attribute_10096", ids(&["20"])),
                ],
            ),
        ]),
    );
    assert_eq!(codes(&problems), ["variant_combination_duplicate"]);
    assert_eq!(problems[0].member_id.as_deref(), Some("offer-b"));
}

#[test]
fn a_category_without_any_dimension_cannot_hold_two_members() {
    let fields = vec![
        text("attribute_9048", MODEL_ATTRIBUTE_ID, Some(false)),
        text("attribute_8779", LENGTH_ATTRIBUTE_ID, Some(false)),
    ];
    let members = vec![
        member(
            "offer-a",
            &[(
                "attribute_8779",
                DimensionValue::Scalars(vec!["10".to_owned()]),
            )],
        ),
        member(
            "offer-b",
            &[(
                "attribute_8779",
                DimensionValue::Scalars(vec!["20".to_owned()]),
            )],
        ),
    ];
    let problems = validate_group(&fields, &group(members.clone()));
    assert_eq!(codes(&problems), ["variant_no_distinguishing_dimension"]);
    assert_eq!(problems[0].member_id, None);
    // One member is not a group yet — and it must not be refused merely for
    // being one. (A write naming a member the group no longer holds is a
    // different problem, so the subset shrinks with it.)
    let mut single = group(members);
    single.members.truncate(1);
    single.write_member_ids.truncate(1);
    assert!(validate_group(&fields, &single).is_empty());
}

#[test]
fn members_of_another_category_type_or_brand_are_refused() {
    let mut other_category = member("offer-b", &[("attribute_4382", ids(&["11"]))]);
    other_category.identity.description_category_id = CATEGORY + 1;
    let mut other_brand = member("offer-c", &[("attribute_4382", ids(&["12"]))]);
    other_brand.identity.brand = ids(&["999"]);
    let mut other_type = member("offer-d", &[("attribute_4382", ids(&["13"]))]);
    other_type.identity.type_id = TYPE + 1;
    let problems = validate_group(
        &real_category(),
        &group(vec![
            member("offer-a", &[("attribute_4382", ids(&["10"]))]),
            other_category,
            other_brand,
            other_type,
        ]),
    );
    assert_eq!(
        codes(&problems),
        [
            "variant_category_mismatch",
            "variant_brand_mismatch",
            "variant_category_mismatch"
        ]
    );
    // The brand problem names the field the material carries the brand in.
    assert_eq!(problems[1].field_key.as_deref(), Some("attribute_85"));
    assert_eq!(problems[1].member_id.as_deref(), Some("offer-c"));
}

#[test]
fn material_without_aspect_metadata_asks_for_a_refresh_not_for_no_dimensions() {
    assert!(!carries_aspect_metadata(&old_material()));
    assert!(carries_aspect_metadata(&real_category()));
    let problems = validate_group(&old_material(), &group(vec![member("offer-a", &[])]));
    assert_eq!(codes(&problems), ["variant_metadata_unknown"]);
    assert_eq!(problems[0].member_id, None);
    // The refusal is about the rule, not about the members: an empty group
    // is refused too, because nothing may be sent under an unknown rule.
    assert_eq!(
        codes(&validate_group(&old_material(), &group(Vec::new()))),
        ["variant_metadata_unknown"]
    );
}

#[test]
fn a_fixed_listing_field_never_counts_as_unknown_metadata() {
    let mut fields = real_category();
    fields.push(ListingFieldDefinition {
        key: "offer_id".to_owned(),
        label: "Offer ID".to_owned(),
        group: "Fixed".to_owned(),
        editor: ListingFieldEditor::Text,
        required: true,
        ..ListingFieldDefinition::default()
    });
    assert!(carries_aspect_metadata(&fields));
    assert!(resolve_variant_rule(&fields).known().is_some());
}

#[test]
fn an_absent_or_complex_model_field_is_unsupported_not_silently_accepted() {
    let absent = vec![choice(
        "attribute_4382",
        SIZE_ATTRIBUTE_ID,
        Some(true),
        1_001,
    )];
    let problems = validate_group(&absent, &group(vec![member("offer-a", &[])]));
    assert_eq!(codes(&problems), ["variant_model_field_absent"]);
    assert_eq!(problems[0].member_id, None);

    let mut complex = text("attribute_9048", MODEL_ATTRIBUTE_ID, Some(false));
    complex.complex_id = Some("12".to_owned());
    let fields = vec![
        complex,
        choice("attribute_4382", SIZE_ATTRIBUTE_ID, Some(true), 1_001),
    ];
    assert_eq!(
        codes(&validate_group(
            &fields,
            &group(vec![member("offer-a", &[])])
        )),
        ["variant_model_field_complex"]
    );
}

#[test]
fn a_complex_aspect_is_refused_rather_than_dropped() {
    let mut dimension = choice("attribute_4382", SIZE_ATTRIBUTE_ID, Some(true), 1_001);
    dimension.complex_id = Some("12".to_owned());
    let fields = vec![
        text("attribute_9048", MODEL_ATTRIBUTE_ID, Some(false)),
        dimension,
    ];
    let problems = validate_group(&fields, &group(vec![member("offer-a", &[])]));
    assert_eq!(codes(&problems), ["variant_dimension_complex"]);
    assert_eq!(problems[0].field_key.as_deref(), Some("attribute_4382"));
}

#[test]
fn a_write_naming_a_member_outside_the_group_is_refused() {
    let mut write = group(vec![member("offer-a", &[("attribute_4382", ids(&["10"]))])]);
    write.write_member_ids = vec!["offer-a".to_owned(), "offer-z".to_owned()];
    let problems = validate_group(&real_category(), &write);
    assert_eq!(codes(&problems), ["variant_write_member_unknown"]);
    assert_eq!(problems[0].member_id.as_deref(), Some("offer-z"));
}

#[test]
fn a_subset_write_is_judged_against_the_whole_group() {
    let members = vec![
        member("offer-a", &[("attribute_4382", ids(&["10"]))]),
        member("offer-b", &[("attribute_4382", ids(&["11"]))]),
        member("offer-c", &[("attribute_4382", ids(&["12"]))]),
    ];
    let mut subset = group(members.clone());
    subset.write_member_ids = vec!["offer-b".to_owned()];
    assert!(validate_group(&real_category(), &subset).is_empty());
    // The same subset naming only one member of a colliding pair is still
    // refused: the verdict belongs to the complete group.
    let mut colliding = group(vec![members[0].clone(), members[1].clone()]);
    colliding.members[1]
        .values
        .insert("attribute_4382".to_owned(), ids(&["10"]));
    colliding.write_member_ids = vec!["offer-b".to_owned()];
    assert_eq!(
        codes(&validate_group(&real_category(), &colliding)),
        ["variant_combination_duplicate"]
    );
}

#[test]
fn dictionary_identity_is_the_confirmed_value_id_not_the_translation() {
    let fields = real_category();
    let colour = fields
        .iter()
        .find(|field| field.key == "attribute_10096")
        .expect("colour field");
    let blue = dimension_value(
        colour,
        Some(&WorkflowDraftValue::SingleSelect(WorkflowDraftSelection {
            dictionary_value_id: 20,
            value: "蓝色".to_owned(),
        })),
    );
    let blue_ru = dimension_value(
        colour,
        Some(&WorkflowDraftValue::SingleSelect(WorkflowDraftSelection {
            dictionary_value_id: 20,
            value: "Синий".to_owned(),
        })),
    );
    assert_eq!(blue, blue_ru);
    let problems = validate_group(
        &fields,
        &group(vec![
            member("offer-a", &[("attribute_10096", blue)]),
            member("offer-b", &[("attribute_10096", blue_ru)]),
        ]),
    );
    assert_eq!(codes(&problems), ["variant_combination_duplicate"]);
}

#[test]
fn a_multi_value_dimension_compares_as_a_set() {
    let mut fields = real_category();
    fields.push(field(
        "attribute_5000",
        5_000,
        Some(true),
        ListingFieldEditor::MultiSelect,
        Some(1_003),
    ));
    let problems = validate_group(
        &fields,
        &group(vec![
            member("offer-a", &[("attribute_5000", ids(&["1", "2", "3"]))]),
            member("offer-b", &[("attribute_5000", ids(&["3", "1", "2"]))]),
        ]),
    );
    assert_eq!(codes(&problems), ["variant_combination_duplicate"]);
    let distinct = validate_group(
        &fields,
        &group(vec![
            member("offer-a", &[("attribute_5000", ids(&["1", "2"]))]),
            member("offer-b", &[("attribute_5000", ids(&["2", "1", "9"]))]),
        ]),
    );
    assert!(distinct.is_empty(), "{distinct:?}");
}

#[test]
fn an_unfilled_optional_dimension_participates_in_the_comparison() {
    // One member fills size, the other does not: they differ.
    let distinct = validate_group(
        &real_category(),
        &group(vec![
            member("offer-a", &[("attribute_4382", ids(&["10"]))]),
            member("offer-b", &[]),
        ]),
    );
    assert!(distinct.is_empty(), "{distinct:?}");
    // Both leave it empty: they do not differ.
    let same = validate_group(
        &real_category(),
        &group(vec![member("offer-a", &[]), member("offer-b", &[])]),
    );
    assert_eq!(codes(&same), ["variant_combination_duplicate"]);
}

#[test]
fn draft_values_normalise_to_the_dimension_vocabulary() {
    let fields = real_category();
    let dimensions = resolve_variant_rule(&fields)
        .known()
        .cloned()
        .expect("supported");
    let mut values = BTreeMap::new();
    values.insert(
        "attribute_4382".to_owned(),
        WorkflowDraftValue::SingleSelect(WorkflowDraftSelection {
            dictionary_value_id: 10,
            value: "40x50".to_owned(),
        }),
    );
    values.insert(
        "attribute_10096".to_owned(),
        WorkflowDraftValue::Text("   ".to_owned()),
    );
    let normalised = dimension_values(&fields, &dimensions.dimension_keys, &values);
    assert_eq!(normalised["attribute_4382"], ids(&["10"]));
    assert_eq!(normalised["attribute_10096"], DimensionValue::Missing);
}
