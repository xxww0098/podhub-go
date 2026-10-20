//! Recognition answer and fixed-tag contract.
//!
//! One implementation for Cloud and the browser. Cloud calls these functions
//! on the paid OCR path and again at settle (billing, leases, and the kill
//! switch stay there). The browser calls the same functions through
//! `listing-core-wasm` before it decides the one retry. This module does
//! not call a provider, read a quota, or write a row.
//!
//! Whole Latin words are allowed (`iPhone 17 Pro Max`). A mixed word is folded
//! toward its majority script when the other script is only lookalikes; any
//! remaining mix is refused. `i` is not folded.
//! Search tags are canonicalized before that check: list punctuation is split,
//! a hyphen becomes `_`, and a missing `#` is added. A tag body is still
//! `_`-separated words that each contain a Cyrillic letter and otherwise only
//! Cyrillic letters and digits. Extra tags are not dropped and long tags are
//! not truncated.

use std::collections::HashSet;

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use thiserror::Error;

use crate::validate::PRODUCT_NAME_MAX_CHARS;

/// At most this many fixed tags on a prompt or supplier row; at least 1.
pub const MAX_FIXED_TAGS: usize = 30;
pub const MAX_TAG_CHARS: usize = 30;
pub const AI_TAG_COUNT: usize = 5;

/// CJK Unified Ideographs, extensions, and the compatibility block.
/// Product-name validation uses a wider set in `validate::contains_han`.
/// OCR answers and prompt briefs share this narrower set on purpose:
/// a title may contain Latin (`iPhone`) and must not contain Han.
pub fn contains_han(text: &str) -> bool {
    text.chars().any(|character| {
        matches!(
            character as u32,
            0x3400..=0x4DBF | 0x4E00..=0x9FFF | 0xF900..=0xFAFF | 0x20000..=0x323AF
        )
    })
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Error)]
pub enum FixedTagsViolation {
    #[error("固定标签必须 1–30 个")]
    Count,
    #[error("固定标签长度必须为 2–30 个字符")]
    Length,
    #[error("固定标签必须是以 # 开头的俄语标签")]
    Format,
    #[error("固定标签不能重复")]
    Duplicate,
}

/// A tag body after the leading `#`: `_`-separated words, each non-empty,
/// each containing a Cyrillic letter, and otherwise only Cyrillic or digits.
pub fn valid_tag_body(body: &str) -> bool {
    !body.is_empty()
        && body.split('_').all(|word| {
            !word.is_empty()
                && word
                    .chars()
                    .any(|ch| matches!(ch, 'а'..='я' | 'А'..='Я' | 'ё' | 'Ё'))
                && word
                    .chars()
                    .all(|ch| matches!(ch, 'а'..='я' | 'А'..='Я' | 'ё' | 'Ё' | '0'..='9'))
        })
}

pub fn validate_fixed_tags(tags: &[String]) -> Result<(), FixedTagsViolation> {
    if tags.is_empty() || tags.len() > MAX_FIXED_TAGS {
        return Err(FixedTagsViolation::Count);
    }
    let mut seen = HashSet::with_capacity(tags.len());
    for tag in tags {
        let chars = tag.chars().count();
        if !(2..=MAX_TAG_CHARS).contains(&chars) {
            return Err(FixedTagsViolation::Length);
        }
        let Some(body) = tag.strip_prefix('#') else {
            return Err(FixedTagsViolation::Format);
        };
        if !valid_tag_body(body) {
            return Err(FixedTagsViolation::Format);
        }
        if !seen.insert(tag.to_lowercase()) {
            return Err(FixedTagsViolation::Duplicate);
        }
    }
    Ok(())
}

/// The parsed answer. Serde is derived so the evaluation harness
/// (`tools/prompt-eval/src/main.rs`) can persist and compare the exact same shape
/// production settles, instead of a second view of it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct OcrResult {
    pub ru: String,
    pub tags: Vec<String>,
    pub desc: String,
    pub candidates: Vec<Value>,
}

