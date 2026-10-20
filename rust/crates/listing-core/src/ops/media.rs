//! Validate a render manifest and mint its durable digest (called from
//! `src/listing/api/media.rs`'s `apply_complete_row_media` rendered branch).
//!
//! A confirmed upload receipt does not get its own op here: once every image
//! is confirmed, recomputing the row's verdict is exactly
//! [`super::revalidate`], so `record_upload` is covered by composition, not a
//! bespoke function — the
//! per-image lease admission and object-key verification stay in
//! `src/media/` (single owner table: "上传授权、对象键、保留期、批次令牌校验").

use sha2::{Digest, Sha256};

use serde_json::{Value as JsonValue, json};

use crate::{WorkflowImageLifecycle, WorkflowImagePhase};

/// The renderer's own manifest plus the ordered slice deliverables it
/// produced — the two things a render completion carries in from Cloud's
/// `CompleteListingRowMediaRequest`.
pub struct RenderManifest {
    pub images: Vec<WorkflowImageLifecycle>,
    pub renderer_manifest: JsonValue,
}

/// The validated, digested record a caller writes back onto the row's
/// `media.images` and `renderEvidence`.
#[derive(Debug)]
pub struct RenderRecord {
    pub images: Vec<WorkflowImageLifecycle>,
    pub manifest: JsonValue,
    pub manifest_digest: String,
}

pub fn record_render(input: RenderManifest) -> Result<RenderRecord, &'static str> {
    let RenderManifest {
        images,
        renderer_manifest,
    } = input;
    if images.is_empty()
        || images.iter().enumerate().any(|(index, image)| {
            image.index != index as u32
                || image.width == 0
                || image.height == 0
                || image.file_name.is_empty()
                || image.group_name.is_empty()
                || !valid_digest(&image.content_hash)
                || image.phase != WorkflowImagePhase::Rendered
                || image.public_url.is_some()
                || image.object_key.is_some()
        })
    {
        return Err("切片必须有固定顺序、尺寸和摘要，且尚未上传");
    }
    if !renderer_manifest.is_object() {
        return Err("缺少完整渲染清单");
    }
    if !renderer_slices_match_images(&renderer_manifest, &images) {
        return Err("切片清单与渲染器组序不一致");
    }
    // Digest the complete renderer output AND the ordered deliverable
    // metadata. Serde's serialization supplies one canonical ordering for
    // the durable key.
    let manifest = json!({"renderer": renderer_manifest, "images": images});
    let manifest_digest = format!("manifest:sha256:{}", sha256_hex(&manifest.to_string()));
    Ok(RenderRecord {
        images,
        manifest,
        manifest_digest,
    })
}

fn sha256_hex(input: &str) -> String {
    let digest = Sha256::digest(input.as_bytes());
    let mut hex = String::with_capacity(64);
    use std::fmt::Write;
    for byte in digest {
        let _ = write!(hex, "{byte:02x}");
    }
    hex
}

fn valid_digest(hash: &str) -> bool {
    let value = hash.strip_prefix("sha256:").unwrap_or(hash);
    value.len() == 64
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

fn renderer_slices_match_images(renderer: &JsonValue, images: &[WorkflowImageLifecycle]) -> bool {
    let Some(slices) = renderer.get("slices").and_then(JsonValue::as_array) else {
        return false;
    };
    slices.len() == images.len()
        && slices.iter().zip(images).all(|(slice, image)| {
            json_u32(slice, "index") == Some(image.index)
                && json_str(slice, "groupName") == image.group_name
                && json_str(slice, "fileName") == image.file_name
                && json_str(slice, "contentHash") == image.content_hash
                && json_u32(slice, "width") == Some(image.width)
                && json_u32(slice, "height") == Some(image.height)
        })
}

fn json_str<'a>(value: &'a JsonValue, key: &str) -> &'a str {
    value.get(key).and_then(JsonValue::as_str).unwrap_or("")
}

fn json_u32(value: &JsonValue, key: &str) -> Option<u32> {
    value
        .get(key)
        .and_then(JsonValue::as_u64)
        .and_then(|n| u32::try_from(n).ok())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn image(index: u32, hash: &str) -> WorkflowImageLifecycle {
        WorkflowImageLifecycle {
            account_id: None,
            index,
            file_name: format!("slice-{index}.jpg"),
            content_hash: hash.to_owned(),
            group_name: "hero".to_owned(),
            width: 900,
            height: 1200,
            byte_size: Some(1024),
            phase: WorkflowImagePhase::Rendered,
            public_url: None,
            object_key: None,
            error_code: None,
        }
    }

    fn manifest_for(images: &[WorkflowImageLifecycle]) -> JsonValue {
        json!({
            "slices": images.iter().map(|image| json!({
                "index": image.index,
                "groupName": image.group_name,
                "fileName": image.file_name,
                "contentHash": image.content_hash,
                "width": image.width,
                "height": image.height,
            })).collect::<Vec<_>>(),
        })
    }

    #[test]
    fn a_matching_manifest_earns_a_digest() {
        let images = vec![image(
            0,
            "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        )];
        let renderer_manifest = manifest_for(&images);
        let record = record_render(RenderManifest {
            images,
            renderer_manifest,
        })
        .expect("valid manifest");
        assert!(record.manifest_digest.starts_with("manifest:sha256:"));
    }

    #[test]
    fn an_out_of_order_manifest_is_refused() {
        let mut images = vec![
            image(
                0,
                "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            ),
            image(
                1,
                "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
            ),
        ];
        let renderer_manifest = manifest_for(&images);
        images.swap(0, 1);
        images[0].index = 0;
        images[1].index = 1;
        let error = record_render(RenderManifest {
            images,
            renderer_manifest,
        })
        .unwrap_err();
        assert_eq!(error, "切片清单与渲染器组序不一致");
    }
}
