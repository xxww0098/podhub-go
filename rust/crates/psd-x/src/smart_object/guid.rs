/*
File: rust/crates/psd-x/src/smart_object/guid.rs

Purpose:
GUID checks and deterministic RFC-4122 generation for the smart-object API.
Format validation delegates to [`crate::guid::is_guid`] (single implementation).

Instance GUID decision:
`PlacedLayer.placed` is validated on the SoLd write path the same way as the
linked-file id (`PlacedLayer.id`). When absent, the writer still substitutes
`placed.id` (already checked). The replace API also rejects a malformed
instance id at the boundary when one is present on the resolved layer.

Source compatibility:
- psdx-owned; no upstream ag-psd counterpart.
*/

//! Lowercase hyphenated GUID validation and linked-file GUID generation.

use std::collections::HashSet;

use uuid::Uuid;

use crate::psd::{Layer, Psd};
use crate::smart_object::errors::SmartObjectError;

/// URL-namespace UUID v5 name prefix for forked linked-file ids.
const LINKED_FILE_GUID_NAME_PREFIX: &str = "psdx:linked-file:";

/// Re-export of the shared shape checker for the smart-object public API.
pub use crate::guid::is_guid;

/// Validate `id` or return [`SmartObjectError::InvalidGuid`].
pub fn check_guid(id: &str) -> Result<(), SmartObjectError> {
    if is_guid(id) {
        Ok(())
    } else {
        Err(SmartObjectError::InvalidGuid { id: id.to_string() })
    }
}

/// Deterministic RFC-4122 UUID (v5) for a new linked-file record.
///
/// Same `seed` with the same `existing` set yields the same id. On collision
/// with any string in `existing`, the generator perturbs (`seed#1`, `seed#2`, …)
/// until unique. Output is lowercase hyphenated and passes [`is_guid`]; the
/// variant nibble is RFC-compliant (uuid crate v5).
pub fn generate_linked_file_guid(
    existing: impl IntoIterator<Item = impl AsRef<str>>,
    seed: &str,
) -> String {
    let mut taken: HashSet<String> = existing
        .into_iter()
        .map(|s| s.as_ref().to_string())
        .collect();
    let mut perturb = 0u64;
    loop {
        let name = if perturb == 0 {
            format!("{LINKED_FILE_GUID_NAME_PREFIX}{seed}")
        } else {
            format!("{LINKED_FILE_GUID_NAME_PREFIX}{seed}#{perturb}")
        };
        let id = Uuid::new_v5(&Uuid::NAMESPACE_URL, name.as_bytes())
            .to_string()
            .to_ascii_lowercase();
        debug_assert!(is_guid(&id));
        if taken.insert(id.clone()) {
            return id;
        }
        perturb = perturb.saturating_add(1);
    }
}

/// All GUID strings that already identify linked files or placements in `psd`.
pub(crate) fn collect_doc_guids(psd: &Psd) -> HashSet<String> {
    let mut set = HashSet::new();
    if let Some(files) = psd.linked_files.as_deref() {
        for f in files {
            set.insert(f.id.clone());
        }
    }
    fn walk(layers: &[Layer], set: &mut HashSet<String>) {
        for layer in layers {
            if let Some(placed) = layer.additional_info.placed_layer.as_ref() {
                set.insert(placed.id.clone());
                if let Some(instance) = placed.placed.as_ref() {
                    set.insert(instance.clone());
                }
            }
            if let Some(children) = layer.children.as_deref() {
                walk(children, set);
            }
        }
    }
    walk(psd.children.as_deref().unwrap_or(&[]), &mut set);
    set
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_corpus_style_guids() {
        assert!(is_guid("20953ddb-9391-11ec-b4f1-c15674f50bc4"));
        assert!(check_guid("20953ddb-9391-11ec-b4f1-c15674f50bc4").is_ok());
    }

    #[test]
    fn rejects_uppercase_and_junk() {
        assert!(!is_guid("20953DDB-9391-11EC-B4F1-C15674F50BC4"));
        assert!(check_guid("nope").is_err());
    }

    #[test]
    fn generated_guid_is_rfc_shaped_and_deterministic() {
        let a = generate_linked_file_guid(std::iter::empty::<&str>(), "seed-a");
        let b = generate_linked_file_guid(std::iter::empty::<&str>(), "seed-a");
        let c = generate_linked_file_guid(std::iter::empty::<&str>(), "seed-b");
        assert_eq!(a, b);
        assert_ne!(a, c);
        assert!(is_guid(&a));
        // Variant nibble (RFC 4122): first hex digit of the 4th group is 8–b.
        let variant = a.as_bytes()[19];
        assert!(
            matches!(variant, b'8' | b'9' | b'a' | b'b'),
            "variant nibble not RFC-shaped: {a}"
        );
        // Version nibble (v5): first hex digit of the 3rd group is '5'.
        assert_eq!(a.as_bytes()[14], b'5', "expected UUID v5: {a}");
    }

    #[test]
    fn generation_perturbs_on_collision() {
        let first = generate_linked_file_guid(std::iter::empty::<&str>(), "collide");
        let second = generate_linked_file_guid([&first], "collide");
        assert_ne!(first, second);
        assert!(is_guid(&second));
    }
}