#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum OcrContractViolation {
    #[error("AI 没有返回识别内容")]
    NoText,
    #[error("AI 返回的内容格式不正确")]
    NotJson,
    #[error("AI 未生成{0}")]
    Empty(&'static str),
    #[error("俄语标题不能超过 {} 个字符", PRODUCT_NAME_MAX_CHARS)]
    TitleTooLong,
    #[error("{0}中混入了中文，需要纯俄语内容")]
    Han(&'static str),
    #[error("{0}里的俄语词混入了拉丁字母")]
    MixedScript(&'static str),
    #[error("图片标签不符合固定标签契约：{0}")]
    ConfiguredTags(&'static str),
}

impl OcrContractViolation {
    /// Stable token for logs. The display sentence stays out of the line.
    pub fn reason_code(&self) -> &'static str {
        match self {
            Self::NoText => "no_text",
            Self::NotJson => "not_json",
            Self::Empty(_) => "empty",
            Self::TitleTooLong => "title_too_long",
            Self::Han(_) => "han",
            Self::MixedScript(_) => "mixed_script",
            Self::ConfiguredTags(_) => "configured_tags",
        }
    }

    /// Tag shape or the required count of five. The one corrective retry names
    /// this format. A title or description that is simply empty does not.
    pub fn tag_format(&self) -> bool {
        matches!(
            self,
            Self::ConfiguredTags(_) | Self::Empty("恰好 5 个商品标签")
        )
    }

    /// What the one retry may do with this answer.
    ///
    /// Han, mixed script and tag format get one text correction using the
    /// stored answer. Chinese remains invalid until that correction passes.
    /// Every other violation keeps the existing blind retry.
    pub fn retry_class(&self) -> RetryClass {
        if matches!(self, Self::Han(_) | Self::MixedScript(_)) || self.tag_format() {
            RetryClass::Corrective
        } else {
            RetryClass::Blind
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum RetryClass {
    Corrective,
    Blind,
    Permanent,
}

/// Shared catalog boundary for the configured recognition contract.
pub fn validate_configured_ai_tags(
    fixed_tags: &[String],
    ai_tags: &[String],
) -> Result<(), OcrContractViolation> {
    validate_fixed_tags(fixed_tags)
        .map_err(|_| OcrContractViolation::ConfiguredTags("固定标签必须 1–30 个有效标签"))?;
    if ai_tags.len() != AI_TAG_COUNT {
        return Err(OcrContractViolation::ConfiguredTags("必须恰好 5 个"));
    }
    validate_ai_tag_list(ai_tags).map_err(OcrContractViolation::ConfiguredTags)?;
    let fixed = fixed_tags
        .iter()
        .map(|tag| tag.to_lowercase())
        .collect::<HashSet<_>>();
    if ai_tags
        .iter()
        .any(|tag| fixed.contains(&tag.to_lowercase()))
    {
        return Err(OcrContractViolation::ConfiguredTags("不能与固定标签重复"));
    }
    Ok(())
}

fn validate_ai_tag_list(tags: &[String]) -> Result<(), &'static str> {
    let mut seen = HashSet::new();
    for tag in tags {
        if tag.chars().count() > MAX_TAG_CHARS
            || !tag.starts_with('#')
            || tag.len() == 1
            || !valid_tag_body(&tag[1..])
        {
            return Err("每个标签须为不超过 30 字符的俄语词或下划线标签");
        }
        if !seen.insert(tag.to_lowercase()) {
            return Err("标签不能重复");
        }
    }
    Ok(())
}

/// The field rules alone, for a result that is already structured (the settle
/// route) and already normalized. `desc` is the model's key; the wire field is
/// `description`.
pub fn check(ru: &str, tags: &[String], desc: &str) -> Result<(), OcrContractViolation> {
    if ru.trim().is_empty() {
        return Err(OcrContractViolation::Empty("俄语标题"));
    }
    if ru.trim().chars().count() > PRODUCT_NAME_MAX_CHARS {
        return Err(OcrContractViolation::TitleTooLong);
    }
    if desc.trim().is_empty() {
        return Err(OcrContractViolation::Empty("商品描述"));
    }
    if tags.len() != AI_TAG_COUNT {
        return Err(OcrContractViolation::Empty("恰好 5 个商品标签"));
    }
    if contains_han(ru) {
        return Err(OcrContractViolation::Han("俄语标题"));
    }
    if contains_han(desc) {
        return Err(OcrContractViolation::Han("商品描述"));
    }
    if tags.iter().any(|tag| contains_han(tag)) {
        return Err(OcrContractViolation::Han("商品标签"));
    }
    if crate::ocr_script::contains_mixed_script(ru) {
        return Err(OcrContractViolation::MixedScript("俄语标题"));
    }
    if crate::ocr_script::contains_mixed_script(desc) {
        return Err(OcrContractViolation::MixedScript("商品描述"));
    }
    if tags
        .iter()
        .any(|tag| crate::ocr_script::contains_mixed_script(tag))
    {
        return Err(OcrContractViolation::MixedScript("商品标签"));
    }
    validate_ai_tag_list(tags).map_err(OcrContractViolation::ConfiguredTags)?;
    Ok(())
}

/// One Chat Completions response → one checked result.
pub fn parse_completion(completion: &Value) -> Result<OcrResult, OcrContractViolation> {
    let text = assistant_text(completion).ok_or(OcrContractViolation::NoText)?;
    let parsed = parse_structured(&text).ok_or(OcrContractViolation::NotJson)?;
    let object = parsed.as_object().ok_or(OcrContractViolation::NotJson)?;
    result_from_object(object)
}

fn folded_field(text: &str) -> String {
    crate::ocr_script::fold_latin_lookalikes(text.trim())
}

fn raw_fields(object: &Map<String, Value>) -> (String, Vec<String>, String) {
    let ru = folded_field(object.get("ru").and_then(Value::as_str).unwrap_or_default());
    let desc = folded_field(
        object
            .get("desc")
            .and_then(Value::as_str)
            .unwrap_or_default(),
    );
    let tags = object
        .get("tags")
        .map(crate::ocr_tag_format::decode_tags)
        .unwrap_or_default();
    (ru, tags, desc)
}

/// Rewrite lookalikes in the assistant JSON the caller returns.
///
/// The stored provider body stays the original. Settlement reads it through
/// `raw_fields`, which folds the same way, so the draft matches this copy.
/// Returns whether the returned completion changed, so Cloud can log a fold.
pub fn fold_completion(completion: &mut Value) -> bool {
    let Some(text) = assistant_text(completion) else {
        return false;
    };
    let Some(mut parsed) = parse_structured(&text) else {
        return false;
    };
    let Some(object) = parsed.as_object_mut() else {
        return false;
    };
    let mut changed = false;
    for key in ["ru", "desc"] {
        if let Some(Value::String(value)) = object.get_mut(key) {
            let folded = crate::ocr_script::fold_latin_lookalikes(value);
            if folded != *value {
                *value = folded;
                changed = true;
            }
        }
    }
    match object.get_mut("tags") {
        Some(Value::String(value)) => {
            let folded = crate::ocr_script::fold_latin_lookalikes(value);
            if folded != *value {
                *value = folded;
                changed = true;
            }
        }
        Some(Value::Array(items)) => {
            for item in items {
                if let Value::String(value) = item {
                    let folded = crate::ocr_script::fold_latin_lookalikes(value);
                    if folded != *value {
                        *value = folded;
                        changed = true;
                    }
                }
            }
        }
        _ => {}
    }
    if !changed {
        return false;
    }
    let Ok(encoded) = serde_json::to_string(&parsed) else {
        return false;
    };
    let Some(message) = completion
        .get_mut("choices")
        .and_then(|choices| choices.get_mut(0))
        .and_then(|choice| choice.get_mut("message"))
    else {
        return false;
    };
    let Some(object) = message.as_object_mut() else {
        return false;
    };
    object.insert("content".to_owned(), Value::String(encoded));
    true
}

/// `ru`, the tags text as the model wrote it, and `desc`, before folding.
///
/// The corrective prompt quotes these slices. [`answer_fields`] is the folded
/// copy `check` sees.
pub fn source_fields(completion: &Value) -> Option<(String, String, String)> {
    let text = assistant_text(completion)?;
    let parsed = parse_structured(&text)?;
    let object = parsed.as_object()?;
    let ru = object
        .get("ru")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned();
    let desc = object
        .get("desc")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned();
    let tags = match object.get("tags") {
        Some(Value::String(value)) => value.clone(),
        Some(Value::Array(items)) => items
            .iter()
            .filter_map(Value::as_str)
            .collect::<Vec<_>>()
            .join(" "),
        _ => String::new(),
    };
    Some((ru, tags, desc))
}

/// Fields of a structured answer, including one `check` will refuse.
///
/// The corrective retry names every bad field. `parse_completion` stops at the
/// first violation, so the planner reads the fields from here.
pub fn answer_fields(completion: &Value) -> Option<(String, Vec<String>, String)> {
    let text = assistant_text(completion)?;
    let parsed = parse_structured(&text)?;
    let object = parsed.as_object()?;
    Some(raw_fields(object))
}

fn result_from_object(object: &Map<String, Value>) -> Result<OcrResult, OcrContractViolation> {
    let (ru, tags, desc) = raw_fields(object);
    check(&ru, &tags, &desc)?;
    let candidates = object
        .get("candidates")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    Ok(OcrResult {
        ru,
        tags,
        desc,
        candidates,
    })
}

/// `choices[0].message.content`, joined when the provider splits it into
/// parts; `reasoning_content` only when the content is empty.
pub fn assistant_text(completion: &Value) -> Option<String> {
    let message = completion.get("choices")?.get(0)?.get("message")?;
    match message.get("content") {
        Some(Value::String(content)) if !content.trim().is_empty() => {
            return Some(content.clone());
        }
        Some(Value::Array(parts)) => {
            let joined: String = parts
                .iter()
                .map(|part| match part {
                    Value::String(text) => text.as_str(),
                    other => other
                        .get("text")
                        .and_then(Value::as_str)
                        .unwrap_or_default(),
                })
                .collect();
            if !joined.trim().is_empty() {
                return Some(joined);
            }
        }
        _ => {}
    }
    message
        .get("reasoning_content")
        .and_then(Value::as_str)
        .filter(|text| !text.trim().is_empty())
        .map(str::to_owned)
}

fn strip_json_fence(content: &str) -> &str {
    let trimmed = content.trim();
    let Some(opened) = trimmed.strip_prefix("```") else {
        return trimmed;
    };
    let opened = opened.strip_prefix("json").unwrap_or(opened);
    opened.strip_suffix("```").map_or(trimmed, str::trim)
}

/// Tolerate an answer the model wrapped: the outermost brackets locate it.
pub fn parse_structured(text: &str) -> Option<Value> {
    let trimmed = strip_json_fence(text);
    if let Ok(value) = serde_json::from_str::<Value>(trimmed) {
        return Some(value);
    }
    let start = trimmed.find(['{', '['])?;
    let end = trimmed.rfind(['}', ']'])?;
    if end <= start {
        return None;
    }
    serde_json::from_str(&trimmed[start..=end]).ok()
}

#[cfg(test)]
#[path = "ocr_contract_tests.rs"]
mod tests;
