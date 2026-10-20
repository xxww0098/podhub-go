/*
File: rust/crates/psd-x/src/engine_data2.rs

Purpose:
Engine Data v2 variant (alternative/structural representation of text data).

Source compatibility:
- port of upstream ag-psd `src/engineData2.ts` (1:1 split).

Main responsibilities:
- mirror the corresponding upstream module while porting;
- keep this area's public contract in one place.

Mapping TS -> Rust:
- `decodeEngineData2(data)` -> `decode_engine_data2(data: &EngineValue) -> Result<EngineValue, EngineDataError>`
- internal `decodeObj`     -> `decode_obj(obj, keys, depth) -> Result<...>`
- key-rename dictionaries (`keysRoot`, `keysStyleSheet`, ...) -> statically
  built `KeysDict` (lazy via `OnceLock`).

Model:
Upstream `decodeObj` takes untyped parsed EngineData (numeric keys)
and renames keys via a `KeysDict`, optionally "uprooting" a nested
node one level up and setting `_type` from key `99`. Here input and output are
`crate::engine_data::EngineValue`; the result has renamed `Dict` keys,
and `_type` is written as a normal `"_type"` key.

The TS type `GlobalEngineData` is a loose structure (`any`/TODO upstream), so
there is no type-safe wrapper: `decode_engine_data2` returns `EngineValue`.
*/

use crate::engine_data::{EngineDataError, EngineValue};
use crate::reader::DEFAULT_MAX_RECURSION_DEPTH;
use std::collections::HashMap;
use std::sync::OnceLock;

/// Entry in the key-rename dictionary (mirror of `KeysDict[key]`).
#[derive(Debug, Clone, Default)]
pub struct KeyEntry {
    pub name: Option<&'static str>,
    pub uproot: bool,
    pub children: Option<KeysDict>,
}

/// Rename dictionary: EngineData key -> rule (`KeysDict`).
pub type KeysDict = HashMap<&'static str, KeyEntry>;

fn entry_name(name: &'static str) -> KeyEntry {
    KeyEntry {
        name: Some(name),
        uproot: false,
        children: None,
    }
}

fn entry(name: Option<&'static str>, uproot: bool, children: Option<KeysDict>) -> KeyEntry {
    KeyEntry {
        name,
        uproot,
        children,
    }
}

