//! Stable idempotency keys and the AI cache key.
//!
//! Every key contains only UUIDs, revisions, hashes and contract versions —
//! never raw prompts, paths, credentials or Seller payloads. A repeated
//! click, an API retry and a process restart all resolve to the original Job
//! through
//! `UNIQUE (org_id, kind, idempotency_key)`.

/// AI Cache Key: image + hash(prompt) + processing contract. Deliberately **no**
/// `psd_version` — a PSD change invalidates media, never paid recognition
/// The kernel only ever sees the hashed prompt.
#[must_use]
fn ai_cache_key(
    image_sha256: &str,
    prompt_sha256: &str,
    recognition_contract_version: &str,
) -> String {
    format!(
        "ai:v2:{}:{}:{}",
        component(image_sha256),
        component(prompt_sha256),
        component(recognition_contract_version)
    )
}

/// AI Job Key = row + AI Cache Key. Revision is not in the key: a title or
/// price edit must not mint a new purchase identity.
#[must_use]
pub fn recognize_job_key(
    row_id: &str,
    image_sha256: &str,
    prompt_sha256: &str,
    recognition_contract_version: &str,
) -> String {
    format!(
        "recognize:v2:{}:{}",
        component(row_id),
        ai_cache_key(image_sha256, prompt_sha256, recognition_contract_version),
    )
}

#[must_use]
pub fn slice_job_key(
    row_id: &str,
    revision: u64,
    source_sha256: &str,
    template_sha256: &str,
    renderer_contract_version: &str,
) -> String {
    format!(
        "slice:v1:{}:{revision}:{}:{}:{}",
        component(row_id),
        component(source_sha256),
        component(template_sha256),
        component(renderer_contract_version),
    )
}

#[must_use]
pub fn upload_job_key(
    row_id: &str,
    revision: u64,
    manifest_digest: &str,
    media_account_id: &str,
    delivery_contract_version: &str,
) -> String {
    format!(
        "upload:v1:{}:{revision}:{}:{}:{}",
        component(row_id),
        component(manifest_digest),
        component(media_account_id),
        component(delivery_contract_version),
    )
}

/// Send Job Key = store + sorted (row, revision) pairs + frozen payload
/// digest. Sorting keeps the key canonical regardless of selection order, so
/// the same Store batch always resolves to the same Job.
#[must_use]
pub fn send_job_key(
    target_store_id: &str,
    rows_and_revisions: &[(String, u64)],
    payload_digest: &str,
) -> String {
    let mut rows: Vec<&(String, u64)> = rows_and_revisions.iter().collect();
    rows.sort_by(|a, b| a.0.cmp(&b.0).then(a.1.cmp(&b.1)));
    let joined = rows
        .iter()
        .map(|(row, revision)| format!("{}@{revision}", component(row)))
        .collect::<Vec<_>>()
        .join(",");
    format!(
        "send:v1:{}:{}:{}",
        component(target_store_id),
        joined,
        component(payload_digest),
    )
}

/// One key segment. The contract says segments are UUIDs / hashes / versions
/// only; the colon escape is a defensive guarantee that the `:`-separated
/// format stays unambiguous even if a legacy `sha256:`-prefixed hash arrives.
fn component(value: &str) -> String {
    value.replace(':', "_")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ai_cache_key_is_image_prompt_contract_only() {
        assert_eq!(
            ai_cache_key("img-sha", "prompt-hash", "recognition-v1"),
            "ai:v2:img-sha:prompt-hash:recognition-v1"
        );
        // A different image, prompt or processing contract changes the key...
        assert_ne!(
            ai_cache_key("img-sha", "prompt-hash", "recognition-v1"),
            ai_cache_key("img-sha", "prompt-hash", "recognition-v2")
        );
        // ...but there is no psd_version anywhere in the shape.
        let key = ai_cache_key("img-sha", "prompt-hash", "recognition-v1");
        assert!(!key.contains("psd") && !key.contains("template"));
    }

    #[test]
    fn recognize_job_key_excludes_revision() {
        let key = recognize_job_key("row-1", "img-sha", "prompt-hash", "recognition-v1");
        assert_eq!(
            key,
            "recognize:v2:row-1:ai:v2:img-sha:prompt-hash:recognition-v1"
        );
        assert_eq!(
            key,
            recognize_job_key("row-1", "img-sha", "prompt-hash", "recognition-v1")
        );
    }

    #[test]
    fn a_production_recognize_job_key_fits_the_ai_relay_bound() {
        let key = recognize_job_key(
            "550e8400-e29b-41d4-a716-446655440000",
            &"a".repeat(64),
            &"b".repeat(64),
            "cloud-ai-relay",
        );
        assert!(
            key.len() <= 512,
            "AI relay Idempotency-Key / jobs HTTP ceiling is 512 B; got {} B",
            key.len()
        );
    }

    #[test]
    fn send_job_key_is_canonical_under_row_order() {
        let rows = vec![
            ("row-b".to_owned(), 2),
            ("row-a".to_owned(), 1),
            ("row-a".to_owned(), 1),
        ];
        let key = send_job_key("store-1", &rows, "digest");
        assert_eq!(key, "send:v1:store-1:row-a@1,row-a@1,row-b@2:digest");
        // A different selection order yields the identical key.
        let shuffled = vec![
            ("row-a".to_owned(), 1),
            ("row-b".to_owned(), 2),
            ("row-a".to_owned(), 1),
        ];
        assert_eq!(key, send_job_key("store-1", &shuffled, "digest"));
    }

    #[test]
    fn colon_prefixed_hashes_are_escaped() {
        assert_eq!(
            recognize_job_key("row-1", "sha256:abc", "prompt-hash", "recognition-v1"),
            "recognize:v2:row-1:ai:v2:sha256_abc:prompt-hash:recognition-v1"
        );
    }
}
