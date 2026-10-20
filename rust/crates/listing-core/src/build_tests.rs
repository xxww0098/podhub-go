use std::collections::BTreeSet;

use super::*;
use crate::compose::compose_tests::{golden_card, golden_row, public_ready_image};
use crate::records::FieldValueOrigin;

fn origin(key: &str, kind: FieldValueOriginKind) -> FieldValueOrigin {
    FieldValueOrigin {
        address: plain(key),
        kind,
        source_ref: None,
        updated_at_ms: 1,
    }
}

/// One row, every layer: each built address names the source that produced it.
#[test]
fn every_built_field_names_the_layer_that_produced_it() {
    let row = row_with_every_layer();
    let built = build_listing(&row, &golden_card());

    let cases = [
        ("price", FieldLayer::DatabaseDefault),
        ("description", FieldLayer::Instance),
        ("brand", FieldLayer::UserCustom),
        ("name", FieldLayer::Ocr),
        ("offer_id", FieldLayer::SourceFile),
        ("images", FieldLayer::Renderer),
        ("images360", FieldLayer::Renderer),
        ("primary_image", FieldLayer::Renderer),
        ("color_image", FieldLayer::Renderer),
    ];
    for (key, layer) in cases {
        assert_eq!(built.source_of(&plain(key)), Some(layer), "{key}");
    }
    assert_eq!(
        built.draft.values.get("brand"),
        Some(&WorkflowDraftValue::Text("RowBrand".to_owned()))
    );
    assert_eq!(
        built.draft.values.get("offer_id"),
        Some(&WorkflowDraftValue::Text("ART-001".to_owned()))
    );
}

/// Later layers only fill: an operator value and an operator clear both stop
/// the filename and renderer layers.
#[test]
fn filling_layers_never_replace_what_an_earlier_layer_set_or_cleared() {
    let mut row = golden_row();
    row.draft.values.insert(
        "offer_id".to_owned(),
        WorkflowDraftValue::Text("MANUAL-1".to_owned()),
    );
    row.draft.cleared.insert("color_image".to_owned());
    row.field_origins = vec![origin("offer_id", FieldValueOriginKind::Manual)];

    let built = build_listing(&row, &golden_card());

    assert_eq!(
        built.draft.values.get("offer_id"),
        Some(&WorkflowDraftValue::Text("MANUAL-1".to_owned()))
    );
    assert_eq!(
        built.source_of(&plain("offer_id")),
        Some(FieldLayer::UserCustom)
    );
    assert!(!built.draft.values.contains_key("color_image"));
    assert!(built.media.color_image.is_none());
    assert_eq!(
        built.source_of(&plain("color_image")),
        Some(FieldLayer::UserCustom)
    );
}

/// Seller contract defaults fill only what no source set and nobody cleared;
/// currency is never guessed.
#[test]
fn system_defaults_fill_blanks_but_never_a_clear_or_the_currency() {
    let mut card = golden_card();
    for key in ["vat", "dimension_unit", "weight_unit", "currency_code"] {
        card.defaults.values.remove(key);
    }
    card.defaults.cleared.insert("weight_unit".to_owned());

    let built = build_listing(&golden_row(), &card);

    for (key, value) in [("vat", "0"), ("dimension_unit", "mm")] {
        assert_eq!(
            built.draft.values.get(key),
            Some(&WorkflowDraftValue::Text(value.to_owned()))
        );
        assert_eq!(
            built.source_of(&plain(key)),
            Some(FieldLayer::SystemDefault)
        );
    }
    assert!(!built.draft.values.contains_key("weight_unit"));
    assert!(!built.draft.values.contains_key("currency_code"));
}

/// A card value the row never touched is the card's, even when a stale copy
/// sits on the instance.
#[test]
fn a_stale_instance_copy_of_a_card_default_stays_attributed_to_the_card() {
    let mut row = golden_row();
    row.draft
        .values
        .insert("price".to_owned(), WorkflowDraftValue::Text("1".to_owned()));

    let built = build_listing(&row, &golden_card());

    assert_eq!(
        built.draft.values.get("price"),
        Some(&WorkflowDraftValue::Text("90".to_owned()))
    );
    assert_eq!(
        built.source_of(&plain("price")),
        Some(FieldLayer::DatabaseDefault)
    );
}