fn dict(pairs: Vec<(&'static str, KeyEntry)>) -> KeysDict {
    pairs.into_iter().collect()
}

fn keys_color() -> KeysDict {
    dict(vec![(
        "0",
        entry(
            None,
            true,
            Some(dict(vec![
                ("0", entry_name("Type")),
                ("1", entry_name("Values")),
            ])),
        ),
    )])
}

fn keys_style_sheet() -> KeysDict {
    dict(vec![
        ("0", entry_name("Font")),
        ("1", entry_name("FontSize")),
        ("2", entry_name("FauxBold")),
        ("3", entry_name("FauxItalic")),
        ("4", entry_name("AutoLeading")),
        ("5", entry_name("Leading")),
        ("6", entry_name("HorizontalScale")),
        ("7", entry_name("VerticalScale")),
        ("8", entry_name("Tracking")),
        ("9", entry_name("BaselineShift")),
        ("11", entry_name("Kerning?")),
        ("12", entry_name("FontCaps")),
        ("13", entry_name("FontBaseline")),
        ("15", entry_name("Strikethrough?")),
        ("16", entry_name("Underline?")),
        ("18", entry_name("Ligatures")),
        ("19", entry_name("DLigatures")),
        ("23", entry_name("Fractions")),
        ("24", entry_name("Ordinals")),
        ("28", entry_name("StylisticAlternates")),
        ("30", entry_name("OldStyle?")),
        ("35", entry_name("BaselineDirection")),
        ("38", entry_name("Language")),
        ("52", entry_name("NoBreak")),
        ("53", entry(Some("FillColor"), false, Some(keys_color()))),
        ("54", entry(Some("StrokeColor"), false, Some(keys_color()))),
        (
            "55",
            entry(
                None,
                false,
                Some(dict(vec![("99", entry(None, true, None))])),
            ),
        ),
        ("79", entry(None, false, Some(keys_color()))),
    ])
}

fn keys_paragraph() -> KeysDict {
    dict(vec![
        ("0", entry_name("Justification")),
        ("1", entry_name("FirstLineIndent")),
        ("2", entry_name("StartIndent")),
        ("3", entry_name("EndIndent")),
        ("4", entry_name("SpaceBefore")),
        ("5", entry_name("SpaceAfter")),
        ("7", entry_name("AutoLeading")),
        ("9", entry_name("AutoHyphenate")),
        ("10", entry_name("HyphenatedWordSize")),
        ("11", entry_name("PreHyphen")),
        ("12", entry_name("PostHyphen")),
        ("13", entry_name("ConsecutiveHyphens?")),
        ("14", entry_name("Zone")),
        ("15", entry_name("HypenateCapitalizedWords")),
        ("17", entry_name("WordSpacing")),
        ("18", entry_name("LetterSpacing")),
        ("19", entry_name("GlyphSpacing")),
        (
            "32",
            entry(Some("StyleSheet"), false, Some(keys_style_sheet())),
        ),
    ])
}

fn keys_style_sheet_data() -> KeyEntry {
    entry(Some("StyleSheetData"), false, Some(keys_style_sheet()))
}

fn keys_root() -> KeysDict {
    dict(vec![
        (
            "0",
            entry(
                Some("ResourceDict"),
                false,
                Some(dict(vec![
                    (
                        "1",
                        entry(
                            Some("FontSet"),
                            false,
                            Some(dict(vec![(
                                "0",
                                entry(
                                    None,
                                    true,
                                    Some(dict(vec![(
                                        "0",
                                        entry(
                                            None,
                                            true,
                                            Some(dict(vec![(
                                                "0",
                                                entry(
                                                    None,
                                                    true,
                                                    Some(dict(vec![
                                                        ("0", entry_name("Name")),
                                                        ("2", entry_name("FontType")),
                                                    ])),
                                                ),
                                            )])),
                                        ),
                                    )])),
                                ),
                            )])),
                        ),
                    ),
                    ("2", entry(Some("2"), false, Some(dict(vec![])))),
                    (
                        "3",
                        entry(
                            Some("MojiKumiSet"),
                            false,
                            Some(dict(vec![(
                                "0",
                                entry(
                                    None,
                                    true,
                                    Some(dict(vec![(
                                        "0",
                                        entry(
                                            None,
                                            true,
                                            Some(dict(vec![("0", entry_name("InternalName"))])),
                                        ),
                                    )])),
                                ),
                            )])),
                        ),
                    ),
                    (
                        "4",
                        entry(
                            Some("KinsokuSet"),
                            false,
                            Some(dict(vec![(
                                "0",
                                entry(
                                    None,
                                    true,
                                    Some(dict(vec![(
                                        "0",
                                        entry(
                                            None,
                                            true,
                                            Some(dict(vec![
                                                ("0", entry_name("Name")),
                                                (
                                                    "5",
                                                    entry(
                                                        None,
                                                        true,
                                                        Some(dict(vec![
                                                            ("0", entry_name("NoStart")),
                                                            ("1", entry_name("NoEnd")),
                                                            ("2", entry_name("Keep")),
                                                            ("3", entry_name("Hanging")),
                                                            ("4", entry_name("Name")),
                                                        ])),
                                                    ),
                                                ),
                                            ])),
                                        ),
                                    )])),
                                ),
                            )])),
                        ),
                    ),
                    (
                        "5",
                        entry(
                            Some("StyleSheetSet"),
                            false,
                            Some(dict(vec![(
                                "0",
                                entry(
                                    None,
                                    true,
                                    Some(dict(vec![(
                                        "0",
                                        entry(
                                            None,
                                            true,
                                            Some(dict(vec![
                                                ("0", entry_name("Name")),
                                                ("6", keys_style_sheet_data()),
                                            ])),
                                        ),
                                    )])),
                                ),
                            )])),
                        ),
                    ),
                    (
                        "6",
                        entry(
                            Some("ParagraphSheetSet"),
                            false,
                            Some(dict(vec![(
                                "0",
                                entry(
                                    None,
                                    true,
                                    Some(dict(vec![(
                                        "0",
                                        entry(
                                            None,
                                            true,
                                            Some(dict(vec![
                                                ("0", entry_name("Name")),
                                                (
                                                    "5",
                                                    entry(
                                                        Some("Properties"),
                                                        false,
                                                        Some(keys_paragraph()),
                                                    ),
                                                ),
                                                ("6", entry_name("DefaultStyleSheet")),
                                            ])),
                                        ),
                                    )])),
                                ),
                            )])),
                        ),
                    ),
                    (
                        "8",
                        entry(
                            Some("TextFrameSet"),
                            false,
                            Some(dict(vec![(
                                "0",
                                entry(
                                    None,
                                    true,
                                    Some(dict(vec![(
                                        "0",
                                        entry(
                                            Some("path"),
                                            false,
                                            Some(dict(vec![
                                                ("0", entry_name("name")),
                                                (
                                                    "1",
                                                    entry(
                                                        Some("bezierCurve"),
                                                        false,
                                                        Some(dict(vec![(
                                                            "0",
                                                            entry_name("controlPoints"),
                                                        )])),
                                                    ),
                                                ),
                                                (
                                                    "2",
                                                    entry(
                                                        Some("data"),
                                                        false,
                                                        Some(dict(vec![
                                                            ("0", entry_name("type")),
                                                            ("1", entry_name("orientation")),
                                                            ("2", entry_name("frameMatrix")),
                                                            ("4", entry_name("4")),
                                                            ("6", entry_name("textRange")),
                                                            ("7", entry_name("rowGutter")),
                                                            ("8", entry_name("columnGutter")),
                                                            ("9", entry_name("9")),
                                                            (
                                                                "10",
                                                                entry(
                                                                    Some("baselineAlignment"),
                                                                    false,
                                                                    Some(dict(vec![
                                                                        ("0", entry_name("flag")),
                                                                        ("1", entry_name("min")),
                                                                    ])),
                                                                ),
                                                            ),
                                                            (
                                                                "11",
                                                                entry(
                                                                    Some("pathData"),
                                                                    false,
                                                                    Some(dict(vec![
                                                                        ("1", entry_name("1")),
                                                                        ("0", entry_name("reversed")),
                                                                        ("2", entry_name("2")),
                                                                        ("3", entry_name("3")),
                                                                        ("4", entry_name("spacing")),
                                                                        ("5", entry_name("5")),
                                                                        ("6", entry_name("6")),
                                                                        ("7", entry_name("7")),
                                                                        ("18", entry_name("18")),
                                                                    ])),
                                                                ),
                                                            ),
                                                            ("12", entry_name("12")),
                                                            ("13", entry_name("13")),
                                                        ])),
                                                    ),
                                                ),
                                                ("3", entry_name("3")),
                                                ("97", entry_name("uuid")),
                                            ])),
                                        ),
                                    )])),
                                ),
                            )])),
                        ),
                    ),
                    (
                        "9",
                        entry(
                            Some("Predefined"),
                            false,
                            Some(dict(vec![
                                (
                                    "0",
                                    entry(
                                        None,
                                        false,
                                        Some(dict(vec![("0", entry(None, true, None))])),
                                    ),
                                ),
                                (
                                    "1",
                                    entry(
                                        None,
                                        false,
                                        Some(dict(vec![("0", entry(None, true, None))])),
                                    ),
                                ),
                            ])),
                        ),
                    ),
                ])),
            ),
        ),
        (
            "1",
            entry(
                Some("EngineDict"),
                false,
                Some(dict(vec![
                    (
                        "0",
                        entry(
                            Some("0"),
                            false,
                            Some(dict(vec![
                                ("3", entry_name("SuperscriptSize")),
                                ("4", entry_name("SuperscriptPosition")),
                                ("5", entry_name("SubscriptSize")),
                                ("6", entry_name("SubscriptPosition")),
                                ("7", entry_name("SmallCapSize")),
                                ("8", entry_name("UseFractionalGlyphWidths")),
                                (
                                    "15",
                                    entry(
                                        None,
                                        false,
                                        Some(dict(vec![("0", entry(None, true, None))])),
                                    ),
                                ),
                            ])),
                        ),
                    ),
                    (
                        "1",
                        entry(
                            Some("Editors?"),
                            false,
                            Some(dict(vec![
                                (
                                    "0",
                                    entry(
                                        Some("Editor"),
                                        false,
                                        Some(dict(vec![
                                            ("0", entry_name("Text")),
                                            (
                                                "5",
                                                entry(
                                                    Some("ParagraphRun"),
                                                    false,
                                                    Some(dict(vec![(
                                                        "0",
                                                        entry(
                                                            Some("RunArray"),
                                                            false,
                                                            Some(dict(vec![
                                                                (
                                                                    "0",
                                                                    entry(
                                                                        Some("ParagraphSheet"),
                                                                        false,
                                                                        Some(dict(vec![(
                                                                            "0",
                                                                            entry(
                                                                                None,
                                                                                true,
                                                                                Some(dict(vec![
                                                                                    ("0", entry_name("0")),
                                                                                    (
                                                                                        "5",
                                                                                        entry(
                                                                                            Some("5"),
                                                                                            false,
                                                                                            Some(keys_paragraph()),
                                                                                        ),
                                                                                    ),
                                                                                    ("6", entry_name("6")),
                                                                                ])),
                                                                            ),
                                                                        )])),
                                                                    ),
                                                                ),
                                                                ("1", entry_name("RunLength")),
                                                            ])),
                                                        ),
                                                    )])),
                                                ),
                                            ),
                                            (
                                                "6",
                                                entry(
                                                    Some("StyleRun"),
                                                    false,
                                                    Some(dict(vec![(
                                                        "0",
                                                        entry(
                                                            Some("RunArray"),
                                                            false,
                                                            Some(dict(vec![
                                                                (
                                                                    "0",
                                                                    entry(
                                                                        Some("StyleSheet"),
                                                                        false,
                                                                        Some(dict(vec![(
                                                                            "0",
                                                                            entry(
                                                                                None,
                                                                                true,
                                                                                Some(dict(vec![(
                                                                                    "6",
                                                                                    keys_style_sheet_data(),
                                                                                )])),
                                                                            ),
                                                                        )])),
                                                                    ),
                                                                ),
                                                                ("1", entry_name("RunLength")),
                                                            ])),
                                                        ),
                                                    )])),
                                                ),
                                            ),
                                        ])),
                                    ),
                                ),
                                ("1", entry_name("FontVectorData ???")),
                            ])),
                        ),
                    ),
                    ("2", entry(Some("StyleSheet"), false, Some(keys_style_sheet()))),
                    ("3", entry(Some("ParagraphSheet"), false, Some(keys_paragraph()))),
                ])),
            ),
        ),
    ])
}

fn keys_root_static() -> &'static KeysDict {
    static ROOT: OnceLock<KeysDict> = OnceLock::new();
    ROOT.get_or_init(keys_root)
}

