//! Fixed product-level field rules (`offer_id`, `name`, `barcode`, `price`,
//! dimensions) and the editor-driven rules every other field gets, plus the
//! value helpers they share with the orchestrator.

use super::issues::{FieldIssue, issue};
use crate::barcode::{is_supported_ozon_barcode, ozon_barcode_issue};
use crate::issue_keys::OzonValidateCode as Code;
use crate::records::{FieldAddress, ListingFieldEditor, RawDraftValue};

const OFFER_ID_MAX_LEN: usize = 50;
const OFFER_ID_SAFE: &str = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-";

pub fn contains_han(value: &str) -> bool {
    value.chars().any(|character| {
        matches!(
            character,
            '\u{2E80}'..='\u{2FFF}'
                | '\u{3005}'
                | '\u{3007}'
                | '\u{3021}'..='\u{3029}'
                | '\u{3038}'..='\u{303B}'
                | '\u{31C0}'..='\u{31E5}'
                | '\u{3400}'..='\u{4DBF}'
                | '\u{4E00}'..='\u{9FFF}'
                | '\u{F900}'..='\u{FAFF}'
                | '\u{20000}'..='\u{2FA1F}'
                | '\u{30000}'..='\u{3347F}'
        )
    })
}

pub(super) fn validate_name(value: &str, issues: &mut Vec<FieldIssue>) {
    if value.chars().count() > super::PRODUCT_NAME_MAX_CHARS {
        issues.push(issue(
            "name",
            Code::NameTooLong,
            format!("商品名称不能超过 {} 个字符", super::PRODUCT_NAME_MAX_CHARS),
            Some("缩短商品名称至 200 个字符以内后再校验".to_owned()),
        ));
    }
    if contains_han(value) {
        issues.push(issue(
            "name",
            Code::NameContainsHan,
            "商品名称不能包含中文字符".to_owned(),
            Some("将商品名称改为俄语后再校验".to_owned()),
        ));
    }
}

pub(super) fn validate_offer_id(value: &str, issues: &mut Vec<FieldIssue>) {
    if value.len() > OFFER_ID_MAX_LEN {
        issues.push(issue(
            "offer_id",
            Code::OfferIdTooLong,
            format!("offer_id 超过 {OFFER_ID_MAX_LEN} 字符"),
            Some("缩短 Offer ID 至 50 字符以内".to_owned()),
        ));
    }
    if !value.chars().all(|ch| OFFER_ID_SAFE.contains(ch)) {
        issues.push(issue(
            "offer_id",
            Code::OfferIdCharset,
            "offer_id 仅允许字母、数字、连字符和下划线".to_owned(),
            Some("将文件名/货号改为字母数字与 - _ 组合".to_owned()),
        ));
    }
}

pub(super) fn validate_barcode(value: &str, issues: &mut Vec<FieldIssue>) {
    if let Some(message) = ozon_barcode_issue(value) {
        issues.push(issue(
            "barcode",
            Code::InvalidBarcode,
            message.to_owned(),
            Some("留空由平台生成，或填写带正确校验位的 GTIN".to_owned()),
        ));
    } else if !is_supported_ozon_barcode(value) {
        issues.push(issue(
            "barcode",
            Code::InvalidBarcode,
            "条形码无效".to_owned(),
            Some("留空由平台生成，或填写带正确校验位的 GTIN".to_owned()),
        ));
    }
}

pub(super) fn validate_price(value: &str, issues: &mut Vec<FieldIssue>) {
    if !is_positive_decimal(value) {
        issues.push(issue(
            "price",
            Code::InvalidPrice,
            "价格必须是正数".to_owned(),
            Some("输入正数价格，例如 90 或 1990.50".to_owned()),
        ));
    }
}

