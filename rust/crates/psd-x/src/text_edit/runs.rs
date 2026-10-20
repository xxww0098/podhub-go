/*
File: rust/crates/psd-x/src/text_edit/runs.rs

Purpose:
Immediate UTF-16 run-length repair for text style / paragraph runs. Extends
the last run on growth (Photoshop), clamps/drops OOB runs on shrink — never
appends a base-style run. No upstream counterpart.

Source compatibility:
- no-upstream-counterpart
*/

use crate::psd::{ParagraphStyleRun, TextStyleRun};

/// UTF-16 code unit count (emoji astral chars = 2), matching EngineData lengths.
pub(super) fn utf16_len(text: &str) -> usize {
    text.encode_utf16().count()
}

pub(super) fn length_units(length: f64) -> usize {
    if !length.is_finite() || length <= 0.0 {
        0
    } else {
        length.round() as usize
    }
}

/// Replace the UTF-16 slice `[start, end)` with `replacement`.
///
/// Returns `None` when either boundary splits a surrogate pair.
pub(super) fn replace_utf16_range(
    text: &str,
    start: usize,
    end: usize,
    replacement: &str,
) -> Option<String> {
    let units: Vec<u16> = text.encode_utf16().collect();
    if start > end || end > units.len() {
        return None;
    }
    if !is_utf16_boundary(&units, start) || !is_utf16_boundary(&units, end) {
        return None;
    }
    let mut out =
        Vec::with_capacity(units.len().saturating_sub(end - start) + utf16_len(replacement));
    out.extend_from_slice(&units[..start]);
    out.extend(replacement.encode_utf16());
    out.extend_from_slice(&units[end..]);
    String::from_utf16(&out).ok()
}

/// Slice one run's text by UTF-16 offsets derived from run lengths.
pub(super) fn slice_utf16(text: &str, start: usize, end: usize) -> Option<String> {
    let units: Vec<u16> = text.encode_utf16().collect();
    if start > end || end > units.len() {
        return None;
    }
    if !is_utf16_boundary(&units, start) || !is_utf16_boundary(&units, end) {
        return None;
    }
    String::from_utf16(&units[start..end]).ok()
}

fn is_utf16_boundary(units: &[u16], index: usize) -> bool {
    index == 0
        || index == units.len()
        || !(matches!(units[index - 1], 0xD800..=0xDBFF) && matches!(units[index], 0xDC00..=0xDFFF))
}

/// Reflow style runs to `target_len` (UTF-16 units): clamp/drop OOB, extend last.
///
/// Writes lengths back so `sum(lengths) == target_len` (or runs become `None`
/// when `target_len == 0` / all dropped).
pub(super) fn reflow_style_runs(runs: &mut Option<Vec<TextStyleRun>>, target_len: usize) {
    let Some(list) = runs.as_mut() else {
        return;
    };
    if target_len == 0 || list.is_empty() {
        *runs = None;
        return;
    }

    let mut left = target_len;
    let mut out = Vec::with_capacity(list.len());
    let last = list.len() - 1;

    for (i, run) in list.iter().enumerate() {
        if left == 0 {
            break;
        }
        if i == last {
            // Photoshop: grow/shrink the last run to absorb remaining length.
            out.push(TextStyleRun {
                length: left as f64,
                style: run.style.clone(),
            });
            break;
        }

        let take = length_units(run.length).min(left);
        if take == 0 {
            continue;
        }
        out.push(TextStyleRun {
            length: take as f64,
            style: run.style.clone(),
        });
        left -= take;
    }

    if out.is_empty() {
        *runs = None;
    } else {
        *list = out;
    }
}

/// Same policy for paragraph style runs.
pub(super) fn reflow_paragraph_runs(runs: &mut Option<Vec<ParagraphStyleRun>>, target_len: usize) {
    let Some(list) = runs.as_mut() else {
        return;
    };
    if target_len == 0 || list.is_empty() {
        *runs = None;
        return;
    }

    let mut left = target_len;
    let mut out = Vec::with_capacity(list.len());
    let last = list.len() - 1;

    for (i, run) in list.iter().enumerate() {
        if left == 0 {
            break;
        }
        if i == last {
            out.push(ParagraphStyleRun {
                length: left as f64,
                style: run.style.clone(),
            });
            break;
        }

        let take = length_units(run.length).min(left);
        if take == 0 {
            continue;
        }
        out.push(ParagraphStyleRun {
            length: take as f64,
            style: run.style.clone(),
        });
        left -= take;
    }

    if out.is_empty() {
        *runs = None;
    } else {
        *list = out;
    }
}

pub(super) fn style_run_lengths_sum(runs: &[TextStyleRun]) -> usize {
    runs.iter().map(|r| length_units(r.length)).sum()
}

/// Drop zero-length style runs; `None` if none remain.
pub(super) fn compact_style_runs(runs: &mut Option<Vec<TextStyleRun>>) {
    let Some(list) = runs.as_mut() else {
        return;
    };
    list.retain(|r| length_units(r.length) > 0);
    if list.is_empty() {
        *runs = None;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::psd::TextStyle;

    fn run(len: f64, bold: bool) -> TextStyleRun {
        TextStyleRun {
            length: len,
            style: TextStyle {
                faux_bold: Some(bold),
                ..Default::default()
            },
        }
    }

    #[test]
    fn utf16_emoji_is_two_units() {
        assert_eq!(utf16_len("a"), 1);
        assert_eq!(utf16_len("😀"), 2);
        assert_eq!(utf16_len("a😀b"), 4);
    }

    #[test]
    fn reflow_extends_last_run_not_append() {
        let mut runs = Some(vec![run(2.0, false), run(3.0, true)]);
        reflow_style_runs(&mut runs, 10);
        let runs = runs.unwrap();
        assert_eq!(runs.len(), 2);
        assert_eq!(length_units(runs[0].length), 2);
        assert_eq!(length_units(runs[1].length), 8);
        assert_eq!(runs[1].style.faux_bold, Some(true));
        assert_eq!(style_run_lengths_sum(&runs), 10);
    }

    #[test]
    fn reflow_drops_oob_runs_on_shrink() {
        let mut runs = Some(vec![run(2.0, false), run(3.0, true), run(4.0, false)]);
        reflow_style_runs(&mut runs, 4);
        let runs = runs.unwrap();
        assert_eq!(runs.len(), 2);
        assert_eq!(length_units(runs[0].length), 2);
        assert_eq!(length_units(runs[1].length), 2);
        assert_eq!(runs[1].style.faux_bold, Some(true));
        assert_eq!(style_run_lengths_sum(&runs), 4);
    }

    #[test]
    fn reflow_empty_text_clears_runs() {
        let mut runs = Some(vec![run(2.0, false)]);
        reflow_style_runs(&mut runs, 0);
        assert!(runs.is_none());
    }

    #[test]
    fn replace_utf16_range_preserves_neighbors() {
        // "a😀b" = units [a, hi, lo, b]; replace the emoji (2 units) with "X".
        assert_eq!(utf16_len("a😀b"), 4);
        let s = replace_utf16_range("a😀b", 1, 3, "X").unwrap();
        assert_eq!(s, "aXb");
        assert_eq!(utf16_len(&s), 3);
    }

    #[test]
    fn rejects_run_boundaries_inside_surrogate_pair() {
        assert_eq!(slice_utf16("a😀b", 1, 2), None);
        assert_eq!(replace_utf16_range("a😀b", 1, 2, "X"), None);
        assert_eq!(slice_utf16("a", 0, 2), None);
        assert_eq!(replace_utf16_range("a", 0, 2, "X"), None);
    }
}