static EMPTY_KEYS: OnceLock<KeysDict> = OnceLock::new();

fn empty_keys() -> &'static KeysDict {
    EMPTY_KEYS.get_or_init(HashMap::new)
}

// Mirror of `decodeObj`. Renames keys via `keys`, handles uproot and `_type`.
fn decode_obj(
    obj: &EngineValue,
    keys: &KeysDict,
    depth: u32,
    max_depth: u32,
) -> Result<EngineValue, EngineDataError> {
    if depth >= max_depth {
        return Err(EngineDataError(
            "Exceeded recursion depth limit".to_string(),
        ));
    }
    match obj {
        EngineValue::Null => Ok(EngineValue::Null),
        EngineValue::Array(arr) => {
            let mut out = Vec::with_capacity(arr.len());
            for x in arr {
                out.push(decode_obj(x, keys, depth + 1, max_depth)?);
            }
            Ok(EngineValue::Array(out))
        }
        // typeof obj !== 'object' -> return as-is (numbers, bools, strings).
        EngineValue::Number(_) | EngineValue::Bool(_) | EngineValue::Str(_) => Ok(obj.clone()),
        EngineValue::Dict(map) => {
            let mut result: Vec<(String, EngineValue)> = Vec::new();
            let mut positions = HashMap::new();

            for (key, value) in map {
                if let Some(entry) = keys.get(key.as_str()) {
                    if entry.uproot {
                        // Upstream: `result = decodeObj(...)` then optionally
                        // `result._type = obj['99']`, then break. Arrays must stay
                        // arrays (FontSet / TextFrameSet / StyleSheetSet); wrapping
                        // them in `{"": …}` breaks ResourceDict consumers.
                        if key != "99" {
                            let children = entry.children.as_ref().unwrap_or_else(|| empty_keys());
                            let mut decoded = decode_obj(value, children, depth + 1, max_depth)?;
                            if let Some(t) = map.iter().find(|(k, _)| k == "99").map(|(_, v)| v) {
                                if is_truthy(t) {
                                    if let EngineValue::Dict(ref mut m) = decoded {
                                        // An uprooted object receives only this one
                                        // additional property, so index it once.
                                        let mut positions = HashMap::new();
                                        if let Some(index) =
                                            m.iter().position(|(k, _)| k == "_type")
                                        {
                                            positions.insert("_type", index);
                                        }
                                        set_kv(m, &mut positions, "_type", t.clone());
                                    }
                                    // JS can set `._type` on arrays; EngineValue::Array
                                    // cannot. Real FontSet/TextFrameSet uproots do not
                                    // carry a sibling '99'.
                                }
                            }
                            return Ok(decoded);
                        }
                        // key == "99" with uproot: keep empty `{}`, then set `_type`.
                        if let Some(t) = map.iter().find(|(k, _)| k == "99").map(|(_, v)| v) {
                            if is_truthy(t) {
                                set_kv(&mut result, &mut positions, "_type", t.clone());
                            }
                        }
                        break;
                    } else {
                        let name = entry.name.unwrap_or(key.as_str());
                        let children = entry.children.as_ref().unwrap_or_else(|| empty_keys());
                        set_kv(
                            &mut result,
                            &mut positions,
                            name,
                            decode_obj(value, children, depth + 1, max_depth)?,
                        );
                    }
                } else if key == "99" {
                    set_kv(&mut result, &mut positions, "_type", value.clone());
                } else {
                    set_kv(
                        &mut result,
                        &mut positions,
                        key,
                        decode_obj(value, empty_keys(), depth + 1, max_depth)?,
                    );
                }
            }

            Ok(EngineValue::Dict(result))
        }
    }
}