/// Same inputs, same evidence. Prints the golden row's evidence JSON.
#[test]
fn digest_is_stable_across_equal_builds() {
    let row = golden_row();
    let card = golden_card();
    let first = build_listing(&row, &card).evidence(&card);
    let second = build_listing(&golden_row(), &golden_card()).evidence(&golden_card());
    assert_eq!(first, second);

    let mut ignored = row.clone();
    ignored.source.sha256 = "sha256:not-read-by-build".to_owned();
    assert_eq!(
        build_listing(&ignored, &card).evidence(&card).digest,
        first.digest,
        "row fields the build does not read stay out of the digest"
    );
    println!("{}", serde_json::to_string(&first).expect("evidence json"));
}

/// Last-writer source order and JSON object key order are not part of the digest.
#[test]
fn digest_ignores_source_order_and_json_key_order() {
    let card = golden_card();
    let built = build_listing(&golden_row(), &card);
    assert!(built.sources.len() > 1, "need two sources to reorder");
    let mut reversed = built.clone();
    reversed.sources.reverse();
    assert_ne!(reversed.sources, built.sources);

    let forward = built.evidence(&card);
    let backward = reversed.evidence(&card);
    assert_eq!(forward.digest, backward.digest);
    assert_eq!(forward.sources, backward.sources);
    assert!(
        forward
            .sources
            .windows(2)
            .all(|pair| pair[0].0 <= pair[1].0)
    );

    let row_value = golden_row().to_value().expect("row json");
    let card_value = card.to_value().expect("card json");
    let row_text = json_text(&row_value, false);
    let row_reordered = json_text(&row_value, true);
    let card_text = json_text(&card_value, false);
    let card_reordered = json_text(&card_value, true);
    assert_ne!(row_text, row_reordered);
    assert_ne!(card_text, card_reordered);
    assert_eq!(parse_row(&row_text), parse_row(&row_reordered));
    assert_eq!(parse_card(&card_text), parse_card(&card_reordered));
    assert_eq!(
        build_listing(&parse_row(&row_text), &parse_card(&card_text))
            .evidence(&parse_card(&card_text))
            .digest,
        build_listing(&parse_row(&row_reordered), &parse_card(&card_reordered))
            .evidence(&parse_card(&card_reordered))
            .digest
    );
}

/// One change per layer input moves the digest.
#[test]
fn digest_changes_when_any_layer_input_changes() {
    let row = row_with_every_layer();
    let card = golden_card();
    let base = build_listing(&row, &card).evidence(&card).digest;

    let mut card_default = card.clone();
    card_default.defaults.values.insert(
        "price".to_owned(),
        WorkflowDraftValue::Text("91".to_owned()),
    );
    assert_ne!(
        build_listing(&row, &card_default)
            .evidence(&card_default)
            .digest,
        base,
        "card default"
    );

    let mut hand = row.clone();
    hand.draft.values.insert(
        "brand".to_owned(),
        WorkflowDraftValue::Text("HandBrand".to_owned()),
    );
    assert_ne!(
        build_listing(&hand, &card).evidence(&card).digest,
        base,
        "hand edit"
    );

    let mut ocr = row.clone();
    ocr.draft.values.insert(
        "name".to_owned(),
        WorkflowDraftValue::Text("Ocr Name".to_owned()),
    );
    assert_ne!(
        build_listing(&ocr, &card).evidence(&card).digest,
        base,
        "ocr origin"
    );

    let mut file = row.clone();
    file.source.file_name = "OTHER.psd".to_owned();
    assert_ne!(
        build_listing(&file, &card).evidence(&card).digest,
        base,
        "file name"
    );

    let mut slice = row.clone();
    slice.media.images[0].public_url =
        Some("https://media.example.invalid/other-slice.jpg".to_owned());
    assert_ne!(
        build_listing(&slice, &card).evidence(&card).digest,
        base,
        "renderer slice"
    );
}

/// The card digest is the defaults the build reads, not the row and not the rest of the card.
#[test]
fn card_defaults_digest_ignores_row_side_inputs() {
    let card = golden_card();
    let row = golden_row();
    let digest = card_defaults_digest(&card);
    assert_eq!(
        build_listing(&row, &card)
            .evidence(&card)
            .card_defaults_digest,
        digest
    );

    let mut other_row = row.clone();
    other_row.source.file_name = "nope.psd".to_owned();
    other_row.draft.values.insert(
        "name".to_owned(),
        WorkflowDraftValue::Text("Other".to_owned()),
    );
    other_row.hand_edited_keys.insert("name".to_owned());
    assert_eq!(
        build_listing(&other_row, &card)
            .evidence(&card)
            .card_defaults_digest,
        digest
    );

    let mut other_card = card.clone();
    other_card.ai_prompt_id = "prompt-other".to_owned();
    other_card.ai_prompt_sha256 = "sha256:other".to_owned();
    other_card.psd_template_sha256 = "sha256:tpl-other".to_owned();
    other_card.queue.paused = true;
    assert_eq!(card_defaults_digest(&other_card), digest);

    let mut changed = card.clone();
    changed
        .defaults
        .values
        .insert("price".to_owned(), WorkflowDraftValue::Text("1".to_owned()));
    assert_ne!(card_defaults_digest(&changed), digest);
}

