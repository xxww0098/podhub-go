/*
File: rust/crates/psd-x/src/engine_data.rs

Purpose:
Engine Data parser and serializer (Photoshop text-engine structure).

Source compatibility:
- port of upstream ag-psd `src/engineData.ts` (1:1 split).

Main responsibilities:
- mirror the corresponding upstream module while porting;
- keep this area's public contract in one place.

Mapping TS -> Rust:
- `parseEngineData(data)`            -> `parse_engine_data(data: &[u8]) -> Result<EngineValue, EngineDataError>`
- `serializeEngineData(data, cond?)` -> `serialize_engine_data(data: &EngineValue, condensed: bool) -> Vec<u8>`

EngineData value model (`EngineValue`):
Upstream stores parsed data as an untyped JS object. Values may be:
`null`, number (always `number`), bool, string (both ordinary text in `( )` and
a "name" like `/Name` — in JS that is just a string starting with `/`), array, and dict.
Dictionaries MUST preserve insertion key order because the serializer walks
`Object.keys()` in insertion order (with one `getKeys` tweak that moves `99`/`98`
to the front) and byte output is compared against Photoshop. So `Dict` is stored as
`Vec<(String, EngineValue)>` (insertion-ordered), not as a `HashMap`.

Strings use a single `EngineValue::Str(String)` variant: "names" (`/Name`)
in upstream are ordinary strings starting with `/`, and the serializer distinguishes them
only by the leading `/` (for keys `98`/`99`). A separate `Name` variant would
diverge from TS semantics, so we keep the string "as is", including a leading `/`.

Note on string precision:
Upstream works on UTF-16 code units (`charCodeAt`/`String.fromCharCode`). Here text
is stored as a Rust `String` and converted via `encode_utf16`/`from_utf16`, which is
byte-equivalent for any valid Unicode (the typical PSD-text case).
Lone surrogates are impossible in `&str`.
*/

use crate::reader::DEFAULT_MAX_RECURSION_DEPTH;
use std::collections::{HashMap, hash_map::Entry};

// Bound parser work even for shallow containers and overwritten dictionary keys.
const MAX_ENGINE_DATA_TOKENS: usize = 1_000_000;

/// EngineData parse error (mirror of `throw new Error(...)` upstream).
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("{0}")]
pub struct EngineDataError(pub String);

/// Parsed EngineData value. See the model rationale in the file header.
#[derive(Debug, Clone, PartialEq)]
pub enum EngineValue {
    /// `null` (JS `null` upstream).
    Null,
    /// Number. Upstream always stores `number` (f64).
    Number(f64),
    /// Boolean value.
    Bool(bool),
    /// String. "Names" are stored as a string with a leading `/` (e.g. `/Name`).
    Str(String),
    /// Array of values.
    Array(Vec<EngineValue>),
    /// Dictionary `<< /Key value >>` preserving key order.
    Dict(Vec<(String, EngineValue)>),
}

impl EngineValue {
    pub fn is_object(&self) -> bool {
        // Mirror of JS `typeof value === 'object'` for null/array/dict
        // (used only where it affects branching).
        matches!(
            self,
            EngineValue::Dict(_) | EngineValue::Array(_) | EngineValue::Null
        )
    }
}

// ' ', '\n', '\r', '\t'
fn is_whitespace(char: u8) -> bool {
    char == 32 || char == 10 || char == 13 || char == 9
}

// 0123456789.-
fn is_number(char: u8) -> bool {
    (48..=57).contains(&char) || char == 46 || char == 45
}

// Internal parser-stack node: either a container (value) or a key name (string).
enum StackItem {
    Value(EngineValue, HashMap<String, usize>),
    Key(String),
}

/// Port of `parseEngineData`. Takes blob bytes, returns the root value.
pub fn parse_engine_data(data: &[u8]) -> Result<EngineValue, EngineDataError> {
    parse_engine_data_with_limit(data, DEFAULT_MAX_RECURSION_DEPTH)
}