// JS truthiness of the value for `if (obj['99'])`: null/false/0/"" -> false.
fn is_truthy(v: &EngineValue) -> bool {
    match v {
        EngineValue::Null => false,
        EngineValue::Bool(b) => *b,
        EngineValue::Number(n) => *n != 0.0 && !n.is_nan(),
        EngineValue::Str(s) => !s.is_empty(),
        EngineValue::Array(_) | EngineValue::Dict(_) => true,
    }
}

fn set_kv<'key>(
    map: &mut Vec<(String, EngineValue)>,
    positions: &mut HashMap<&'key str, usize>,
    key: &'key str,
    value: EngineValue,
) {
    // Renaming can collide with an existing key. Keep the first position and
    // last value without scanning the growing output for every input pair.
    match positions.entry(key) {
        std::collections::hash_map::Entry::Occupied(slot) => map[*slot.get()].1 = value,
        std::collections::hash_map::Entry::Vacant(slot) => {
            slot.insert(map.len());
            map.push((key.to_string(), value));
        }
    }
}

/// Port of `decodeEngineData2`. Returns the decoded (renamed) structure.
pub fn decode_engine_data2(data: &EngineValue) -> Result<EngineValue, EngineDataError> {
    decode_engine_data2_with_limit(data, DEFAULT_MAX_RECURSION_DEPTH)
}

