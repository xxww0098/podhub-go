//! Op 20, `bannedTags`, through the exported `call`: every committed oracle
//! row must come back equal, and a bad call must be refused.
//! The Go wazero host replays the same file against the compiled module.

#![cfg(not(feature = "browser"))]

use serde_json::Value;

const OP_BANNED_TAGS: u32 = 20;
const ORACLE: &str = include_str!("fixtures/banned_tags/oracle.json");

fn call(body: &[u8]) -> Result<Vec<u8>, Value> {
    let ptr = listing_core_wasm::alloc(body.len());
    // SAFETY: `ptr` was just returned by `alloc(body.len())`; no one else can see it.
    unsafe { std::ptr::copy_nonoverlapping(body.as_ptr(), ptr, body.len()) };
    // SAFETY: the pair `alloc` returned, initialised above.
    let status = unsafe { listing_core_wasm::call(OP_BANNED_TAGS, 0, ptr, body.len()) };
    // SAFETY: the same pair, untouched since.
    unsafe { listing_core_wasm::free(ptr, body.len()) };
    if status == 0 {
        let (p, n) = (listing_core_wasm::result_ptr(), listing_core_wasm::result_len() as usize);
        // SAFETY: result ptr+len describe a buffer owned by this module until `drop_result`.
        let out = unsafe { std::slice::from_raw_parts(p, n) }.to_vec();
        listing_core_wasm::drop_result();
        Ok(out)
    } else {
        let (p, n) = (
            listing_core_wasm::last_error_ptr(),
            listing_core_wasm::last_error_len() as usize,
        );
        // SAFETY: last_error ptr+len always describe a valid, possibly empty buffer.
        Err(serde_json::from_slice(unsafe { std::slice::from_raw_parts(p, n) }).expect("error JSON"))
    }
}

#[test]
fn every_oracle_row_matches() {
    let rows: Vec<Value> = serde_json::from_str(ORACLE).expect("oracle");
    assert!(rows.len() >= 70, "oracle rows {}", rows.len());
    for row in rows {
        let name = row["name"].as_str().unwrap_or("");
        let got = call(row["request"].to_string().as_bytes())
            .unwrap_or_else(|error| panic!("{name}: {error}"));
        // `Value` sorts keys, so this checks content; the Go wazero test compares bytes.
        let got: Value = serde_json::from_slice(&got).expect("result JSON");
        assert_eq!(got, row["response"], "{name}");
    }
}

#[test]
fn unknown_op_and_match_mode_are_refused() {
    let base = |op: &str, mode: &str| {
        serde_json::json!({
            "op": op, "tag": "", "tags": [], "text": "", "term": "",
            "rules": [{"term": "x", "matchMode": mode}],
        })
        .to_string()
    };
    let refused = call(base("nope", "exact").as_bytes()).expect_err("unknown op");
    assert_eq!(refused["code"], "CORE_REFUSED");
    let refused = call(base("partition", "fuzzy").as_bytes()).expect_err("unknown mode");
    assert_eq!(refused["code"], "CORE_REFUSED");
    let decode = call(b"{").expect_err("bad json");
    assert_eq!(decode["code"], "CORE_DECODE");
}