/// Parse EngineData with an explicit container-depth ceiling and at most one
/// million tokens, including keys, duplicate values and container delimiters.
pub fn parse_engine_data_with_limit(
    data: &[u8],
    max_depth: u32,
) -> Result<EngineValue, EngineDataError> {
    let mut index: usize = 0;

    // --- helpers operating on `data`/`index` ---

    fn skip_whitespace(data: &[u8], index: &mut usize) {
        while *index < data.len() && is_whitespace(data[*index]) {
            *index += 1;
        }
    }

    fn read_text_byte(data: &[u8], index: &mut usize) -> Result<u8, EngineDataError> {
        let mut byte = *data
            .get(*index)
            .ok_or_else(|| EngineDataError("Truncated text data".to_owned()))?;
        *index += 1;

        if byte == 92 {
            // \
            byte = *data
                .get(*index)
                .ok_or_else(|| EngineDataError("Truncated text escape".to_owned()))?;
            *index += 1;
        }

        Ok(byte)
    }

    fn read_text(data: &[u8], index: &mut usize) -> Result<String, EngineDataError> {
        let mut units: Vec<u16> = Vec::new();

        if data.get(*index) == Some(&41) {
            // )
            *index += 1;
            return Ok(String::new());
        }

        // Strings start with utf-16 BOM
        if data.get(*index) != Some(&0xFE) || data.get(*index + 1) != Some(&0xFF) {
            return Err(EngineDataError("Invalid utf-16 BOM".to_string()));
        }

        *index += 2;

        // ), ( and \ characters are escaped in ascii manner, remove the escapes before
        // interpreting the bytes as utf-16
        while *index < data.len() && data[*index] != 41 {
            // )
            let high = read_text_byte(data, index)? as u16;
            let low = read_text_byte(data, index)? as u16;
            let char = (high << 8) | low;
            units.push(char);
        }

        if data.get(*index) != Some(&41) {
            return Err(EngineDataError("Unterminated text data".to_owned()));
        }
        *index += 1;
        Ok(String::from_utf16_lossy(&units))
    }

    // Root and stack. Unlike TS (where objects are references and a container sits
    // in both the parent and on the stack), here containers LIVE on the stack until closed, and on
    // `pop` they are attached to the parent. Semantically equivalent: TS attaches
    // the container to the parent at open time and then mutates via an alias; we attach at
    // close time. The final structure is the same.
    let mut root: Option<EngineValue> = None;
    let mut stack: Vec<StackItem> = Vec::new();

    fn set_dict(
        map: &mut Vec<(String, EngineValue)>,
        positions: &mut HashMap<String, usize>,
        key: String,
        value: EngineValue,
    ) {
        // Semantics of `obj[key] = value`: overwrite an existing key while
        // keeping its position, otherwise append. The index avoids a quadratic
        // scan for wide dictionaries and is discarded when the container closes.
        match positions.entry(key.clone()) {
            Entry::Occupied(slot) => map[*slot.get()].1 = value,
            Entry::Vacant(slot) => {
                slot.insert(map.len());
                map.push((key, value));
            }
        }
    }

    // pushValue: place a value into the current context (object-key or array).
    fn push_value(
        stack: &mut Vec<StackItem>,
        _root: &mut Option<EngineValue>,
        value: EngineValue,
    ) -> Result<(), EngineDataError> {
        let top = stack
            .last()
            .ok_or_else(|| EngineDataError("Invalid data".to_string()))?;

        match top {
            StackItem::Key(_) => {
                // top is a key string; pop it and put the value into the object under it.
                let key = match stack.pop().unwrap() {
                    StackItem::Key(k) => k,
                    _ => unreachable!(),
                };
                match stack.last_mut() {
                    Some(StackItem::Value(EngineValue::Dict(map), positions)) => {
                        set_dict(map, positions, key, value);
                        Ok(())
                    }
                    _ => Err(EngineDataError("Invalid data".to_string())),
                }
            }
            StackItem::Value(EngineValue::Array(_), _) => {
                if let Some(StackItem::Value(EngineValue::Array(arr), _)) = stack.last_mut() {
                    arr.push(value);
                }
                Ok(())
            }
            _ => Err(EngineDataError("Invalid data".to_string())),
        }
    }

    // pushContainer: open a new container. Push it as a stack frame; attach
    // to the parent happens in `pop`.
    fn push_container(
        stack: &mut Vec<StackItem>,
        _root: &mut Option<EngineValue>,
        value: EngineValue,
        max_depth: u32,
    ) -> Result<(), EngineDataError> {
        // Bound nesting so hostile input cannot blow the process stack / heap via
        // deeply nested `<<` / `[` containers. Keys also occupy stack slots.
        let depth = stack
            .iter()
            .filter(|i| matches!(i, StackItem::Value(_, _)))
            .count();
        if depth >= max_depth as usize {
            return Err(EngineDataError(
                "Exceeded recursion depth limit".to_string(),
            ));
        }
        stack.push(StackItem::Value(value, HashMap::new()));
        Ok(())
    }

    // pushProperty
    fn push_property(
        stack: &mut Vec<StackItem>,
        root: &mut Option<EngineValue>,
        name: &str,
        max_depth: u32,
    ) -> Result<(), EngineDataError> {
        if stack.is_empty() {
            push_container(stack, root, EngineValue::Dict(Vec::new()), max_depth)?;
        }

        match stack.last() {
            Some(StackItem::Key(_)) => {
                // top is a string: treat the name as a value.
                if name == "nil" {
                    push_value(stack, root, EngineValue::Null)
                } else {
                    push_value(stack, root, EngineValue::Str(format!("/{}", name)))
                }
            }
            Some(StackItem::Value(_, _)) => {
                // top is object/array: the name becomes a key.
                stack.push(StackItem::Key(name.to_string()));
                Ok(())
            }
            None => Err(EngineDataError("Invalid data".to_string())),
        }
    }

    // pop: close the current container. Pop the stack frame and attach its value
    // to the parent (or make it the root if the stack emptied).
    fn pop(
        stack: &mut Vec<StackItem>,
        root: &mut Option<EngineValue>,
    ) -> Result<(), EngineDataError> {
        let item = stack
            .pop()
            .ok_or_else(|| EngineDataError("Invalid data".to_string()))?;
        let value = match item {
            StackItem::Value(v, _) => v,
            StackItem::Key(_) => return Err(EngineDataError("Invalid data".to_string())),
        };

        if stack.is_empty() {
            *root = Some(value);
            Ok(())
        } else {
            push_value(stack, root, value)
        }
    }

    skip_whitespace(data, &mut index);

    let mut data_length = data.len();

    while data_length > 0 && data[data_length - 1] == 0 {
        data_length -= 1; // trim 0 bytes from end
    }

    let mut tokens = 0;
    while index < data_length {
        if tokens == MAX_ENGINE_DATA_TOKENS {
            return Err(EngineDataError(
                "Exceeded EngineData token limit".to_owned(),
            ));
        }
        tokens += 1;
        let i = index;
        let char = data[i];

        if char == 60 && data.get(i + 1) == Some(&60) {
            // <<
            index += 2;
            push_container(
                &mut stack,
                &mut root,
                EngineValue::Dict(Vec::new()),
                max_depth,
            )?;
        } else if char == 62 && data.get(i + 1) == Some(&62) {
            // >>
            index += 2;
            pop(&mut stack, &mut root)?;
        } else if char == 47 {
            // /
            index += 1;
            let start = index;

            while index < data.len() && !is_whitespace(data[index]) {
                index += 1;
            }

            let mut name = String::new();
            for j in start..index {
                name.push(data[j] as char);
            }

            push_property(&mut stack, &mut root, &name, max_depth)?;
        } else if char == 40 {
            // (
            index += 1;
            let text = read_text(data, &mut index)?;
            push_value(&mut stack, &mut root, EngineValue::Str(text))?;
        } else if char == 91 {
            // [
            index += 1;
            push_container(
                &mut stack,
                &mut root,
                EngineValue::Array(Vec::new()),
                max_depth,
            )?;
        } else if char == 93 {
            // ]
            index += 1;
            pop(&mut stack, &mut root)?;
        } else if char == 110
            && data.get(i + 1) == Some(&117)
            && data.get(i + 2) == Some(&108)
            && data.get(i + 3) == Some(&108)
        {
            // null
            index += 4;
            push_value(&mut stack, &mut root, EngineValue::Null)?;
        } else if char == 116
            && data.get(i + 1) == Some(&114)
            && data.get(i + 2) == Some(&117)
            && data.get(i + 3) == Some(&101)
        {
            // true
            index += 4;
            push_value(&mut stack, &mut root, EngineValue::Bool(true))?;
        } else if char == 102
            && data.get(i + 1) == Some(&97)
            && data.get(i + 2) == Some(&108)
            && data.get(i + 3) == Some(&115)
            && data.get(i + 4) == Some(&101)
        {
            // false
            index += 5;
            push_value(&mut stack, &mut root, EngineValue::Bool(false))?;
        } else if is_number(char) {
            let mut value = String::new();

            while index < data.len() && is_number(data[index]) {
                value.push(data[index] as char);
                index += 1;
            }

            let parsed = parse_float(&value);
            push_value(&mut stack, &mut root, EngineValue::Number(parsed))?;
        } else {
            index += 1;
            // Mirror of `console.log` (invalid token is skipped, not thrown).
            eprintln!("Invalid token '{}' ({}) at {}", char as char, char, index);
        }

        skip_whitespace(data, &mut index);
    }

    // In TS the root is fixed on the first pushContainer. Here containers attach
    // on `pop`, so a top-level condensed-format dict (without a `<< >>` wrapper)
    // stays unclosed at the bottom of the stack — take it as the root.
    if root.is_none() {
        if let Some(StackItem::Value(v, _)) = stack.into_iter().next() {
            root = Some(v);
        }
    }

    Ok(root.unwrap_or(EngineValue::Null))
}