/// Decode EngineData2 with an explicit object/array-depth ceiling.
pub fn decode_engine_data2_with_limit(
    data: &EngineValue,
    max_depth: u32,
) -> Result<EngineValue, EngineDataError> {
    decode_obj(data, keys_root_static(), 0, max_depth)
}

#[cfg(test)]
#[path = "engine_data2_security_tests.rs"]
mod security_tests;

#[cfg(test)]
mod tests {
    use super::*;
    use crate::engine_data::EngineValue;

    fn d(pairs: Vec<(&str, EngineValue)>) -> EngineValue {
        EngineValue::Dict(pairs.into_iter().map(|(k, v)| (k.to_string(), v)).collect())
    }

    fn get<'a>(v: &'a EngineValue, key: &str) -> Option<&'a EngineValue> {
        if let EngineValue::Dict(m) = v {
            m.iter().find(|(k, _)| k == key).map(|(_, v)| v)
        } else {
            None
        }
    }

    #[test]
    fn renames_top_level_keys() {
        // { "0": {...}, "1": {...} } -> { ResourceDict, EngineDict }
        let input = d(vec![("0", d(vec![])), ("1", d(vec![]))]);
        let out = decode_engine_data2(&input).expect("decode");
        assert!(get(&out, "ResourceDict").is_some());
        assert!(get(&out, "EngineDict").is_some());
    }

    #[test]
    fn renames_style_sheet_keys() {
        // EngineDict.StyleSheet (key "2") uses keysStyleSheet: "1" -> FontSize.
        let input = d(vec![(
            "1",
            d(vec![("2", d(vec![("1", EngineValue::Number(12.0))]))]),
        )]);
        let out = decode_engine_data2(&input).expect("decode");
        let engine = get(&out, "EngineDict").unwrap();
        let style = get(engine, "StyleSheet").unwrap();
        assert_eq!(get(style, "FontSize"), Some(&EngineValue::Number(12.0)));
    }

    #[test]
    fn uproot_and_type() {
        // keysColor: "0" uproot with children {0:Type,1:Values}; "99" -> _type.
        // Build a FillColor (StyleSheet key "53").
        let input = d(vec![(
            "1", // EngineDict
            d(vec![(
                "2", // EngineDict.StyleSheet
                d(vec![(
                    "53", // FillColor, children = keysColor
                    d(vec![
                        ("99", EngineValue::Str("/SimplePaint".to_string())),
                        (
                            "0",
                            d(vec![
                                ("0", EngineValue::Number(1.0)),
                                ("1", EngineValue::Array(vec![EngineValue::Number(0.0)])),
                            ]),
                        ),
                    ]),
                )]),
            )]),
        )]);
        let out = decode_engine_data2(&input).expect("decode");
        let style = get(get(&out, "EngineDict").unwrap(), "StyleSheet").unwrap();
        let fill = get(style, "FillColor").unwrap();
        // uproot of "0" pulls Type/Values up; "_type" from "99".
        assert_eq!(get(fill, "Type"), Some(&EngineValue::Number(1.0)));
        assert_eq!(
            get(fill, "_type"),
            Some(&EngineValue::Str("/SimplePaint".to_string()))
        );
        assert!(get(fill, "Values").is_some());
    }

    #[test]
    fn unknown_keys_passthrough() {
        let input = d(vec![("zzz", EngineValue::Number(7.0))]);
        let out = decode_engine_data2(&input).expect("decode");
        assert_eq!(get(&out, "zzz"), Some(&EngineValue::Number(7.0)));
    }

    #[test]
    fn uproot_preserves_array() {
        // ResourceDict.FontSet: key "1" → FontSet; children "0" uproots an array.
        let fonts = EngineValue::Array(vec![
            d(vec![("0", EngineValue::Str("Arial".into()))]),
            d(vec![("0", EngineValue::Str("Helvetica".into()))]),
        ]);
        let input = d(vec![(
            "0", // ResourceDict
            d(vec![(
                "1", // FontSet
                d(vec![("0", fonts)]),
            )]),
        )]);
        let out = decode_engine_data2(&input).expect("decode");
        let resource = get(&out, "ResourceDict").unwrap();
        let font_set = get(resource, "FontSet").unwrap();
        assert!(
            matches!(font_set, EngineValue::Array(a) if a.len() == 2),
            "FontSet must remain an array after uproot, got {font_set:?}"
        );
    }

    #[test]
    fn configured_decode_depth_is_exact_and_behavioral() {
        let nested = EngineValue::Array(vec![EngineValue::Number(1.0)]);
        assert!(decode_engine_data2_with_limit(&nested, 2).is_ok());
        let error = decode_engine_data2_with_limit(&nested, 1).expect_err("one over");
        assert!(error.0.contains("recursion depth"));
    }
}
