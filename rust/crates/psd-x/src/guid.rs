/*
File: rust/crates/psd-x/src/guid.rs

Purpose:
Single lowercase hyphenated GUID format checker shared by the write-path
key handlers (`lnk2` / `SoLd` / `PlLd`) and the smart-object editing API.

Source compatibility:
- Shape matches the ag-psd `checkGuid` regex.
*/

//! Photoshop-style GUID strings: `xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx`
//! with lowercase ASCII hex digits only.
//!
//! This checks **shape** (length, hyphens, hex case). It does **not** enforce
//! RFC-4122 version/variant nibbles — Photoshop-written values satisfy those,
//! but historical validation never required them. Generated GUIDs (see
//! [`crate::smart_object::generate_linked_file_guid`]) do apply RFC shaping.

/// `true` when `id` matches `xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx` with
/// lowercase ASCII hex digits (the shape Photoshop / ag-psd write).
pub fn is_guid(id: &str) -> bool {
    let bytes = id.as_bytes();
    let pattern = [8usize, 4, 4, 4, 12];
    let mut idx = 0usize;
    for (gi, &group_len) in pattern.iter().enumerate() {
        if gi > 0 {
            if idx >= bytes.len() || bytes[idx] != b'-' {
                return false;
            }
            idx += 1;
        }
        for _ in 0..group_len {
            if idx >= bytes.len()
                || !bytes[idx].is_ascii_hexdigit()
                || bytes[idx].is_ascii_uppercase()
            {
                return false;
            }
            idx += 1;
        }
    }
    idx == bytes.len()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_corpus_style_guids() {
        assert!(is_guid("20953ddb-9391-11ec-b4f1-c15674f50bc4"));
        assert!(is_guid("0bba9193-13e5-7544-9261-711816e521a3"));
        assert!(is_guid("3b90eb52-62ab-4747-b313-f6ce7ee2747b"));
    }

    #[test]
    fn rejects_uppercase_and_junk() {
        assert!(!is_guid("20953DDB-9391-11EC-B4F1-C15674F50BC4"));
        assert!(!is_guid("not-a-guid"));
        assert!(!is_guid(""));
    }
}
