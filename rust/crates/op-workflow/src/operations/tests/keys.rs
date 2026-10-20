use super::super::*;
use super::{Facts, evidence, recognize_input, slice_input, start_payload, upload_input};

// ── idempotency keys (§7) ──────────────────────────────────────────────

#[test]
fn same_input_produces_same_idempotency_key() {
    let facts = Facts::new();
    let facts = facts.facts();
    let first = recognize(recognize_input(&facts)).expect("start");
    let second = recognize(recognize_input(&facts)).expect("start");
    assert_eq!(
        start_payload(&first).idempotency_key,
        start_payload(&second).idempotency_key
    );

    let sliced = slice(slice_input(&facts)).expect("start");
    assert_eq!(
        start_payload(&sliced).idempotency_key,
        slice_job_key("row-1", 1, "src-sha-1", "psd-sha-1", "render-v1")
    );

    let mut upload_facts = Facts::new();
    upload_facts.render = Some(evidence());
    let upload_facts = upload_facts.facts();
    let uploaded = upload(upload_input(&upload_facts)).expect("start");
    assert_eq!(
        start_payload(&uploaded).idempotency_key,
        upload_job_key("row-1", 1, "manifest-sha-1", "account-1", "delivery-v1")
    );
}

#[test]
fn revision_change_keeps_the_same_job_key() {
    let mut facts = Facts::new();
    facts.actual_revision = 1;
    facts.expected_revision = 1;
    let facts_v1 = facts.facts();
    let key_v1 = start_payload(&recognize(recognize_input(&facts_v1)).expect("start"))
        .idempotency_key
        .clone();
    facts.actual_revision = 2;
    facts.expected_revision = 2;
    let facts_v2 = facts.facts();
    let key_v2 = start_payload(&recognize(recognize_input(&facts_v2)).expect("start"))
        .idempotency_key
        .clone();
    assert_eq!(key_v1, key_v2);
}

#[test]
fn recognize_job_key_excludes_psd_version() {
    let key = recognize_job_key("row-1", "img-sha-1", "prompt-hash-1", "recognition-v1");
    assert_eq!(
        key,
        "recognize:v2:row-1:ai:v2:img-sha-1:prompt-hash-1:recognition-v1"
    );
    assert!(!key.contains("psd") && !key.contains("render"));
}
