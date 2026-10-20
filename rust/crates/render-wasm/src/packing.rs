//! Compact JSON + LF + JPEG payload shared by both WASM adapters.
#![forbid(unsafe_code)]
use render::RenderSlice;
use serde::Serialize;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SliceHeader<'a> {
    group_name: &'a str,
    index: u32,
    file_name: &'a str,
    width: u32,
    height: u32,
    content_hash: &'a str,
    static_group: bool,
    encode_ms: u32,
    offset: usize,
    len: usize,
}

#[derive(Serialize)]
struct Header<'a> {
    manifest: serde_json::Value,
    slices: Vec<SliceHeader<'a>>,
}

pub(crate) fn pack(manifest_json: &[u8], slices: &[RenderSlice]) -> Result<Vec<u8>, String> {
    // The compute manifest is pretty-printed. RawValue would retain its LFs and
    // break the host's first-LF framing; parsing also validates this boundary.
    let manifest = serde_json::from_slice(manifest_json).map_err(|e| e.to_string())?;
    let mut offset = 0_usize;
    let mut entries = Vec::new();
    entries
        .try_reserve_exact(slices.len())
        .map_err(|_| "unable to reserve packed metadata")?;
    for slice in slices {
        entries.push(SliceHeader {
            group_name: &slice.group_name,
            index: slice.index,
            file_name: &slice.file_name,
            width: slice.width,
            height: slice.height,
            content_hash: &slice.content_hash,
            static_group: slice.static_group,
            encode_ms: slice.encode_ms,
            offset,
            len: slice.bytes.len(),
        });
        offset = offset
            .checked_add(slice.bytes.len())
            .ok_or("packed slice size overflow")?;
    }
    // Borrow metadata instead of cloning every string into a second Value tree.
    // Extend the serialized header itself; there is no separate header copy.
    let mut packed = serde_json::to_vec(&Header {
        manifest,
        slices: entries,
    })
    .map_err(|e| e.to_string())?;
    packed_size(packed.len(), offset)?;
    let extra = offset.checked_add(1).ok_or("packed result size overflow")?;
    packed
        .try_reserve_exact(extra)
        .map_err(|_| "unable to reserve packed result")?;
    packed.push(b'\n');
    for slice in slices {
        packed.extend_from_slice(&slice.bytes);
    }
    Ok(packed)
}

fn packed_size(header: usize, payload: usize) -> Result<u32, String> {
    let len = header
        .checked_add(1)
        .and_then(|len| len.checked_add(payload))
        .ok_or("packed result size overflow")?;
    u32::try_from(len).map_err(|_| "packed result exceeds ABI length".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn slice(bytes: &[u8], static_group: bool) -> RenderSlice {
        RenderSlice {
            group_name: "图组\nsecond".into(),
            index: 2,
            file_name: "slice.jpg".into(),
            width: 3,
            height: 4,
            content_hash: "sha256:test".into(),
            static_group,
            encode_ms: 7,
            bytes: bytes.to_vec(),
        }
    }
    #[test]
    fn preserves_pretty_manifest_and_binary_offsets_without_header_newlines() {
        let manifest =
            serde_json::json!({"version": 1, "name": "line\nnext", "extra": {"nested": true}});
        let bytes = pack(
            &serde_json::to_vec_pretty(&manifest).unwrap(),
            &[
                slice(&[0, 10, 255], false),
                slice(&[], true),
                slice(&[8, 9], false),
            ],
        )
        .unwrap();
        let end = bytes.iter().position(|b| *b == b'\n').unwrap();
        let header: serde_json::Value = serde_json::from_slice(&bytes[..end]).unwrap();
        assert_eq!(header["manifest"], manifest);
        assert_eq!(header["slices"][0]["offset"], 0);
        assert_eq!(header["slices"][1]["offset"], 3);
        assert_eq!(header["slices"][1]["len"], 0);
        assert_eq!(header["slices"][1]["staticGroup"], true);
        assert_eq!(header["slices"][2]["offset"], 3);
        assert_eq!(header["slices"][0]["groupName"], "图组\nsecond");
        assert_eq!(&bytes[end + 1..], &[0, 10, 255, 8, 9]);
    }
    #[test]
    fn rejects_invalid_json_and_checks_abi_length_without_large_allocations() {
        assert!(pack(b"not JSON", &[]).is_err());
        assert_eq!(packed_size(0, u32::MAX as usize - 1).unwrap(), u32::MAX);
        assert!(packed_size(0, u32::MAX as usize).is_err());
        assert!(packed_size(usize::MAX, 0).is_err());
        let empty = pack(b"{}", &[]).unwrap();
        assert!(empty.ends_with(b"\n"));
    }
}
