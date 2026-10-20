use super::tests::field;
use super::*;

#[test]
fn wb_native_field_families_reject_unknown_blank_type_count_and_nonfinite() {
    let fields = vec![field(7, 1, true), field(8, 4, false)];
    for (id, value, code) in [
        (99, FieldValue::Number(1.0), "unknown_characteristic"),
        (7, FieldValue::Text(vec![]), "blank_text"),
        (7, FieldValue::Text(vec!["\u{2003}".into()]), "blank_text"),
        (
            7,
            FieldValue::Text(vec!["a".into(), "b".into()]),
            "max_count",
        ),
        (7, FieldValue::Number(1.0), "value_type"),
        (8, FieldValue::Text(vec!["1".into()]), "value_type"),
        (8, FieldValue::Number(f64::NAN), "nonfinite_number"),
        (8, FieldValue::Number(f64::NEG_INFINITY), "nonfinite_number"),
    ] {
        let issues = validate_fields(&fields, &Fields::from([(id, value)]), false);
        assert_eq!(issues.len(), 1);
        assert_eq!(issues[0].key.code(), code);
        assert_eq!(issues[0].characteristic_id, Some(id));
    }
    assert!(
        validate_fields(
            &fields,
            &Fields::from([(8, FieldValue::Number(-0.5))]),
            false
        )
        .is_empty()
    );
}

#[test]
fn wb_partial_defaults_and_complete_required_checks_share_rules() {
    let mut field = field(7, 1, false);
    field.required_for_create = Some(true);
    field.max_count = 0;
    assert!(validate_fields(&[field.clone()], &Fields::new(), false).is_empty());
    assert_eq!(
        validate_fields(&[field.clone()], &Fields::new(), true)[0]
            .key
            .code(),
        "required"
    );
    assert!(
        validate_fields(
            &[field],
            &Fields::from([(7, FieldValue::Text(vec!["a".into(); 5]))]),
            true
        )
        .is_empty()
    );
}

#[test]
fn wb_text_is_an_array_and_numeric_ids_never_import_ozon_semantics() {
    assert!(serde_json::from_str::<Fields>(r#"{"7":"scalar"}"#).is_err());
    assert!(serde_json::from_str::<Fields>(r#"{"7":[1]}"#).is_err());
    let fields = [field(crate::SEARCH_TAGS_ATTRIBUTE_ID, 4, true)];
    let values = Fields::from([(crate::SEARCH_TAGS_ATTRIBUTE_ID, FieldValue::Number(42.0))]);
    assert!(validate_fields(&fields, &values, true).is_empty());
    assert!(
        validate_fields(
            &fields,
            &Fields::from([(
                crate::SEARCH_TAGS_ATTRIBUTE_ID,
                FieldValue::Text(vec!["tag".into()])
            )]),
            true
        )
        .iter()
        .any(|i| i.key.code() == "value_type")
    );
}
