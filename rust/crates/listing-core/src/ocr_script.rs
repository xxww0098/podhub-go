//! Latin and Cyrillic letters inside one word.
//!
//! A whole Latin token such as `iPhone` stays legal. Inside a mixed word, Latin
//! letters fold to Cyrillic when every one of them is a lookalike (`oзepa` →
//! `озера`). Otherwise, Cyrillic letters fold to Latin only when each of them
//! is a lookalike and there are fewer of them (`iPhоne` → `iPhone`). Anything
//! still mixed is a residue. Digits and punctuation split words, so `40х50`
//! is not mixed. `i` and `I` are not Russian lookalikes and are not folded.

/// One Latin letter and the Cyrillic letter it stands in for.
///
/// The pairs are the Unicode confusable singles between ASCII and the Russian
/// alphabet, plus the case pairs this table already folded (`h/н`, `k/к`,
/// `m/м`, `t/т`) and the same case step for `r/г` and `w/ш`. `i`/`I` are
/// absent on purpose: they are not those confusables, and folding them would
/// invent a different Russian word.
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

/// Words that stay mixed after folding, and the letters the map could not replace.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct ScriptResidue {
    /// Original slices, including a leading `#` on a tag.
    pub spans: Vec<String>,
    /// Intruder letters in first-seen order, separated by commas.
    pub pattern: String,
}

impl ScriptResidue {
    pub fn is_empty(&self) -> bool {
        self.spans.is_empty()
    }

    pub fn merge(&mut self, other: ScriptResidue) {
        for span in other.spans {
            if !self.spans.contains(&span) {
                self.spans.push(span);
            }
        }
        if other.pattern.is_empty() {
            return;
        }
        for letter in other.pattern.split(',') {
            if letter.is_empty() || self.pattern.split(',').any(|have| have == letter) {
                continue;
            }
            if !self.pattern.is_empty() {
                self.pattern.push(',');
            }
            self.pattern.push_str(letter);
        }
    }
}