pub(super) fn validate_positive_int(
    field_key: &str,
    label: &str,
    value: &str,
    issues: &mut Vec<FieldIssue>,
) {
    if parse_positive_u64(value).is_none() {
        issues.push(issue(
            field_key,
            Code::InvalidPositiveInteger,
            format!("{label} 必须是正整数"),
            Some(format!("将「{label}」改为大于 0 的整数")),
        ));
    }
}

pub(super) fn validate_by_editor(
    field: &crate::schema::ListingFieldDefinition,
    trimmed: &str,
    typed: Option<&RawDraftValue>,
    elements: Option<&[String]>,
    issues: &mut Vec<FieldIssue>,
    address: Option<&FieldAddress>,
) {
    let issue_start = issues.len();
    if let Some(elements) = elements
        && !matches!(
            field.editor,
            ListingFieldEditor::SingleSelect
                | ListingFieldEditor::MultiSelect
                | ListingFieldEditor::DictionarySearch
        )
    {
        let parts = elements
            .iter()
            .map(String::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .collect::<Vec<_>>();
        match field.editor {
            ListingFieldEditor::Text => {}
            ListingFieldEditor::Integer => {
                for element in &parts {
                    if !is_integer(element) {
                        issues.push(issue(
                            &field.key,
                            Code::InvalidInteger,
                            format!("{} 必须是整数", field.label),
                            Some(format!("将「{}」改为整数", field.label)),
                        ));
                    }
                }
            }
            ListingFieldEditor::Decimal => {
                for element in &parts {
                    if !is_decimal(element) {
                        issues.push(issue(
                            &field.key,
                            Code::InvalidDecimal,
                            format!("{} 必须是数字", field.label),
                            Some(format!("将「{}」改为数字", field.label)),
                        ));
                    }
                }
            }
            ListingFieldEditor::Boolean => {
                for element in &parts {
                    if !is_boolean(element) {
                        issues.push(issue(
                            &field.key,
                            Code::InvalidBoolean,
                            format!("{} 必须是是/否", field.label),
                            Some(format!("将「{}」改为 true/false 或 是/否", field.label)),
                        ));
                    }
                }
            }
            ListingFieldEditor::Url | ListingFieldEditor::UrlList => {
                for (index, element) in parts.iter().enumerate() {
                    if !field_url_ok(field, element) {
                        issues.push(issue(
                            &field.key,
                            Code::InvalidUrl,
                            format!("{} 第 {} 项必须是 http(s) URL", field.label, index + 1),
                            Some(format!("检查「{}」中的每一条 URL", field.label)),
                        ));
                    }
                }
            }
            ListingFieldEditor::SingleSelect
            | ListingFieldEditor::MultiSelect
            | ListingFieldEditor::DictionarySearch => {}
        }
        if let Some(address) = address {
            for field_issue in &mut issues[issue_start..] {
                field_issue.address = address.clone();
            }
        }
        return;
    }
    match field.editor {
        ListingFieldEditor::Text => {}
        ListingFieldEditor::Integer => {
            if !is_integer(trimmed) {
                issues.push(issue(
                    &field.key,
                    Code::InvalidInteger,
                    format!("{} 必须是整数", field.label),
                    Some(format!("将「{}」改为整数", field.label)),
                ));
            }
        }
        ListingFieldEditor::Decimal => {
            if !is_decimal(trimmed) {
                issues.push(issue(
                    &field.key,
                    Code::InvalidDecimal,
                    format!("{} 必须是数字", field.label),
                    Some(format!("将「{}」改为数字", field.label)),
                ));
            }
        }
        ListingFieldEditor::Boolean => {
            if !is_boolean(trimmed) {
                issues.push(issue(
                    &field.key,
                    Code::InvalidBoolean,
                    format!("{} 必须是是/否", field.label),
                    Some(format!("将「{}」改为 true/false 或 是/否", field.label)),
                ));
            }
        }
        ListingFieldEditor::Url => {
            if !field_url_ok(field, trimmed) {
                issues.push(issue(
                    &field.key,
                    Code::InvalidUrl,
                    format!("{} 必须是 http(s) URL", field.label),
                    Some(format!("将「{}」改为以 https:// 开头的地址", field.label)),
                ));
            }
        }
        ListingFieldEditor::UrlList => {
            let urls = typed
                .map(raw_text_parts)
                .unwrap_or_else(|| newline_elements(trimmed));
            for (index, url) in urls.iter().enumerate() {
                if !field_url_ok(field, url) {
                    issues.push(issue(
                        &field.key,
                        Code::InvalidUrl,
                        format!("{} 第 {} 项必须是 http(s) URL", field.label, index + 1),
                        Some(format!("检查「{}」中的每一条 URL", field.label)),
                    ));
                }
            }
        }
        ListingFieldEditor::SingleSelect
        | ListingFieldEditor::MultiSelect
        | ListingFieldEditor::DictionarySearch => {
            if field.constraints.collection {
                match typed {
                    Some(RawDraftValue::ManyChoices(choices))
                        if choices.iter().any(choice_has_content) => {}
                    Some(RawDraftValue::OneChoice(choice)) if choice_has_content(choice) => {}
                    Some(RawDraftValue::Text(value)) if !value.trim().is_empty() => {}
                    _ if !trimmed.is_empty() => {}
                    _ => {
                        issues.push(issue(
                            &field.key,
                            Code::InvalidChoice,
                            format!("{} 需要选择至少一个字典值", field.label),
                            Some(format!("从「{}」的选项中选择", field.label)),
                        ));
                    }
                }
            } else {
                match typed {
                    Some(RawDraftValue::OneChoice(choice)) if choice_has_content(choice) => {}
                    // Older drafts could encode one selected item as a one-element
                    // ManyChoices value. It is semantically still one choice.
                    Some(RawDraftValue::ManyChoices(choices))
                        if choices.len() == 1 && choices.iter().all(choice_has_content) => {}
                    Some(RawDraftValue::Text(value)) if !value.trim().is_empty() => {}
                    Some(RawDraftValue::ClearedChoice) | None if trimmed.is_empty() => {}
                    Some(RawDraftValue::ManyChoices(_)) => {
                        issues.push(issue(
                            &field.key,
                            Code::InvalidChoiceCardinality,
                            format!("{} 只能选择一个值", field.label),
                            Some(format!("将「{}」改为单选", field.label)),
                        ));
                    }
                    _ if !trimmed.is_empty() => {}
                    _ => {
                        issues.push(issue(
                            &field.key,
                            Code::InvalidChoice,
                            format!("{} 需要选择字典值", field.label),
                            Some(format!("从「{}」的选项中选择一项", field.label)),
                        ));
                    }
                }
            }
        }
    }
    if let Some(address) = address {
        for field_issue in &mut issues[issue_start..] {
            field_issue.address = address.clone();
        }
    }
}

fn choice_has_content(choice: &crate::records::ChoiceValue) -> bool {
    !choice.id.trim().is_empty() || !choice.label.trim().is_empty()
}

pub(super) fn element_count(
    elements: Option<&[String]>,
    raw: Option<&RawDraftValue>,
    text_present: bool,
) -> usize {
    if let Some(values) = elements {
        return values
            .iter()
            .filter(|value| !value.trim().is_empty())
            .count();
    }
    raw.map(raw_value_count)
        .unwrap_or_else(|| usize::from(text_present))
}

fn raw_value_count(raw: &RawDraftValue) -> usize {
    match raw {
        RawDraftValue::Text(value) => usize::from(!value.trim().is_empty()),
        RawDraftValue::OneChoice(choice) => {
            usize::from(!choice.id.trim().is_empty() || !choice.label.trim().is_empty())
        }
        RawDraftValue::ManyChoices(choices) => choices
            .iter()
            .filter(|choice| !choice.id.trim().is_empty() || !choice.label.trim().is_empty())
            .count(),
        RawDraftValue::ClearedChoice => 0,
    }
}

fn raw_text_parts(raw: &RawDraftValue) -> Vec<String> {
    match raw {
        RawDraftValue::Text(value) => newline_elements(value),
        RawDraftValue::OneChoice(choice) => {
            let label = choice.label.trim();
            if label.is_empty() {
                Vec::new()
            } else {
                vec![label.to_owned()]
            }
        }
        RawDraftValue::ManyChoices(choices) => choices
            .iter()
            .map(|choice| choice.label.trim())
            .filter(|value| !value.is_empty())
            .map(str::to_owned)
            .collect(),
        RawDraftValue::ClearedChoice => Vec::new(),
    }
}

fn newline_elements(value: &str) -> Vec<String> {
    crate::bridge::newline_elements(value)
}

fn is_integer(value: &str) -> bool {
    let value = value.trim();
    if value.is_empty() {
        return false;
    }
    let digits = value.strip_prefix('-').unwrap_or(value);
    !digits.is_empty() && digits.chars().all(|ch| ch.is_ascii_digit())
}

fn is_decimal(value: &str) -> bool {
    let value = value.trim();
    if value.is_empty() || value == "." || value == "-" || value == "-." {
        return false;
    }
    let mut parts = value.strip_prefix('-').unwrap_or(value).split('.');
    let Some(whole) = parts.next() else {
        return false;
    };
    if !whole.is_empty() && !whole.chars().all(|ch| ch.is_ascii_digit()) {
        return false;
    }
    match parts.next() {
        None => !whole.is_empty(),
        Some(fraction) => {
            parts.next().is_none()
                && !fraction.is_empty()
                && fraction.chars().all(|ch| ch.is_ascii_digit())
                && (!whole.is_empty() || !fraction.is_empty())
        }
    }
}

fn is_boolean(value: &str) -> bool {
    matches!(
        value.trim().to_ascii_lowercase().as_str(),
        "true" | "false" | "1" | "0" | "yes" | "no" | "是" | "否"
    )
}

fn is_http_url(value: &str) -> bool {
    let value = value.trim();
    (value.starts_with("https://") || value.starts_with("http://"))
        && value.len() > "https://".len()
}

fn is_https_url(value: &str) -> bool {
    let value = value.trim();
    value.starts_with("https://") && value.len() > "https://".len()
}

fn field_url_ok(field: &crate::schema::ListingFieldDefinition, value: &str) -> bool {
    let class = crate::projections::field_media_class(
        &field.key,
        field.attribute_id.as_deref().and_then(|id| id.parse().ok()),
        field.complex_id.as_deref().and_then(|id| id.parse().ok()),
    );
    if class == crate::projections::FieldMediaClass::Editable {
        is_https_url(value)
    } else {
        is_http_url(value)
    }
}

fn is_positive_decimal(value: &str) -> bool {
    if value.is_empty() || value.starts_with('+') || value.starts_with('-') {
        return false;
    }
    let mut parts = value.split('.');
    let Some(whole) = parts.next() else {
        return false;
    };
    if whole.is_empty() || !whole.chars().all(|ch| ch.is_ascii_digit()) {
        return false;
    }
    match parts.next() {
        None => value != "0" && !whole.chars().all(|ch| ch == '0'),
        Some(fraction) => {
            if parts.next().is_some()
                || fraction.is_empty()
                || !fraction.chars().all(|ch| ch.is_ascii_digit())
            {
                return false;
            }
            whole.chars().any(|ch| ch != '0') || fraction.chars().any(|ch| ch != '0')
        }
    }
}

pub(super) fn parse_positive_u64(value: &str) -> Option<u64> {
    if value.is_empty() || !value.chars().all(|ch| ch.is_ascii_digit()) {
        return None;
    }
    let parsed = value.parse::<u64>().ok()?;
    (parsed > 0).then_some(parsed)
}