// Mirror of JS `parseFloat`: parse a leading numeric prefix, else NaN.
fn parse_float(value: &str) -> f64 {
    let s = value.trim_start();
    // Find the longest valid f64 prefix.
    let mut end = 0;
    let bytes = s.as_bytes();
    let mut seen_dot = false;
    let mut i = 0;
    if i < bytes.len() && (bytes[i] == b'+' || bytes[i] == b'-') {
        i += 1;
    }
    while i < bytes.len() {
        let c = bytes[i];
        if c.is_ascii_digit() {
            end = i + 1;
            i += 1;
        } else if c == b'.' && !seen_dot {
            seen_dot = true;
            i += 1;
        } else {
            break;
        }
    }
    if end == 0 {
        f64::NAN
    } else {
        s[..end].parse::<f64>().unwrap_or(f64::NAN)
    }
}

const FLOAT_KEYS: &[&str] = &[
    "Axis",
    "XY",
    "Zone",
    "WordSpacing",
    "FirstLineIndent",
    "GlyphSpacing",
    "StartIndent",
    "EndIndent",
    "SpaceBefore",
    "SpaceAfter",
    "LetterSpacing",
    "Values",
    "GridSize",
    "GridLeading",
    "PointBase",
    "BoxBounds",
    "TransformPoint0",
    "TransformPoint1",
    "TransformPoint2",
    "FontSize",
    "Leading",
    "HorizontalScale",
    "VerticalScale",
    "BaselineShift",
    "Tsume",
    "OutlineWidth",
    "AutoLeading",
];

