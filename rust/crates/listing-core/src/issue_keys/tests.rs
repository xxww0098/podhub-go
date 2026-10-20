use super::*;

fn codes_of(stage: IssueStage) -> Vec<&'static str> {
    KnownIssueKey::ALL
        .iter()
        .filter(|key| key.platform() == IssuePlatform::Ozon && key.stage() == stage)
        .map(|key| key.code())
        .collect()
}

/// The declaration is the contract: exact per-stage code sets, in order.
/// Adding, renaming or moving a code must change this test on purpose.
#[test]
fn manifest_pins_every_stage_and_its_codes() {
    assert_eq!(
        codes_of(IssueStage::Validate),
        [
            "required",
            "max_value_count",
            "complex_single_item",
            "name_contains_han",
            "name_too_long",
            "offer_id_too_long",
            "offer_id_charset",
            "invalid_barcode",
            "invalid_price",
            "invalid_positive_integer",
            "invalid_integer",
            "invalid_decimal",
            "invalid_boolean",
            "invalid_url",
            "invalid_choice",
            "invalid_choice_cardinality",
            "invalid_dictionary_id",
            "unknown_dictionary_id",
            "dictionary_material_required",
        ]
    );
    assert_eq!(
        codes_of(IssueStage::Freeze),
        [
            "row_id_invalid",
            "schema_stale",
            "coordinate_mismatch",
            "language_mismatch",
            "ai_candidate_unresolved",
            "freeze_failed",
        ]
    );
    assert_eq!(
        codes_of(IssueStage::PreDispatch),
        [
            "OZON_STORE_PAUSED",
            "OZON_RATE_LIMITED",
            "OZON_EGRESS_UNAVAILABLE",
            "OZON_EGRESS_UNREACHABLE",
            "OZON_WRITES_DISABLED",
            "OZON_ACCESS_UNCLASSIFIED",
            "SHIPPING_NOT_READY",
        ]
    );
    assert_eq!(
        codes_of(IssueStage::Submit),
        [
            "OZON_ROW_REJECTED",
            "OZON_CREDENTIAL_INVALID",
            "OZON_PERMISSION_DENIED",
            "OZON_ACCESS_UNCLASSIFIED",
            "OZON_RATE_LIMITED",
            "OZON_DISPATCH_INTERRUPTED",
        ]
    );
    assert_eq!(
        codes_of(IssueStage::Preview),
        [
            "variant_metadata_unknown",
            "variant_model_field_absent",
            "variant_model_field_complex",
            "variant_dimension_complex",
            "variant_category_mismatch",
            "variant_brand_mismatch",
            "variant_no_distinguishing_dimension",
            "variant_combination_duplicate",
            "variant_write_member_unknown",
        ]
    );
    assert_eq!(
        KnownIssueKey::ALL
            .iter()
            .filter(|key| key.platform() == IssuePlatform::Ozon)
            .count(),
        19 + 6 + 7 + 6 + 9
    );
    assert_eq!(KnownIssueKey::ALL.len(), 65);
    assert_eq!(known_issue_manifest(), KnownIssueKey::ALL);
    assert!(
        KnownIssueKey::ALL
            .iter()
            .take(47)
            .all(|key| key.platform() == IssuePlatform::Ozon)
    );
}

/// Within one stage a code names one key; across stages the same code is two
/// distinct keys (a rate limit before dispatch is not one after it).
#[test]
fn keys_are_unique_per_stage_and_distinct_across_stages() {
    let mut seen = std::collections::BTreeSet::new();
    for key in KnownIssueKey::ALL {
        assert!(
            seen.insert((key.platform(), key.stage(), key.code())),
            "{key:?} declared twice"
        );
    }
    let before = KnownIssueKey::classify(
        IssuePlatform::Ozon,
        IssueStage::PreDispatch,
        "OZON_RATE_LIMITED",
    );
    let after =
        KnownIssueKey::classify(IssuePlatform::Ozon, IssueStage::Submit, "OZON_RATE_LIMITED");
    assert_eq!(before, Some(OzonPreDispatchCode::RateLimited.key()));
    assert_eq!(after, Some(OzonSubmitCode::RateLimited.key()));
    assert_ne!(before, after);
}

/// Every key round-trips through its wire JSON, and the JSON is the flat
/// triple the OpenAPI union documents.
#[test]
fn every_key_round_trips_through_wire_json() {
    for key in KnownIssueKey::ALL {
        let value = serde_json::to_value(key).expect("serialize");
        assert_eq!(
            value,
            serde_json::json!({
                "platform": key.platform().as_str(),
                "stage": key.stage().as_str(),
                "code": key.code(),
            })
        );
        let back: KnownIssueKey = serde_json::from_value(value).expect("deserialize");
        assert_eq!(back, *key);
        assert_eq!(
            KnownIssueKey::classify(key.platform(), key.stage(), key.code()),
            Some(*key)
        );
    }
    assert_eq!(
        serde_json::to_string(&OzonValidateCode::Required.key()).expect("serialize"),
        r#"{"platform":"ozon","stage":"validate","code":"required"}"#
    );
}

/// Unknown or mis-staged strings are unclassified, never coerced to a
/// neighbour; the closed type refuses them outright.
#[test]
fn unknown_and_mis_staged_codes_are_unclassified() {
    for (stage, code) in [
        (IssueStage::Validate, "required_v2"),
        (IssueStage::Validate, "schema_stale"),
        (IssueStage::Freeze, "required"),
        (IssueStage::PreDispatch, "OZON_ROW_REJECTED"),
        (IssueStage::Submit, "SHIPPING_NOT_READY"),
        (IssueStage::Submit, "ozon_rate_limited"),
        (IssueStage::Submit, ""),
    ] {
        assert_eq!(
            KnownIssueKey::classify(IssuePlatform::Ozon, stage, code),
            None,
            "{stage:?}/{code}"
        );
    }
    assert_eq!(IssueStage::parse("build"), None);
    assert_eq!(IssueStage::parse("PRE_DISPATCH"), None);
    assert_eq!(IssuePlatform::parse("wb"), Some(IssuePlatform::Wb));
    assert_eq!(IssuePlatform::parse("unknown"), None);
    for rejected in [
        r#"{"platform":"ozon","stage":"validate","code":"nope"}"#,
        r#"{"platform":"wb","stage":"freeze","code":"required"}"#,
        r#"{"platform":"ozon","stage":"build","code":"required"}"#,
        r#"{"platform":"ozon","stage":"validate","code":"required","extra":1}"#,
    ] {
        assert!(
            serde_json::from_str::<KnownIssueKey>(rejected).is_err(),
            "{rejected}"
        );
    }
}

#[test]
fn listing_issue_key_stage_is_part_of_the_type() {
    let paused = ListingIssueKey::PreDispatch(OzonPreDispatchCode::StorePaused);
    assert_eq!(paused.stage(), IssueStage::PreDispatch);
    assert_eq!(paused.code(), "OZON_STORE_PAUSED");
    let lost = ListingIssueKey::Submit(OzonSubmitCode::DispatchInterrupted);
    assert_eq!(lost.stage(), IssueStage::Submit);
    assert_eq!(lost.code(), "OZON_DISPATCH_INTERRUPTED");
    assert_eq!(lost.key(), OzonSubmitCode::DispatchInterrupted.key());
}
