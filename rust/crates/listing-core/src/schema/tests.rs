use super::*;

#[test]
fn semantic_schema_revision_excludes_option_labels() {
    let fields = vec![SemanticFieldIdentity {
        key: "material".to_owned(),
        editor: ListingFieldEditor::SingleSelect,
        required: true,
        collection: false,
        max_value_count: None,
        dictionary_id: Some("44".to_owned()),
        attribute_id: Some("100".to_owned()),
        complex_id: None,
        complex_group_collection: false,
        read_only: false,
        aspect: Some(true),
        option_ids: vec!["1".to_owned(), "2".to_owned()],
        options_truncated: false,
    }];
    let a = semantic_schema_revision(1, 2, 0, 0, 0, &fields, &[]);
    let mut fields_same_ids = fields.clone();
    // option_ids only — there is no display label channel on the identity type.
    fields_same_ids[0].option_ids = vec!["1".to_owned(), "2".to_owned()];
    let b = semantic_schema_revision(1, 2, 0, 0, 0, &fields_same_ids, &[]);
    assert_eq!(a, b);

    fields_same_ids[0].option_ids = vec!["1".to_owned(), "3".to_owned()];
    let c = semantic_schema_revision(1, 2, 0, 0, 0, &fields_same_ids, &[]);
    assert_ne!(a, c);
    assert!(a.starts_with("sha256:"));
}

fn field_identity(key: &str, option_ids: &[&str]) -> SemanticFieldIdentity {
    SemanticFieldIdentity {
        key: key.to_owned(),
        editor: ListingFieldEditor::SingleSelect,
        required: false,
        collection: false,
        max_value_count: None,
        dictionary_id: None,
        attribute_id: None,
        complex_id: None,
        complex_group_collection: false,
        read_only: false,
        aspect: None,
        option_ids: option_ids.iter().map(|id| (*id).to_owned()).collect(),
        options_truncated: false,
    }
}

/// Variant semantics, not presentation: an `is_aspect` flip moves the Schema
/// Revision, and the three states stay three states. (The label channel does
/// not exist on this type at all, which is what keeps a display-name change
/// out of the revision — `bridge::tests` pins that half end to end.)
#[test]
fn semantic_schema_revision_tracks_aspect_including_unknown() {
    let baseline = semantic_schema_revision(1, 2, 0, 0, 0, &[field_identity("size", &[])], &[]);

    let mut dimension = field_identity("size", &[]);
    dimension.aspect = Some(true);
    let is_dimension = semantic_schema_revision(1, 2, 0, 0, 0, &[dimension], &[]);
    assert_ne!(baseline, is_dimension);

    let mut not_dimension = field_identity("size", &[]);
    not_dimension.aspect = Some(false);
    let is_not_dimension = semantic_schema_revision(1, 2, 0, 0, 0, &[not_dimension], &[]);
    assert_ne!(baseline, is_not_dimension);
    assert_ne!(is_dimension, is_not_dimension);

    // `None` is the unknown state, and it is not a synonym for `false`.
    assert_eq!(
        baseline,
        semantic_schema_revision(1, 2, 0, 0, 0, &[field_identity("size", &[])], &[])
    );
}

/// The format version is hashed material: material hashed before
/// `SemanticFieldIdentity` gained `aspect` can never collide with the new
/// shape, and the unknown state is written out rather than omitted (an
/// omitted key would be indistinguishable from a `skip_serializing_if`
/// mistake). Pinned as the literal, so an accidental revert fails here.
#[test]
fn schema_format_version_and_unknown_aspect_are_part_of_the_material() {
    assert_eq!(SCHEMA_FORMAT_VERSION, 2);
    let encoded = serde_json::to_value(field_identity("size", &[])).expect("identity serializes");
    assert_eq!(
        encoded.get("aspect"),
        Some(&serde_json::Value::Null),
        "aspect must be serialized even when unknown"
    );
}

#[test]
fn semantic_schema_revision_ignores_option_id_order() {
    let display = vec![
        field_identity("color", &["red", "blue"]),
        field_identity("size", &["m", "s"]),
    ];
    let reordered_options = vec![
        field_identity("color", &["blue", "red"]),
        field_identity("size", &["s", "m"]),
    ];
    let a = semantic_schema_revision(1, 2, 0, 0, 0, &display, &[]);
    let b = semantic_schema_revision(1, 2, 0, 0, 0, &reordered_options, &[]);
    assert_eq!(a, b);
    assert_eq!(
        display
            .iter()
            .map(|field| field.key.as_str())
            .collect::<Vec<_>>(),
        ["color", "size"]
    );
    assert_eq!(display[0].option_ids, ["red", "blue"]);
    assert_eq!(display[1].option_ids, ["m", "s"]);
}

#[test]
fn semantic_schema_revision_tracks_field_order() {
    let color_then_size = vec![
        field_identity("color", &["red"]),
        field_identity("size", &["m"]),
    ];
    let size_then_color = vec![
        field_identity("size", &["m"]),
        field_identity("color", &["red"]),
    ];
    assert_ne!(
        semantic_schema_revision(1, 2, 0, 0, 0, &color_then_size, &[]),
        semantic_schema_revision(1, 2, 0, 0, 0, &size_then_color, &[]),
    );
}

#[test]
fn semantic_schema_revision_tracks_complex_field_key_order() {
    let fields = vec![
        field_identity("color", &["red"]),
        field_identity("size", &["m"]),
    ];
    let color_then_size = [SemanticComplexGroupIdentity {
        complex_id: 9,
        collection: false,
        field_keys: vec!["color".to_owned(), "size".to_owned()],
    }];
    let size_then_color = [SemanticComplexGroupIdentity {
        complex_id: 9,
        collection: false,
        field_keys: vec!["size".to_owned(), "color".to_owned()],
    }];
    assert_ne!(
        semantic_schema_revision(1, 2, 0, 0, 0, &fields, &color_then_size),
        semantic_schema_revision(1, 2, 0, 0, 0, &fields, &size_then_color),
    );
}

#[test]
fn infers_editors_and_unknown_type_falls_back_to_text() {
    assert_eq!(
        infer_editor("integer", false, false, false),
        ListingFieldEditor::Integer
    );
    assert_eq!(
        infer_editor("float", false, false, false),
        ListingFieldEditor::Decimal
    );
    assert_eq!(
        infer_editor("boolean", false, false, false),
        ListingFieldEditor::Boolean
    );
    assert_eq!(
        infer_editor("string", true, false, false),
        ListingFieldEditor::Text
    );
    assert_eq!(
        infer_editor("string", false, true, false),
        ListingFieldEditor::SingleSelect
    );
    assert_eq!(
        infer_editor("future_type_v9", false, true, true),
        ListingFieldEditor::Text
    );
    assert_eq!(
        infer_editor("string", true, true, true),
        ListingFieldEditor::DictionarySearch
    );
}

#[test]
fn live_fixed_fields_mark_coordinates_read_only() {
    let fields = live_fixed_fields();
    for key in [
        "offer_id",
        "name",
        "price",
        "description_category_id",
        "type_id",
        "images",
    ] {
        assert!(fields.iter().any(|field| field.key == key));
    }
    assert!(
        fields
            .iter()
            .find(|field| field.key == "description_category_id")
            .expect("category")
            .read_only
    );
    assert!(
        fields
            .iter()
            .find(|field| field.key == "offer_id")
            .expect("offer")
            .required
    );
    assert_eq!(
        fields
            .iter()
            .find(|field| field.key == "images")
            .expect("images")
            .constraints
            .max_value_count,
        Some(15)
    );
}