const INT_ARRAYS: &[&str] = &["RunLengthArray"];

// serializeInt
fn serialize_int(value: f64) -> String {
    // JS `value.toString()` for integer values.
    js_number_to_string(value)
}

// serializeFloat: toFixed(5) + three regex replacements.
// JS `(-0).toFixed(5)` yields `"0.00000"` (not `"-0.00000"`); canonicalize -0.0.
fn serialize_float(value: f64) -> String {
    let value = if value == 0.0 { 0.0 } else { value };
    let mut s = format!("{:.5}", value);

    // .replace(/(\d)0+$/g, '$1') — strip trailing zeros after a non-zero digit.
    s = replace_trailing_zeros(&s);
    // .replace(/^0+\.([1-9])/g, '.$1')
    s = replace_leading_zero_dot(&s);
    // .replace(/^-0+\.0(\d)/g, '-.0$1')
    s = replace_neg_zero_dot(&s);

    s
}

// /(\d)0+$/ -> $1 : find the LEFTMOST digit `p` after which the rest of the string is
// only zeros (>=1), and keep the string through `p` inclusive (drop the zero tail).
// This matches the leftmost-greedy global-replace semantics of the JS regex engine.
fn replace_trailing_zeros(s: &str) -> String {
    let bytes = s.as_bytes();
    let n = bytes.len();
    for p in 0..n {
        if bytes[p].is_ascii_digit() && p + 1 < n && bytes[p + 1..].iter().all(|&c| c == b'0') {
            return s[..=p].to_string();
        }
    }
    s.to_string()
}

