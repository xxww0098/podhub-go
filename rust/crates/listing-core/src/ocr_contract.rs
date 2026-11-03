//! Artwork recognition: the model describes a scene; code owns product facts.
use crate::validate::PRODUCT_NAME_MAX_CHARS;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashSet;
use thiserror::Error;
#[cfg(test)]
#[path = "ocr_contract_tests.rs"]
mod tests;
pub const MAX_FIXED_TAGS: usize = 30;
pub const MAX_TAG_CHARS: usize = 30;
pub const VISUAL_TAG_COUNT: usize = 5;

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

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ProductProfile {
    pub product_type_ru: String,
    pub facts_ru: String,
}

impl ProductProfile {
    pub fn title_base(&self) -> String {
        format!("{} {}", self.product_type_ru, self.facts_ru)
            .trim()
            .to_owned()
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct OcrResult {
    pub ru: String,
    pub tags: Vec<String>,
    pub desc: String,
    pub candidates: Vec<Value>,
}

#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum OcrContractViolation {
    #[error("商品事实无效，请重新保存并发布")]
    Profile,
    #[error("固定标签无效，请重新保存并发布")]
    FixedTags,
    #[error("AI 没有返回完整的画面文案，请重新测试或人工处理")]
    Shape,
    #[error("图片主题不符合短俄文主题规则，请人工处理")]
    Theme,
    #[error("画面文案含未经确认的地域、身份或商品属性，请人工处理")]
    UnsupportedTheme,
    #[error("画面描述须为 80–800 字的俄文，请人工处理")]
    Description,
    #[error("AI 须返回 5 个不同的俄文画面标签，每个不超过 30 字，请人工处理")]
    Tags,
    #[error("图片无法辨认，请换清晰图片或人工填写")]
    Unclear,
    #[error("俄语标题超过 200 个字符")]
    TitleTooLong,
}
impl OcrContractViolation {
    pub fn reason_code(&self) -> &'static str {
        match self {
            Self::Profile => "invalid_profile",
            Self::FixedTags => "configured_tags",
            Self::Shape => "invalid_theme_json",
            Self::Theme => "invalid_theme",
            Self::UnsupportedTheme => "unsupported_theme",
            Self::Description => "invalid_visual_description",
            Self::Tags => "invalid_visual_tags",
            Self::Unclear => "unclear_image",
            Self::TitleTooLong => "title_too_long",
        }
    }
    pub fn retry_class(&self) -> &'static str {
        "permanent"
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct VisualAnswer {
    state: VisualState,
    theme_ru: String,
    description_ru: String,
    tags: Vec<String>,
}
#[derive(Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
enum VisualState {
    Clear,
    Plain,
    Unclear,
}
fn cyr(c: char) -> bool {
    matches!(c, 'а'..='я' | 'А'..='Я' | 'ё' | 'Ё')
}

// shortcut: finite stems catch observed unsupported claims; new scenes still need human acceptance before listing.
fn unsupported_theme(theme: &str) -> bool {
    let lower = theme.to_lowercase();
    [
        "японск",
        "африканск",
        "альпийск",
        "китайск",
        "французск",
        "итальянск",
        "американск",
        "парижск",
        "ван гог",
        "пикассо",
        "дисней",
        "керамическ",
        "хлопков",
        "водонепрониц",
        "лечебн",
    ]
    .iter()
    .any(|word| lower.contains(word))
        || lower.split_whitespace().any(|word| word == "моне")
}

// Material adjectives are allowed in the long description when they describe
// something visible in the artwork: the product is the print, not the pictured
// objects. Theme and tags stay strict because they become the product title and
// tags. Origin, identity and product-property claims stay blocked everywhere.
fn unsupported_description(text: &str) -> bool {
    let lower = text.to_lowercase();
    [
        "японск",
        "африканск",
        "альпийск",
        "китайск",
        "французск",
        "итальянск",
        "американск",
        "парижск",
        "ван гог",
        "пикассо",
        "дисней",
        "водонепрониц",
        "лечебн",
    ]
    .iter()
    .any(|word| lower.contains(word))
        || lower.split_whitespace().any(|word| word == "моне")
}

fn short_theme(mut theme: &str) -> Option<&str> {
    if theme.chars().count() <= 40 {
        return Some(theme);
    }
    while theme.chars().count() > 40
        || theme.rsplit(' ').next().is_some_and(|word| {
            matches!(
                word,
                "и" | "с"
                    | "со"
                    | "в"
                    | "во"
                    | "на"
                    | "у"
                    | "из"
                    | "к"
                    | "ко"
                    | "под"
                    | "над"
                    | "за"
                    | "для"
                    | "без"
                    | "о"
                    | "об"
                    | "по"
            )
        })
    {
        theme = theme.rsplit_once(' ')?.0;
    }
    Some(theme)
}

pub fn parse_completion(
    profile: &ProductProfile,
    fixed_tags: &[String],
    completion: &Value,
) -> Result<OcrResult, OcrContractViolation> {
    let text = completion
        .pointer("/choices/0/message/content")
        .and_then(Value::as_str)
        .ok_or(OcrContractViolation::Shape)?;
    let answer: VisualAnswer =
        serde_json::from_str(text).map_err(|_| OcrContractViolation::Shape)?;
    if answer.state == VisualState::Clear {
        let description = &answer.description_ru;
        if !(80..=800).contains(&description.chars().count())
            || description.trim() != description
            || !description.chars().any(cyr)
            || !description.chars().all(|ch| {
                cyr(ch)
                    || matches!(
                        ch,
                        ' ' | '.' | ',' | ';' | ':' | '-' | '–' | '—' | '(' | ')' | '!' | '?'
                    )
            })
        {
            return Err(OcrContractViolation::Description);
        }
        if unsupported_description(description) {
            return Err(OcrContractViolation::UnsupportedTheme);
        }
        if answer.tags.len() != VISUAL_TAG_COUNT
            || validate_fixed_tags(&answer.tags).is_err()
            || answer
                .tags
                .iter()
                .any(|tag| tag != &tag.to_lowercase() || tag.chars().any(|ch| ch.is_ascii_digit()))
        {
            return Err(OcrContractViolation::Tags);
        }
        if answer
            .tags
            .iter()
            .any(|tag| unsupported_theme(&tag.replace('_', " ")))
        {
            return Err(OcrContractViolation::UnsupportedTheme);
        }
    } else if !answer.description_ru.is_empty() || !answer.tags.is_empty() {
        return Err(OcrContractViolation::Shape);
    }
    assemble(profile, fixed_tags, answer)
}

/// A free formula preview has no image evidence and cannot invent visual copy.
pub fn preview(
    profile: &ProductProfile,
    fixed_tags: &[String],
    theme: &str,
) -> Result<OcrResult, OcrContractViolation> {
    assemble(
        profile,
        fixed_tags,
        VisualAnswer {
            state: if theme.is_empty() {
                VisualState::Plain
            } else {
                VisualState::Clear
            },
            theme_ru: theme.to_owned(),
            description_ru: String::new(),
            tags: vec![],
        },
    )
}

fn assemble(
    profile: &ProductProfile,
    fixed_tags: &[String],
    answer: VisualAnswer,
) -> Result<OcrResult, OcrContractViolation> {
    // Administrative input caps are checked before purchase; the kernel checks final prose.
    if profile.product_type_ru.trim().is_empty()
        || [&profile.product_type_ru, &profile.facts_ru]
            .iter()
            .any(|text| contains_han(text) || text.chars().any(char::is_control))
    {
        return Err(OcrContractViolation::Profile);
    }
    validate_fixed_tags(fixed_tags).map_err(|_| OcrContractViolation::FixedTags)?;
    let theme = &answer.theme_ru;
    if answer.state != VisualState::Clear {
        if !theme.is_empty() {
            return Err(OcrContractViolation::Theme);
        }
        if answer.state == VisualState::Unclear {
            return Err(OcrContractViolation::Unclear);
        }
    } else {
        if theme.is_empty()
            || theme.trim() != theme
            || theme.split_whitespace().count() > 8
            || !theme
                .split([' ', '-'])
                .all(|word| !word.is_empty() && word.chars().all(cyr))
        {
            return Err(OcrContractViolation::Theme);
        }
        if unsupported_theme(theme) {
            return Err(OcrContractViolation::UnsupportedTheme);
        }
    }
    let theme = short_theme(theme).ok_or(OcrContractViolation::Theme)?;
    let base = profile.title_base();
    let ru = if answer.state == VisualState::Clear {
        format!("{base} \"{theme}\"")
    } else {
        base.clone()
    };
    if ru.chars().count() > PRODUCT_NAME_MAX_CHARS {
        return Err(OcrContractViolation::TitleTooLong);
    }
    let mut desc = base;
    let mut tags = vec![];
    if !answer.description_ru.is_empty() {
        if !desc.ends_with(['.', '!', '?']) {
            desc.push('.');
        }
        desc.push(' ');
        desc.push_str(&answer.description_ru);
    }
    for tag in answer.tags {
        if fixed_tags.len() + tags.len() == MAX_FIXED_TAGS {
            break;
        }
        if !fixed_tags.iter().any(|fixed| fixed.to_lowercase() == tag) {
            tags.push(tag);
        }
    }
    Ok(OcrResult {
        ru,
        tags,
        desc,
        candidates: vec![],
    })
}
