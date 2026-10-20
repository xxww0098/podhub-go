//! Latin/Cyrillic lookalike folding copied from
//! `rust/crates/listing-core/src/ocr_script.rs` at xxww0098/podhub `a03d735`
//! (blob `923d5cd13e061209f98e13fc59476a1f6c1408c5`).
//!
//! Only the functions `banned_tags::normalize_tag_token` calls are kept.
//! `i` and `I` stay unmapped, matching that file.

/// One Latin letter and the Cyrillic letter it stands in for.
const LOOKALIKES: &[(char, char)] = &[
    ('A', '\u{0410}'),
    ('a', '\u{0430}'),
    ('B', '\u{0412}'),
    ('b', '\u{042C}'),
    ('C', '\u{0421}'),
    ('c', '\u{0441}'),
    ('E', '\u{0415}'),
    ('e', '\u{0435}'),
    ('H', '\u{041D}'),
    ('h', '\u{043D}'),
    ('K', '\u{041A}'),
    ('k', '\u{043A}'),
    ('M', '\u{041C}'),
    ('m', '\u{043C}'),
    ('O', '\u{041E}'),
    ('o', '\u{043E}'),
    ('P', '\u{0420}'),
    ('p', '\u{0440}'),
    ('R', '\u{0413}'),
    ('r', '\u{0433}'),
    ('T', '\u{0422}'),
    ('t', '\u{0442}'),
    ('W', '\u{0428}'),
    ('w', '\u{0448}'),
    ('X', '\u{0425}'),
    ('x', '\u{0445}'),
    ('Y', '\u{0423}'),
    ('y', '\u{0443}'),
];

fn contains_mixed_script(text: &str) -> bool {
    let mut latin = false;
    let mut cyrillic = false;
    for ch in text.chars().chain(std::iter::once('\0')) {
        if is_latin(ch) {
            latin = true;
        } else if is_cyrillic(ch) {
            cyrillic = true;
        } else if latin && cyrillic {
            return true;
        } else {
            latin = false;
            cyrillic = false;
        }
    }
    false
}

/// Replace lookalikes inside a mixed word. A single-script token is kept.
pub(crate) fn fold_latin_lookalikes(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut word = String::new();
    for ch in text.chars().chain(std::iter::once('\0')) {
        if is_latin(ch) || is_cyrillic(ch) {
            word.push(ch);
            continue;
        }
        if !word.is_empty() {
            out.push_str(&fold_word(&word));
            word.clear();
        }
        if ch != '\0' {
            out.push(ch);
        }
    }
    out
}

fn fold_word(word: &str) -> String {
    if !contains_mixed_script(word) {
        return word.to_owned();
    }
    let latin_letters: Vec<char> = word.chars().filter(|ch| is_latin(*ch)).collect();
    let cyrillic_letters: Vec<char> = word.chars().filter(|ch| is_cyrillic(*ch)).collect();
    let latin_all_twins = latin_letters.iter().all(|ch| cyrillic_twin(*ch).is_some());
    if latin_all_twins {
        return word
            .chars()
            .map(|ch| cyrillic_twin(ch).unwrap_or(ch))
            .collect();
    }
    let cyrillic_all_twins = cyrillic_letters
        .iter()
        .all(|ch| latin_twin(*ch).is_some());
    if cyrillic_all_twins && cyrillic_letters.len() < latin_letters.len() {
        return word
            .chars()
            .map(|ch| latin_twin(ch).unwrap_or(ch))
            .collect();
    }
    word.chars()
        .map(|ch| cyrillic_twin(ch).unwrap_or(ch))
        .collect()
}

fn cyrillic_twin(ch: char) -> Option<char> {
    LOOKALIKES
        .iter()
        .copied()
        .find_map(|(latin, cyrillic)| (latin == ch).then_some(cyrillic))
}

fn latin_twin(ch: char) -> Option<char> {
    LOOKALIKES
        .iter()
        .copied()
        .find_map(|(latin, cyrillic)| (cyrillic == ch).then_some(latin))
}

fn is_latin(ch: char) -> bool {
    ch.is_ascii_alphabetic()
}

fn is_cyrillic(ch: char) -> bool {
    matches!(ch, '\u{0410}'..='\u{044F}' | '\u{0451}' | '\u{0401}')
}