// /^0+\.([1-9])/ -> .$1 : leading zeros + dot + digit 1-9 -> dot + digit.
fn replace_leading_zero_dot(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut i = 0;
    while i < bytes.len() && bytes[i] == b'0' {
        i += 1;
    }
    // Need at least one leading zero, then '.', then [1-9].
    if i >= 1 && i + 1 < bytes.len() && bytes[i] == b'.' && (b'1'..=b'9').contains(&bytes[i + 1]) {
        format!(".{}", &s[i + 1..])
    } else {
        s.to_string()
    }
}

// /^-0+\.0(\d)/ -> -.0$1 : '-' + zeros + ".0" + digit -> "-.0" + digit.
fn replace_neg_zero_dot(s: &str) -> String {
    let bytes = s.as_bytes();
    if bytes.first() != Some(&b'-') {
        return s.to_string();
    }
    let mut i = 1;
    while i < bytes.len() && bytes[i] == b'0' {
        i += 1;
    }
    // Need at least one zero after '-', then ".0", then a digit.
    if i >= 2
        && i + 2 < bytes.len()
        && bytes[i] == b'.'
        && bytes[i + 1] == b'0'
        && bytes[i + 2].is_ascii_digit()
    {
        format!("-.0{}", &s[i + 2..])
    } else {
        s.to_string()
    }
}

// serializeNumber
fn serialize_number(value: f64, key: Option<&str>) -> String {
    // (key && floatKeys.indexOf(key) !== -1) || (value | 0) !== value
    let is_float =
        key.map(|k| FLOAT_KEYS.contains(&k)).unwrap_or(false) || (to_int32(value) as f64) != value;
    if is_float {
        serialize_float(value)
    } else {
        serialize_int(value)
    }
}

// JS `value | 0` — coerce to int32 via ToInt32.
fn to_int32(value: f64) -> i32 {
    if !value.is_finite() {
        return 0;
    }
    let n = value.trunc();
    let m = n.rem_euclid(4294967296.0); // 2^32
    let u = m as u64 as u32;
    u as i32
}

// JS Number.toString() for values we emit as integers.
fn js_number_to_string(value: f64) -> String {
    if value == value.trunc() && value.is_finite() && value.abs() < 1e21 {
        // integer
        format!("{}", value as i64)
    } else {
        // should not be reached for serialize_int (called only for integers),
        // but leave a reasonable fallback.
        let s = format!("{}", value);
        s
    }
}

// getKeys: mirrors upstream engineData.ts — move '98' then '99' to the front.
fn map_keys(map: &[(String, EngineValue)]) -> Vec<String> {
    let mut keys: Vec<String> = map.iter().map(|(k, _)| k.clone()).collect();

    // if (keys.indexOf('98') !== -1) keys.unshift(...keys.splice(keys.indexOf('98'), 1));
    if let Some(pos) = keys.iter().position(|k| k == "98") {
        let removed = keys.remove(pos);
        keys.insert(0, removed);
    }

    // if (keys.indexOf('99') !== -1) keys.unshift(...keys.splice(keys.indexOf('99'), 1));
    if let Some(pos) = keys.iter().position(|k| k == "99") {
        let removed = keys.remove(pos);
        keys.insert(0, removed);
    }

    keys
}

/// Port of `serializeEngineData`. Returns blob bytes.
pub fn serialize_engine_data(data: &EngineValue, condensed: bool) -> Vec<u8> {
    let mut buffer: Vec<u8> = Vec::with_capacity(1024);
    let mut indent: usize = 0;

    serialize_engine_data_inner(data, condensed, &mut buffer, &mut indent);

    buffer
}