/// Lean storage strips `schemaSnapshot` and keeps `schemaRevision` (see
/// `schema_revisions::lean_write`). Core does not call the kernel or a
/// database: the snapshot the hydrated row already carries is put back on
/// the build input, the way `hydrate_payload` would, and is not hashed.
#[test]
fn lean_and_hydrated_payload_build_the_same_digest() {
    let card = golden_card();
    let hydrated = golden_row().to_value().expect("hydrated json");
    let mut lean = hydrated.clone();
    let snapshot = lean
        .as_object_mut()
        .expect("object")
        .remove("schemaSnapshot")
        .expect("hydrated row carries schemaSnapshot");
    assert!(lean.get("schemaSnapshot").is_none());
    assert!(lean.get("schemaRevision").is_some());
    assert_ne!(hydrated.to_string(), lean.to_string());
    assert!(
        RowPayload::from_value(&lean).is_err(),
        "a lean row has no snapshot until hydrate puts one back"
    );

    let mut normalized = lean;
    normalized
        .as_object_mut()
        .expect("object")
        .insert("schemaSnapshot".to_owned(), snapshot);

    let hydrated_row = RowPayload::from_value(&hydrated).expect("hydrated row");
    let lean_row = RowPayload::from_value(&normalized).expect("normalized lean row");
    let hydrated_built = build_listing(&hydrated_row, &card);
    let lean_built = build_listing(&lean_row, &card);
    assert_eq!(hydrated_built, lean_built);
    assert_eq!(
        hydrated_built.evidence(&card).digest,
        lean_built.evidence(&card).digest
    );

    let mut relabeled = hydrated_row.clone();
    std::sync::Arc::make_mut(&mut relabeled.schema_snapshot)
        .label
        .push_str("-drift");
    assert_ne!(relabeled.schema_snapshot, hydrated_row.schema_snapshot);
    let relabeled_built = build_listing(&relabeled, &card);
    assert_eq!(relabeled_built.draft, hydrated_built.draft);
    assert_eq!(relabeled_built.media, hydrated_built.media);
    assert_eq!(relabeled_built.sources, hydrated_built.sources);
    assert_eq!(
        relabeled_built.evidence(&card).digest,
        hydrated_built.evidence(&card).digest,
        "schema bytes that do not change the build are not in the digest"
    );
}

fn row_with_every_layer() -> RowPayload {
    let mut row = golden_row();
    row.draft.values.remove("offer_id");
    row.draft.values.insert(
        "brand".to_owned(),
        WorkflowDraftValue::Text("RowBrand".to_owned()),
    );
    row.hand_edited_keys = BTreeSet::from(["brand".to_owned()]);
    row.field_origins = vec![
        origin("name", FieldValueOriginKind::AiConfirmed),
        origin("brand", FieldValueOriginKind::Manual),
    ];
    row.media.images.push(public_ready_image(
        1,
        "https://media.example.invalid/360.jpg",
        "images360",
    ));
    row
}

fn parse_row(text: &str) -> RowPayload {
    let value = serde_json::from_str(text).expect("row json");
    RowPayload::from_value(&value).expect("row")
}

fn parse_card(text: &str) -> CardPayload {
    let value = serde_json::from_str(text).expect("card json");
    CardPayload::from_value(&value).expect("card")
}

/// Emit JSON with object keys forwards or reversed. Array order stays put.
fn json_text(value: &serde_json::Value, reverse_keys: bool) -> String {
    match value {
        serde_json::Value::Object(map) => {
            let mut keys: Vec<&String> = map.keys().collect();
            if reverse_keys {
                keys.reverse();
            }
            let mut out = String::from('{');
            for (index, key) in keys.into_iter().enumerate() {
                if index > 0 {
                    out.push(',');
                }
                out.push_str(&serde_json::to_string(key).expect("key"));
                out.push(':');
                out.push_str(&json_text(&map[key], reverse_keys));
            }
            out.push('}');
            out
        }
        serde_json::Value::Array(items) => {
            let mut out = String::from('[');
            for (index, item) in items.iter().enumerate() {
                if index > 0 {
                    out.push(',');
                }
                out.push_str(&json_text(item, reverse_keys));
            }
            out.push(']');
            out
        }
        other => serde_json::to_string(other).expect("json"),
    }
}
