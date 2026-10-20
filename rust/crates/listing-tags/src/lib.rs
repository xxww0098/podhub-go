//! JSON entry over the copied banned-tag functions.
//!
//! The browser `listing-core-wasm` C ABI does not export these functions.
//! This crate is a separate wasm32-unknown-unknown module so a wazero host
//! can call the same Rust functions. It is not that browser artifact.
//!
//! One call is in flight. A trap aborts the instance; the host must drop it.

mod banned;
mod fold;

use std::cell::RefCell;

use banned::{BannedTagMatch, BannedTagRule};
use serde::Deserialize;
use serde::Serialize;

pub use banned::{
    normalize_tag_token, partition_tags, rejection_message, stem_key, strip_tag_text, tag_is_banned,
};

thread_local! {
    static RESULT: RefCell<Vec<u8>> = const { RefCell::new(Vec::new()) };
    static LAST_ERROR: RefCell<Vec<u8>> = const { RefCell::new(Vec::new()) };
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
pub struct RuleIn {
    pub term: String,
    #[serde(rename = "matchMode")]
    pub match_mode: String,
}

/// Field order is the wire. Go constructs the same order.
#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
pub struct Call {
    pub op: String,
    pub tag: String,
    pub tags: Vec<String>,
    pub text: String,
    pub term: String,
    pub rules: Vec<RuleIn>,
}

/// Field order is the wire. Empty lists are `[]`, never omitted.
#[derive(Debug, Clone, Default, Deserialize, Serialize, PartialEq, Eq)]
pub struct Out {
    pub banned: bool,
    pub kept: Vec<String>,
    pub rejected: Vec<String>,
    pub message: String,
    pub text: String,
    pub stem: String,
}

fn rules_of(input: &[RuleIn]) -> Result<Vec<BannedTagRule>, String> {
    let mut rules = Vec::with_capacity(input.len());
    for rule in input {
        let mode = match rule.match_mode.as_str() {
            "exact" => BannedTagMatch::Exact,
            "stem" => BannedTagMatch::Stem,
            other => return Err(format!("match mode {other} is not exact or stem")),
        };
        // Stored terms are already canonical. Do not normalize again: that
        // would diverge from `banned_tags::store::load_enabled`.
        rules.push(BannedTagRule {
            term: rule.term.clone(),
            mode,
        });
    }
    Ok(rules)
}

/// Runs one pure call. `rules[].term` is used as stored.
pub fn eval_call(call: &Call) -> Result<Out, String> {
    let rules = rules_of(&call.rules)?;
    let mut out = Out::default();
    match call.op.as_str() {
        "tag_banned" => {
            out.banned = tag_is_banned(&call.tag, &rules);
        }
        "partition" => {
            let (kept, rejected) = partition_tags(&call.tags, &rules);
            out.banned = !rejected.is_empty();
            if out.banned {
                out.message = rejection_message(&rejected);
            }
            out.kept = kept;
            out.rejected = rejected;
        }
        "strip_text" => {
            let (text, rejected) = strip_tag_text(&call.text, &rules);
            out.banned = !rejected.is_empty();
            if out.banned {
                out.message = rejection_message(&rejected);
            }
            out.text = text;
            out.rejected = rejected;
        }
        "normalize" => {
            out.text = normalize_tag_token(&call.text);
        }
        "stem_key" => {
            out.stem = stem_key(&normalize_tag_token(&call.term));
        }
        other => return Err(format!("unknown op {other}")),
    }
    Ok(out)
}


pub fn eval_json(input: &[u8]) -> Result<Vec<u8>, String> {
    let call: Call = serde_json::from_slice(input).map_err(|error| error.to_string())?;
    let out = eval_call(&call)?;
    serde_json::to_vec(&out).map_err(|error| error.to_string())
}

fn set_last_error(message: &str) {
    let body = serde_json::json!({ "code": "bad_call", "message": message });
    let bytes = serde_json::to_vec(&body).unwrap_or_else(|_| b"{}".to_vec());
    LAST_ERROR.with(|slot| *slot.borrow_mut() = bytes);
}

/// # Safety
///
/// `ptr` must address `len` initialized bytes. The call does not retain them.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn eval(ptr: *const u8, len: usize) -> u32 {
    let bytes = if len == 0 {
        &[][..]
    } else if ptr.is_null() {
        set_last_error("input pointer is null");
        return 1;
    } else {
        // SAFETY: the caller guarantees ptr addresses len initialized bytes;
        // the slice is dropped before this function returns.
        unsafe { std::slice::from_raw_parts(ptr, len) }
    };
    match eval_json(bytes) {
        Ok(body) => {
            RESULT.with(|slot| *slot.borrow_mut() = body);
            0
        }
        Err(message) => {
            set_last_error(&message);
            1
        }
    }
}

#[unsafe(no_mangle)]
pub extern "C" fn alloc(len: usize) -> *mut u8 {
    let Ok(layout) = std::alloc::Layout::from_size_align(len.max(1), 1) else {
        return std::ptr::null_mut();
    };
    // SAFETY: layout was built above with a non-zero size and align 1.
    unsafe { std::alloc::alloc(layout) }
}

/// # Safety
///
/// `ptr` must come from [`alloc`] with this `len`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn dealloc(ptr: *mut u8, len: usize) {
    if ptr.is_null() {
        return;
    }
    let Ok(layout) = std::alloc::Layout::from_size_align(len.max(1), 1) else {
        return;
    };
    // SAFETY: ptr came from alloc with this exact len, checked above.
    unsafe { std::alloc::dealloc(ptr, layout) }
}

#[unsafe(no_mangle)]
pub extern "C" fn result_ptr() -> *const u8 {
    RESULT.with(|slot| slot.borrow().as_ptr())
}

#[unsafe(no_mangle)]
pub extern "C" fn result_len() -> u32 {
    RESULT.with(|slot| slot.borrow().len() as u32)
}

#[unsafe(no_mangle)]
pub extern "C" fn last_error_ptr() -> *const u8 {
    LAST_ERROR.with(|slot| slot.borrow().as_ptr())
}

#[unsafe(no_mangle)]
pub extern "C" fn last_error_len() -> u32 {
    LAST_ERROR.with(|slot| slot.borrow().len() as u32)
}

#[cfg(test)]
mod corpus {
    use super::*;

    #[derive(serde::Deserialize)]
    struct Row {
        name: String,
        request: Call,
        response: Out,
    }

    #[test]
    fn native_oracle_matches_the_committed_responses() {
        let rows: Vec<Row> =
            serde_json::from_str(include_str!("../testdata/oracle.json")).expect("oracle");
        let cases: Vec<serde_json::Value> =
            serde_json::from_str(include_str!("../testdata/cases.json")).expect("cases");
        assert_eq!(rows.len(), cases.len());
        for (row, case) in rows.iter().zip(cases) {
            assert_eq!(row.name, case["name"].as_str().unwrap_or(""));
            let got = eval_call(&row.request).unwrap_or_else(|error| panic!("{}: {error}", row.name));
            assert_eq!(got, row.response, "{}", row.name);
        }
    }
}
