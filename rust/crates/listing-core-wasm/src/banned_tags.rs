//! Op 20, `bannedTags`: the server's door onto `listing_core::banned_tags`.
//!
//! Go sends one JSON call and receives one JSON outcome. No schema handle.
//! `rules[].term` is used as stored: stored terms are already canonical, and
//! normalizing again would diverge from `banned_tags::store::load_enabled`.
//! Compiled out of the `browser` build, which never matches platform rules.

use listing_core::banned_tags::{
    BannedTagMatch, BannedTagRule, normalize_tag_token, partition_tags, rejection_message,
    stem_key, strip_tag_text, tag_is_banned,
};
use serde::{Deserialize, Serialize};

use crate::error::CoreError;

/// Op 20 — [`eval`].
pub(crate) const OP_BANNED_TAGS: u32 = 20;

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
pub(crate) struct RuleIn {
    pub(crate) term: String,
    #[serde(rename = "matchMode")]
    pub(crate) match_mode: String,
}

/// Field order is the wire. Go constructs the same order.
#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
pub(crate) struct Call {
    pub(crate) op: String,
    pub(crate) tag: String,
    pub(crate) tags: Vec<String>,
    pub(crate) text: String,
    pub(crate) term: String,
    pub(crate) rules: Vec<RuleIn>,
}

/// Field order is the wire. Empty lists are `[]`, never omitted.
#[derive(Debug, Clone, Default, Deserialize, Serialize, PartialEq, Eq)]
pub(crate) struct Out {
    pub(crate) banned: bool,
    pub(crate) kept: Vec<String>,
    pub(crate) rejected: Vec<String>,
    pub(crate) message: String,
    pub(crate) text: String,
    pub(crate) stem: String,
}

fn rules_of(input: &[RuleIn]) -> Result<Vec<BannedTagRule>, CoreError> {
    input
        .iter()
        .map(|rule| {
            let mode = match rule.match_mode.as_str() {
                "exact" => BannedTagMatch::Exact,
                "stem" => BannedTagMatch::Stem,
                other => {
                    return Err(CoreError::refused(format!(
                        "match mode {other} is not exact or stem"
                    )));
                }
            };
            Ok(BannedTagRule {
                term: rule.term.clone(),
                mode,
            })
        })
        .collect()
}

pub(crate) fn eval_call(call: &Call) -> Result<Out, CoreError> {
    let rules = rules_of(&call.rules)?;
    let mut out = Out::default();
    match call.op.as_str() {
        "tag_banned" => out.banned = tag_is_banned(&call.tag, &rules),
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
        "normalize" => out.text = normalize_tag_token(&call.text),
        "stem_key" => out.stem = stem_key(&normalize_tag_token(&call.term)),
        other => return Err(CoreError::refused(format!("unknown tag op {other}"))),
    }
    Ok(out)
}

pub(crate) fn eval(bytes: &[u8]) -> Result<Vec<u8>, CoreError> {
    let call: Call = serde_json::from_slice(bytes).map_err(CoreError::decode)?;
    let out = eval_call(&call)?;
    serde_json::to_vec(&out).map_err(CoreError::decode)
}