fn write_str(buffer: &mut Vec<u8>, value: &str) {
    // writeString: write the low byte of each UTF-16 code unit (charCodeAt & 0xff
    // in practice — upstream writes charCodeAt whole into a Uint8Array, which truncates
    // to a byte). For ASCII literals this equals writing the bytes directly.
    for unit in value.encode_utf16() {
        buffer.push((unit & 0xff) as u8);
    }
}

fn write_indent(buffer: &mut Vec<u8>, condensed: bool, indent: usize) {
    if condensed {
        write_str(buffer, " ");
    } else {
        for _ in 0..indent {
            write_str(buffer, "\t");
        }
    }
}

fn write_string_byte(buffer: &mut Vec<u8>, value: u8) {
    if value == 40 || value == 41 || value == 92 {
        // ( ) \
        buffer.push(92); // \
    }
    buffer.push(value);
}

fn serialize_engine_data_inner(
    data: &EngineValue,
    condensed: bool,
    buffer: &mut Vec<u8>,
    indent: &mut usize,
) {
    if condensed {
        if let EngineValue::Dict(map) = data {
            for key in map_keys(map) {
                let value = map.iter().find(|(k, _)| *k == key).map(|(_, v)| v).unwrap();
                write_property(&key, value, condensed, buffer, indent);
            }
        }
        // (if data is an array/number/string in condensed mode, upstream writes nothing,
        //  because `typeof data === 'object'` is true for arrays — but then for...in walks
        //  numeric indices; in practice the EngineData root is always an object.)
        // For accuracy: an array in condensed is handled as an object with numeric keys.
        else if let EngineValue::Array(arr) = data {
            // Object.keys of an array are string indices "0", "1", ...
            for (i, value) in arr.iter().enumerate() {
                let key = i.to_string();
                write_property(&key, value, condensed, buffer, indent);
            }
        }
    } else {
        write_str(buffer, "\n\n");
        write_value(data, None, false, condensed, buffer, indent);
    }
}

fn write_property(
    key: &str,
    value: &EngineValue,
    condensed: bool,
    buffer: &mut Vec<u8>,
    indent: &mut usize,
) {
    write_indent(buffer, condensed, *indent);
    write_str(buffer, &format!("/{}", key));
    write_value(value, Some(key), true, condensed, buffer, indent);
    if !condensed {
        write_str(buffer, "\n");
    }
}

fn write_value(
    value: &EngineValue,
    key: Option<&str>,
    in_property: bool,
    condensed: bool,
    buffer: &mut Vec<u8>,
    indent: &mut usize,
) {
    // writePrefix
    fn write_prefix(in_property: bool, condensed: bool, buffer: &mut Vec<u8>, indent: usize) {
        if in_property {
            write_str(buffer, " ");
        } else {
            write_indent(buffer, condensed, indent);
        }
    }

    match value {
        EngineValue::Null => {
            write_prefix(in_property, condensed, buffer, *indent);
            write_str(buffer, if condensed { "/nil" } else { "null" });
        }
        EngineValue::Number(n) => {
            write_prefix(in_property, condensed, buffer, *indent);
            write_str(buffer, &serialize_number(*n, key));
        }
        EngineValue::Bool(b) => {
            write_prefix(in_property, condensed, buffer, *indent);
            write_str(buffer, if *b { "true" } else { "false" });
        }
        EngineValue::Str(s) => {
            write_prefix(in_property, condensed, buffer, *indent);

            let is_name = (key == Some("99") || key == Some("98")) && s.starts_with('/');
            if is_name {
                write_str(buffer, s);
            } else {
                write_str(buffer, "(");
                buffer.push(0xfe);
                buffer.push(0xff);

                for code in s.encode_utf16() {
                    write_string_byte(buffer, ((code >> 8) & 0xff) as u8);
                    write_string_byte(buffer, (code & 0xff) as u8);
                }

                write_str(buffer, ")");
            }
        }
        EngineValue::Array(arr) => {
            write_prefix(in_property, condensed, buffer, *indent);

            let all_numbers = arr.iter().all(|x| matches!(x, EngineValue::Number(_)));
            if all_numbers {
                write_str(buffer, "[");

                let int_array = key.map(|k| INT_ARRAYS.contains(&k)).unwrap_or(false);

                for x in arr {
                    if let EngineValue::Number(n) = x {
                        write_str(buffer, " ");
                        let s = if int_array {
                            serialize_number(*n, None)
                        } else {
                            serialize_float(*n)
                        };
                        write_str(buffer, &s);
                    }
                }

                write_str(buffer, " ]");
            } else {
                write_str(buffer, "[");
                if !condensed {
                    write_str(buffer, "\n");
                }

                for x in arr {
                    write_value(x, key, false, condensed, buffer, indent);
                    if !condensed {
                        write_str(buffer, "\n");
                    }
                }

                write_indent(buffer, condensed, *indent);
                write_str(buffer, "]");
            }
        }
        EngineValue::Dict(map) => {
            if in_property && !condensed {
                write_str(buffer, "\n");
            }

            write_indent(buffer, condensed, *indent);
            write_str(buffer, "<<");

            if !condensed {
                write_str(buffer, "\n");
            }

            *indent += 1;

            for k in map_keys(map) {
                let v = map.iter().find(|(kk, _)| *kk == k).map(|(_, v)| v).unwrap();
                write_property(&k, v, condensed, buffer, indent);
            }

            *indent -= 1;
            write_indent(buffer, condensed, *indent);
            write_str(buffer, ">>");
        }
    }
}

