//! Platform banned-tag matching, copied from
//! `rust/crates/listing-core/src/banned_tags.rs` at xxww0098/podhub `a03d735`
//! (blob `bce8b013f6145742ad6db85c676802b2f49140aa`).
//!
//! Callers load the rule list; this module only decides whether a token is
//! banned. Do not "improve" the suffix table or the `ч` alternation here.

use unicode_normalization::UnicodeNormalization;

use crate::fold::fold_latin_lookalikes;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BannedTagMatch {
    Exact,
    Stem,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BannedTagRule {
    /// Already passed through [`normalize_tag_token`].
    pub term: String,
    pub mode: BannedTagMatch,
}

/// Longest first, so `ами` wins over `и`. One suffix only: a second pass would
/// eat the stem of a short word. The final `ь` is the soft sign a vowel ending
/// replaces (`испарителя`), not `ель` or `тель`.
const INFLECTION_SUFFIXES: &[&str] = &[
    "ами", "ями", "ого", "ему", "ыми", "ими", "ах", "ях", "ов", "ев", "ой", "ый", "ий", "ая", "яя",
    "ое", "ее", "ые", "ие", "ую", "юю", "ом", "ем", "ам", "ям", "а", "я", "ы", "и", "у", "ю", "е",
    "о", "ь",
];

pub fn normalize_tag_token(raw: &str) -> String {
    let nfkc: String = raw.nfkc().collect();
    let trimmed = nfkc.trim().trim_start_matches('#').trim();
    let folded = fold_latin_lookalikes(&trimmed.to_lowercase());
    fold_tag_separators(&folded)
}

/// Spaces and hyphens are the same separator as `_`, so
/// `электронная сигарета`, `электронная-сигарета`, and `электронная_сигарета`
/// share one token. A soft hyphen is deleted, not turned into a separator.
fn fold_tag_separators(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    let mut gap = false;
    for ch in input.chars() {
        if ch == '\u{00AD}' {
            continue;
        }
        if is_tag_separator(ch) {
            gap = !out.is_empty();
            continue;
        }
        if gap {
            out.push('_');
            gap = false;
        }
        out.push(ch);
    }
    out
}

fn is_tag_separator(ch: char) -> bool {
    ch.is_whitespace()
        || matches!(
            ch,
            '-' | '_' | '\u{2010}' | '\u{2011}' | '\u{2012}' | '\u{2013}' | '\u{2014}' | '\u{2212}'
        )
}

pub fn stem_key(normalized: &str) -> String {
    for suffix in INFLECTION_SUFFIXES {
        if let Some(stem) = normalized.strip_suffix(suffix)
            && stem.chars().count() >= 4
        {
            return stem.to_owned();
        }
    }
    normalized.to_owned()
}

pub fn tag_is_banned(raw: &str, rules: &[BannedTagRule]) -> bool {
    let token = normalize_tag_token(raw);
    if token.is_empty() {
        return false;
    }
    rules.iter().any(|rule| token_matches(&token, rule))
}

fn token_matches(token: &str, rule: &BannedTagRule) -> bool {
    match rule.mode {
        BannedTagMatch::Exact => token == rule.term,
        BannedTagMatch::Stem => {
            let stem = stem_key(&rule.term);
            if stem.chars().count() < 4 {
                return token == rule.term;
            }
            stem_covers(token, &stem)
        }
    }
}

/// Whole token, one `_` piece, or an adjacent window the same width as a
/// compound stem. The window is what makes `мини_электронная_сигарета` hit
/// `электронная_сигарет` without treating `электронная` alone as a hit.
fn stem_covers(token: &str, stem: &str) -> bool {
    if stem_prefix(token, stem) {
        return true;
    }
    // `табак` → `табачный`: a stem of at least five letters that ends in `к`
    // also matches the same stem with `ч`. Shorter stems stay put, so a
    // four-letter word such as `парк` does not reach `парча`.
    if stem.chars().count() >= 5
        && let Some(base) = stem.strip_suffix('к')
    {
        let alternate = format!("{base}ч");
        if stem_prefix(token, &alternate) {
            return true;
        }
    }
    false
}

fn stem_prefix(token: &str, stem: &str) -> bool {
    if token == stem || token.starts_with(stem) {
        return true;
    }
    let parts: Vec<&str> = token.split('_').filter(|part| !part.is_empty()).collect();
    if parts
        .iter()
        .any(|part| *part == stem || part.starts_with(stem))
    {
        return true;
    }
    let width = stem.split('_').filter(|part| !part.is_empty()).count();
    if width < 2 || parts.len() < width {
        return false;
    }
    parts.windows(width).any(|window| {
        let joined = window.join("_");
        joined == stem || joined.starts_with(stem)
    })
}

pub fn partition_tags(tags: &[String], rules: &[BannedTagRule]) -> (Vec<String>, Vec<String>) {
    let refs: Vec<&str> = tags.iter().map(String::as_str).collect();
    split_by_flags(&refs, &ban_flags(&refs, rules))
}

/// Space-separated tag text. The cleaned string keeps the surviving tokens.
/// Adjacent tokens are also judged together, so a compound term catches
/// `электронная сигарета` after the whitespace split.
pub fn strip_tag_text(text: &str, rules: &[BannedTagRule]) -> (String, Vec<String>) {
    let tokens: Vec<&str> = text.split_whitespace().collect();
    let (kept, rejected) = split_by_flags(&tokens, &ban_flags(&tokens, rules));
    (kept.join(" "), rejected)
}

fn split_by_flags(tokens: &[&str], flags: &[bool]) -> (Vec<String>, Vec<String>) {
    let mut kept = Vec::new();
    let mut rejected = Vec::new();
    for (token, banned) in tokens.iter().zip(flags) {
        if *banned {
            rejected.push((*token).to_owned());
        } else {
            kept.push((*token).to_owned());
        }
    }
    (kept, rejected)
}

fn ban_flags(tokens: &[&str], rules: &[BannedTagRule]) -> Vec<bool> {
    let mut flags: Vec<bool> = tokens
        .iter()
        .map(|token| tag_is_banned(token, rules))
        .collect();
    // A phrase stored as one term (`электронная_сигарета`) has to reject the
    // same words when a caller already split them on whitespace. Only terms
    // that contain `_` participate, so `роза сигарета` is not both rejected
    // just because the second word hits `сигарет`.
    for rule in rules {
        if !rule.term.contains('_') {
            continue;
        }
        let width = rule.term.split('_').filter(|part| !part.is_empty()).count();
        if width < 2 || tokens.len() < width {
            continue;
        }
        for start in 0..=tokens.len() - width {
            let joined = normalize_tag_token(&tokens[start..start + width].join(" "));
            if token_matches(&joined, rule) {
                for flag in &mut flags[start..start + width] {
                    *flag = true;
                }
            }
        }
    }
    flags
}

pub fn rejection_message(rejected: &[String]) -> String {
    format!("标签含受限词，不能保存：{}", rejected.join("、"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn stem_rule(term: &str) -> BannedTagRule {
        BannedTagRule {
            term: normalize_tag_token(term),
            mode: BannedTagMatch::Stem,
        }
    }

    #[test]
    fn cigarette_stem_covers_case_hash_inflection_and_lookalikes() {
        let rules = [stem_rule("сигарета")];
        for sample in [
            "#сигарета",
            "Сигарета",
            "сигареты",
            "сигаретный",
            "сигаретами",
            "сигаретная_пачка",
        ] {
            assert!(tag_is_banned(sample, &rules), "{sample}");
        }
        let lookalike = format!("#{c}игарета", c = 'c');
        assert!(tag_is_banned(&lookalike, &rules), "{lookalike}");
        let fullwidth = "\u{FF03}сигарета";
        assert!(tag_is_banned(fullwidth, &rules));
        assert!(!tag_is_banned("#роза", &rules));
        assert!(!tag_is_banned("#сигар", &rules));
    }

    #[test]
    fn exact_mode_does_not_match_an_inflection() {
        let rules = [BannedTagRule {
            term: normalize_tag_token("роза"),
            mode: BannedTagMatch::Exact,
        }];
        assert!(tag_is_banned("#Роза", &rules));
        assert!(!tag_is_banned("#розы", &rules));
    }

    #[test]
    fn strip_keeps_the_other_tags() {
        let rules = [stem_rule("сигарета")];
        let (kept, rejected) = strip_tag_text("#роза #сигареты #море", &rules);
        assert_eq!(kept, "#роза #море");
        assert_eq!(rejected, vec!["#сигареты".to_owned()]);
    }

    #[test]
    fn seeded_stems_do_not_shorten_past_the_lemma() {
        assert_eq!(stem_key("табак"), "табак");
        assert_eq!(stem_key("вейп"), "вейп");
        assert_eq!(stem_key("никотин"), "никотин");
        assert_eq!(stem_key("испаритель"), "испарител");
        assert_eq!(stem_key("электронная_сигарета"), "электронная_сигарет");
    }

    #[test]
    fn tobacco_stem_catches_inflection_and_the_snuffbox() {
        let rules = [stem_rule("табак")];
        for sample in ["#табак", "табака", "табачный", "табакерка"] {
            assert!(tag_is_banned(sample, &rules), "{sample}");
        }
        for sample in ["таблица", "табор", "табурет", "табель"] {
            assert!(!tag_is_banned(sample, &rules), "{sample}");
        }
        let park = [stem_rule("парк")];
        assert!(tag_is_banned("парка", &park));
        assert!(!tag_is_banned("парча", &park));
    }

    #[test]
    fn vape_stem_catches_inflection_not_nearby_words() {
        let rules = [stem_rule("вейп")];
        for sample in ["вейпы", "вейпа", "вейповый", "вейпинг", "вейп-мод"] {
            assert!(tag_is_banned(sample, &rules), "{sample}");
        }
        for sample in ["веер", "век", "веймар", "веер-век"] {
            assert!(!tag_is_banned(sample, &rules), "{sample}");
        }
    }

    #[test]
    fn nicotine_stem_keeps_in_and_skips_names() {
        let rules = [stem_rule("никотин")];
        for sample in ["никотина", "никотиновый"] {
            assert!(tag_is_banned(sample, &rules), "{sample}");
        }
        for sample in ["никон", "николай", "никонов"] {
            assert!(!tag_is_banned(sample, &rules), "{sample}");
        }
    }

    #[test]
    fn vaporizer_stem_drops_only_the_soft_sign() {
        let rules = [stem_rule("испаритель")];
        for sample in ["испарителя", "испарители", "испарителем", "испарительный"] {
            assert!(tag_is_banned(sample, &rules), "{sample}");
        }
        for sample in ["испарение", "испариться", "испарить", "искра"] {
            assert!(!tag_is_banned(sample, &rules), "{sample}");
        }
    }

    #[test]
    fn e_cigarette_stem_folds_space_underscore_and_hyphen() {
        let rules = [stem_rule("электронная_сигарета")];
        for sample in [
            "электронная_сигарета",
            "электронная-сигарета",
            "электронная сигарета",
            "электронная_сигареты",
            "электронная\u{2014}сигаретами",
            "мини_электронная_сигарета",
        ] {
            assert!(tag_is_banned(sample, &rules), "{sample}");
        }
        for sample in [
            "электронная",
            "электронная_книга",
            "электронная_сигара",
            "электронные_сигареты",
        ] {
            assert!(!tag_is_banned(sample, &rules), "{sample}");
        }
        let (kept, rejected) = strip_tag_text("роза электронная сигарета море", &rules);
        assert_eq!(kept, "роза море");
        assert_eq!(
            rejected,
            vec!["электронная".to_owned(), "сигарета".to_owned()]
        );
        let both = [stem_rule("электронная_сигарета"), stem_rule("сигарета")];
        assert!(tag_is_banned("электронные_сигареты", &both));
        assert!(tag_is_banned("электронные-сигареты", &both));
    }
}