pub fn contains_mixed_script(text: &str) -> bool {
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
pub fn fold_latin_lookalikes(text: &str) -> String {
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

/// Original fragments that stay mixed after [`fold_latin_lookalikes`].
pub fn script_residue(text: &str) -> ScriptResidue {
    let mut residue = ScriptResidue::default();
    visit_words(text, |hash, word| {
        let folded = fold_word(word);
        if !contains_mixed_script(&folded) {
            return;
        }
        let mut span = String::new();
        if hash {
            span.push('#');
        }
        span.push_str(word);
        if !residue.spans.contains(&span) {
            residue.spans.push(span);
        }
        for letter in intruder_letters(&folded) {
            let token = letter.to_string();
            if residue.pattern.split(',').any(|have| have == token) {
                continue;
            }
            if !residue.pattern.is_empty() {
                residue.pattern.push(',');
            }
            residue.pattern.push(letter);
        }
    });
    residue
}

pub fn script_residue_fields(parts: &[&str]) -> ScriptResidue {
    let mut residue = ScriptResidue::default();
    for part in parts {
        residue.merge(script_residue(part));
    }
    residue
}

/// Letter-runs. `hash` is true when `#` is the character immediately before
/// the run, so a tag can be quoted with its marker.
fn visit_words(text: &str, mut visit: impl FnMut(bool, &str)) {
    let mut word = String::new();
    let mut hash = false;
    for ch in text.chars().chain(std::iter::once('\0')) {
        if is_latin(ch) || is_cyrillic(ch) {
            word.push(ch);
            continue;
        }
        if !word.is_empty() {
            visit(hash, &word);
            word.clear();
        }
        hash = ch == '#';
    }
}

fn fold_word(word: &str) -> String {
    if !contains_mixed_script(word) {
        return word.to_owned();
    }
    let latin_letters: Vec<char> = word.chars().filter(|ch| is_latin(*ch)).collect();
    let cyrillic_letters: Vec<char> = word.chars().filter(|ch| is_cyrillic(*ch)).collect();
    let latin_all_twins = latin_letters.iter().all(|ch| cyrillic_twin(*ch).is_some());
    // A Russian word may be written almost entirely with Latin lookalikes
    // (`oзepa`). Those fold to Cyrillic even when the Latin letters are more.
    if latin_all_twins {
        return word
            .chars()
            .map(|ch| cyrillic_twin(ch).unwrap_or(ch))
            .collect();
    }
    let cyrillic_all_twins = cyrillic_letters.iter().all(|ch| latin_twin(*ch).is_some());
    // A Latin word with a stray Cyrillic twin (`iPhоne`, `Postеr`).
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

fn script_counts(word: &str) -> (usize, usize) {
    let mut latin = 0;
    let mut cyrillic = 0;
    for ch in word.chars() {
        if is_latin(ch) {
            latin += 1;
        } else if is_cyrillic(ch) {
            cyrillic += 1;
        }
    }
    (latin, cyrillic)
}

fn intruder_letters(folded: &str) -> Vec<char> {
    let (latin, cyrillic) = script_counts(folded);
    if latin == 0 || cyrillic == 0 {
        return Vec::new();
    }
    let latin_intrudes = latin <= cyrillic;
    folded
        .chars()
        .filter(|ch| {
            if latin_intrudes {
                is_latin(*ch)
            } else {
                is_cyrillic(*ch)
            }
        })
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_map_covers_the_unicode_russian_confusables_and_keeps_i_unmapped() {
        let official = [
            ('A', '\u{0410}'),
            ('a', '\u{0430}'),
            ('B', '\u{0412}'),
            ('b', '\u{042C}'),
            ('C', '\u{0421}'),
            ('c', '\u{0441}'),
            ('E', '\u{0415}'),
            ('e', '\u{0435}'),
            ('H', '\u{041D}'),
            ('K', '\u{041A}'),
            ('M', '\u{041C}'),
            ('O', '\u{041E}'),
            ('o', '\u{043E}'),
            ('P', '\u{0420}'),
            ('p', '\u{0440}'),
            ('T', '\u{0422}'),
            ('X', '\u{0425}'),
            ('x', '\u{0445}'),
            ('Y', '\u{0423}'),
            ('y', '\u{0443}'),
            ('r', '\u{0433}'),
            ('w', '\u{0448}'),
        ];
        for (latin, cyrillic) in official {
            assert_eq!(cyrillic_twin(latin), Some(cyrillic), "{latin}");
            assert_eq!(latin_twin(cyrillic), Some(latin), "{cyrillic}");
        }
        for (latin, cyrillic) in [
            ('h', '\u{043D}'),
            ('k', '\u{043A}'),
            ('m', '\u{043C}'),
            ('t', '\u{0442}'),
            ('R', '\u{0413}'),
            ('W', '\u{0428}'),
        ] {
            assert_eq!(cyrillic_twin(latin), Some(cyrillic));
            assert_eq!(latin_twin(cyrillic), Some(latin));
        }
        assert_eq!(cyrillic_twin('i'), None);
        assert_eq!(cyrillic_twin('I'), None);
        assert_eq!(LOOKALIKES.len(), 28);
        let mut targets: Vec<char> = LOOKALIKES.iter().map(|(_, cyrillic)| *cyrillic).collect();
        targets.sort();
        targets.dedup();
        assert_eq!(targets.len(), LOOKALIKES.len());
    }

    #[test]
    fn completed_lookalikes_fold_and_a_twin_inside_a_latin_word_folds_back() {
        let gory = format!("r{}", "\u{043e}\u{0440}\u{044b}");
        let cat = format!("\u{043a}\u{043e}w\u{043a}\u{0430}");
        let day = format!("\u{0434}\u{0435}\u{043d}b");
        let phone = format!("iPh{}ne", '\u{043e}');
        let folded = fold_latin_lookalikes(&format!("Чехол {gory} {cat} {day} {phone}"));
        assert_eq!(folded, "Чехол горы кошка денЬ iPhone");
        assert!(!contains_mixed_script(&folded), "{folded}");
        assert_eq!(folded, fold_latin_lookalikes(&folded));
        assert_eq!(
            fold_latin_lookalikes("Чехол iPhone 17 Pro Max 40x50"),
            "Чехол iPhone 17 Pro Max 40x50"
        );
        assert_eq!(fold_latin_lookalikes("40х50"), "40х50");
    }

    #[test]
    fn an_unmapped_latin_letter_stays_and_is_named() {
        let word = format!("кип{}рис", 'i');
        let folded = fold_latin_lookalikes(&word);
        assert!(contains_mixed_script(&folded), "{folded}");
        assert!(folded.contains('i'));
        let residue = script_residue(&format!("#{word}"));
        assert_eq!(residue.spans, vec![format!("#{word}")]);
        assert_eq!(residue.pattern, "i");
        let tag = format!("#cip{}", "\u{0440}\u{0435}\u{0441}\u{0441}");
        let residue = script_residue(&tag);
        assert_eq!(residue.spans, vec![tag]);
        assert_eq!(residue.pattern, "i");
        assert!(script_residue("кипарис").is_empty());
    }
}