#[cfg(test)]
#[path = "engine_data_security_tests.rs"]
mod security_tests;

#[cfg(test)]
mod tests {
    use super::*;

    fn dict(pairs: Vec<(&str, EngineValue)>) -> EngineValue {
        EngineValue::Dict(pairs.into_iter().map(|(k, v)| (k.to_string(), v)).collect())
    }

    fn sample() -> EngineValue {
        dict(vec![
            (
                "EngineDict",
                dict(vec![
                    (
                        "Editor",
                        dict(vec![("Text", EngineValue::Str("Привет ❤".to_string()))]),
                    ),
                    (
                        "RunLengthArray",
                        EngineValue::Array(vec![
                            EngineValue::Number(3.0),
                            EngineValue::Number(5.0),
                        ]),
                    ),
                    (
                        "Values",
                        EngineValue::Array(vec![
                            EngineValue::Number(0.0),
                            EngineValue::Number(0.5),
                            EngineValue::Number(1.0),
                        ]),
                    ),
                    ("FontSize", EngineValue::Number(12.0)),
                    ("AntiAlias", EngineValue::Number(4.0)),
                    ("UseFractionalGlyphWidths", EngineValue::Bool(true)),
                    ("Nothing", EngineValue::Null),
                ]),
            ),
            (
                "ResourceDict",
                dict(vec![(
                    "Nested",
                    dict(vec![("Flag", EngineValue::Bool(false))]),
                )]),
            ),
        ])
    }

    #[test]
    fn round_trip_full() {
        let value = sample();
        let bytes = serialize_engine_data(&value, false);
        let parsed = parse_engine_data(&bytes).unwrap();
        assert_eq!(parsed, value);
    }

    #[test]
    fn round_trip_condensed() {
        let value = sample();
        let bytes = serialize_engine_data(&value, true);
        let parsed = parse_engine_data(&bytes).unwrap();
        assert_eq!(parsed, value);
    }

    #[test]
    fn condensed_byte_exact() {
        // Small hand-checkable case.
        let value = dict(vec![
            ("A", EngineValue::Number(1.0)),
            ("B", EngineValue::Bool(true)),
            ("C", EngineValue::Number(12.0)),
            ("D", EngineValue::Null),
        ]);
        let bytes = serialize_engine_data(&value, true);
        // condensed: " /A 1 /B true /C 12 /D /nil"
        let expected = b" /A 1 /B true /C 12 /D /nil".to_vec();
        assert_eq!(bytes, expected);
    }

    #[test]
    fn condensed_string_byte_exact() {
        // String "AB" in condensed: " /T (<FE><FF>\0A\0B)"
        let value = dict(vec![("T", EngineValue::Str("AB".to_string()))]);
        let bytes = serialize_engine_data(&value, true);
        let mut expected: Vec<u8> = Vec::new();
        expected.extend_from_slice(b" /T (");
        expected.push(0xfe);
        expected.push(0xff);
        expected.extend_from_slice(&[0x00, b'A', 0x00, b'B']);
        expected.push(b')');
        assert_eq!(bytes, expected);
    }

