//! Search-tag text, rewritten into the required form before the contract accepts it.
//!
//! The model intermittently separates tags with commas or periods, uses a
//! hyphen where the contract wants `_`, wraps a tag in quotes, or omits `#`.
//! Those are format, not a different set of words. This module rewrites only
//! that punctuation. It does not drop extra tags, truncate a long tag, or
//! invent a missing word. `ocr_contract::check` still refuses what remains.

use serde_json::Value;

use crate::ocr_script::fold_latin_lookalikes;

/// Tags from a `tags` string or array, in required `#word` / `#word_word` form.
pub(crate) fn decode_tags(value: &Value) -> Vec<String> {
    match value {
        Value::String(text) => decode_tag_text(text),
        Value::Array(items) => {
            let mut tags = Vec::new();
            for item in items {
                match item {
                    Value::String(tag) => tags.extend(decode_tag_text(tag)),
                    other => tags.extend(decode_tag_text(&other.to_string())),
                }
            }
            tags
        }
        _ => Vec::new(),
    }
}

fn decode_tag_text(text: &str) -> Vec<String> {
    text.split(is_separator)
        .filter_map(canonicalize_token)
        .collect()
}

fn is_separator(ch: char) -> bool {
    ch.is_whitespace()
        || matches!(
            ch,
            ',' | ';' | '.' | '!' | '?' | '…' | '。' | '，' | '；' | '、'
        )
}

fn canonicalize_token(token: &str) -> Option<String> {
    let trimmed = token.trim();
    if trimmed.is_empty() {
        return None;
    }
    let unquoted = strip_wrapping_quotes(trimmed);
    let cleaned = strip_edge_marks(unquoted);
    if cleaned.is_empty() {
        return None;
    }
    let mapped: String = cleaned
        .chars()
        .filter_map(|ch| match ch {
            '\u{00ad}' | '\u{200b}' | '\u{200c}' | '\u{200d}' | '\u{feff}' => None,
            '-' | '\u{2010}' | '\u{2011}' | '\u{2013}' | '\u{2014}' | '\u{2212}' | '－' => {
                Some('_')
            }
            '＃' => Some('#'),
            other => Some(other),
        })
        .collect();
    let body = collapse_underscores(&mapped);
    let body = body.trim_matches('#').trim_matches('_');
    let body = collapse_underscores(body);
    let body = body.trim_matches('_');
    if body.is_empty() {
        return None;
    }
    let folded = fold_latin_lookalikes(&format!("#{body}"));
    Some(if folded.starts_with('#') {
        folded
    } else {
        format!("#{folded}")
    })
}

fn strip_wrapping_quotes(text: &str) -> &str {
    let mut text = text.trim();
    loop {
        let next = text
            .trim()
            .trim_matches(|ch| matches!(ch, '"' | '\'' | '`' | '«' | '»' | '“' | '”' | '„'))
            .trim();
        if next.len() == text.len() {
            break;
        }
        text = next;
    }
    text
}

fn strip_edge_marks(text: &str) -> &str {
    text.trim().trim_matches(|ch: char| {
        matches!(
            ch,
            ':' | '·' | '•' | '|' | '(' | ')' | '[' | ']' | '{' | '}'
        )
    })
}

fn collapse_underscores(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut previous = false;
    for ch in text.chars() {
        if ch == '_' {
            if !previous {
                out.push('_');
            }
            previous = true;
        } else {
            previous = false;
            out.push(ch);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn punctuation_hyphen_and_a_missing_hash_become_the_required_form() {
        let five = "#горы #озеро #закат #сосны #отражение";
        for raw in [
            json!("#горы, #озеро, #закат, #сосны, #отражение"),
            json!("#горы,#озеро,#закат,#сосны,#отражение"),
            json!("#горы. #озеро. #закат. #сосны. #отражение."),
            json!("\"#горы\" \"#озеро\" \"#закат\" \"#сосны\" \"#отражение\""),
            json!("горы озеро закат сосны отражение"),
            json!(["#горы,", "#озеро", "#закат", "#сосны", "#отражение"]),
        ] {
            assert_eq!(decode_tags(&raw).join(" "), five, "{raw}");
        }
        assert_eq!(
            decode_tags(&json!("#чёрно-белый #озеро #закат #сосны #отражение")),
            vec!["#чёрно_белый", "#озеро", "#закат", "#сосны", "#отражение",]
        );
        assert_eq!(
            decode_tags(&json!(
                "#\u{0433}\u{006f}\u{0440}\u{044b}, #озеро, #закат, #сосны, #отражение"
            )),
            five.split_whitespace()
                .map(str::to_owned)
                .collect::<Vec<_>>()
        );
    }

    #[test]
    fn decode_keeps_a_tag_that_still_breaks_the_contract() {
        assert_eq!(
            decode_tags(&json!("#iPhone #озеро #закат #сосны #отражение")),
            vec!["#iPhone", "#озеро", "#закат", "#сосны", "#отражение"]
        );
        assert_eq!(decode_tags(&json!("#горы #озеро")).len(), 2);
        assert_eq!(
            decode_tags(&json!("#горы #озеро #закат #сосны #отражение #лишний")).len(),
            6
        );
        assert_eq!(decode_tags(&json!(null)), Vec::<String>::new());
    }

    #[test]
    fn canonical_tags_do_not_change_when_decoded_again() {
        let once = decode_tags(&json!("#горы, #чёрно-белый. \"сосны\""));
        let again = decode_tags(&json!(once.join(" ")));
        assert_eq!(again, once);
        assert_eq!(once, vec!["#горы", "#чёрно_белый", "#сосны"]);
    }
}