    #[test]
    fn condensed_string_escapes() {
        // Parentheses and backslash in a string must be escaped.
        let value = dict(vec![("T", EngineValue::Str("()\\".to_string()))]);
        let bytes = serialize_engine_data(&value, true);
        let mut expected: Vec<u8> = Vec::new();
        expected.extend_from_slice(b" /T (");
        expected.push(0xfe);
        expected.push(0xff);
        // '(' = 0x28 high 0x00 low 0x28 -> 0x00, '\(' (escaped 0x28)
        expected.extend_from_slice(&[0x00, 0x5c, 0x28]); // 0x00 then \(
        expected.extend_from_slice(&[0x00, 0x5c, 0x29]); // 0x00 then \)
        expected.extend_from_slice(&[0x00, 0x5c, 0x5c]); // 0x00 then \\
        expected.push(b')');
        assert_eq!(bytes, expected);
    }

    #[test]
    fn non_condensed_byte_exact() {
        // { A: 1, B: { C: 2 } } in non-condensed form.
        let value = dict(vec![
            ("A", EngineValue::Number(1.0)),
            ("B", dict(vec![("C", EngineValue::Number(2.0))])),
        ]);
        let bytes = serialize_engine_data(&value, false);
        // \n\n<<\n\t/A 1\n\t/B\n\t<<\n\t\t/C 2\n\t>>\n>>
        let expected = "\n\n<<\n\t/A 1\n\t/B\n\t<<\n\t\t/C 2\n\t>>\n>>";
        assert_eq!(String::from_utf8(bytes).unwrap(), expected);
    }

    #[test]
    fn float_formatting() {
        assert_eq!(serialize_float(0.5), ".5");
        assert_eq!(serialize_float(1.0), "1.0");
        assert_eq!(serialize_float(12.25), "12.25");
        assert_eq!(serialize_float(-0.05), "-.05");
        assert_eq!(serialize_float(100.0), "100.0");
        // JS (-0).toFixed(5) → "0.00000" → "0.0"
        assert_eq!(serialize_float(-0.0), "0.0");
    }

    #[test]
    fn number_int_vs_float() {
        // FontSize in floatKeys -> float format ("12.00000" -> "12.0").
        assert_eq!(serialize_number(12.0, Some("FontSize")), "12.0");
        // Ordinary key, integer value -> int.
        assert_eq!(serialize_number(12.0, Some("AntiAlias")), "12");
        // Non-integer without a key -> float.
        assert_eq!(serialize_number(0.5, None), ".5");
    }

    #[test]
    fn map_keys_99_first() {
        let map = vec![
            ("0".to_string(), EngineValue::Number(1.0)),
            ("99".to_string(), EngineValue::Str("/Type".to_string())),
            ("1".to_string(), EngineValue::Number(2.0)),
        ];
        assert_eq!(map_keys(&map), vec!["99", "0", "1"]);
    }

    #[test]
    fn map_keys_98_then_99() {
        // Upstream moves '98' first, then '99' in front of that.
        let map = vec![
            ("0".to_string(), EngineValue::Number(1.0)),
            ("98".to_string(), EngineValue::Str("/A".to_string())),
            ("99".to_string(), EngineValue::Str("/B".to_string())),
            ("1".to_string(), EngineValue::Number(2.0)),
        ];
        assert_eq!(map_keys(&map), vec!["99", "98", "0", "1"]);
    }

    #[test]
    fn configured_container_depth_is_exact_and_behavioral() {
        assert!(parse_engine_data_with_limit(b"[ [ ] ]", 2).is_ok());
        let error = parse_engine_data_with_limit(b"[ [ ] ]", 1).expect_err("one over");
        assert!(error.0.contains("recursion depth"));
    }

    #[test]
    fn truncated_text_is_rejected_without_panicking() {
        let result = std::panic::catch_unwind(|| parse_engine_data(b"("));
        assert!(result.is_ok());
        assert!(result.unwrap().is_err());
    }
}
