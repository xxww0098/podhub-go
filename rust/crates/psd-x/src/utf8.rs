/*
File: rust/crates/psd-x/src/utf8.rs

Purpose:
UTF-8 string encoding and decoding.

Source compatibility:
- port of upstream ag-psd `src/utf8.ts` (1:1 split).

Main responsibilities:
- mirror the corresponding upstream module while porting;
- keep this area's public contract in one place.

Mapping TS -> Rust:
- `charLengthInBytes(code)`        -> `char_length_in_bytes(code: u32) -> usize`
- `stringLengthInBytes(value)`     -> `string_length_in_bytes(value: &str) -> usize`
- `writeCharacter(buf, off, code)` -> `write_character(buffer: &mut [u8], offset: usize, code: u32) -> usize`
- `encodeStringTo(buf, off, val)`  -> `encode_string_to(buffer: &mut [u8], offset: usize, value: &str) -> usize`
- `encodeString(value)`            -> `encode_string(value: &str) -> Vec<u8>`
- `decodeString(value)`            -> `decode_string(value: &[u8]) -> Result<String, DecodeUtf8Error>`

Notes on faithfulness:
- Upstream works on UTF-16 code units (`charCodeAt`) and manually assembles surrogate
  pairs before UTF-8 encoding. Rust `&str` is already valid UTF-8, so walking `chars()`
  (scalar values) yields the same bytes as `charLengthInBytes`/`writeCharacter` for any
  valid string. Lone surrogates cannot appear in `&str`.
- `decode_string` keeps a manual UTF-8 decoder (reject overlongs, surrogates, OOR codes).
  **Policy vs upstream:** malformed input returns `DecodeUtf8Error` rather than replacing
  with U+FFFD (see `tests/default/utf8_spec.rs`). Length/encode/valid round-trips match upstream.
*/

// PORT STATUS: ported

/// Manual UTF-8 decoder error (mirror of `throw Error(...)` from upstream).
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum DecodeUtf8Error {
    #[error("Invalid byte index")]
    InvalidByteIndex,
    #[error("Invalid continuation byte")]
    InvalidContinuationByte,
    #[error("Lone surrogate U+{0:X} is not a scalar value")]
    LoneSurrogate(u32),
    #[error("Invalid UTF-8 detected")]
    InvalidUtf8Detected,
}

/// Byte length for UTF-8-encoding a code point (mirror of `charLengthInBytes`).
fn char_length_in_bytes(code: u32) -> usize {
    if (code & 0xffff_ff80) == 0 {
        1
    } else if (code & 0xffff_f800) == 0 {
        2
    } else if (code & 0xffff_0000) == 0 {
        3
    } else {
        4
    }
}

/// How many bytes a string will take in UTF-8 (mirror of `stringLengthInBytes`).
///
/// In TS, iteration walks UTF-16 code units and assembles surrogates; in Rust `chars()`
/// already yields scalar values, so `char_length_in_bytes(c as u32)` is equivalent.
pub fn string_length_in_bytes(value: &str) -> usize {
    let mut result = 0;
    for c in value.chars() {
        result += char_length_in_bytes(c as u32);
    }
    result
}

/// Write one code point into `buffer` starting at `offset`, return bytes written
/// (mirror of `writeCharacter`).
fn write_character(buffer: &mut [u8], offset: usize, code: u32) -> usize {
    let length = char_length_in_bytes(code);

    match length {
        1 => {
            buffer[offset] = code as u8;
        }
        2 => {
            buffer[offset] = (((code >> 6) & 0x1f) | 0xc0) as u8;
            buffer[offset + 1] = ((code & 0x3f) | 0x80) as u8;
        }
        3 => {
            buffer[offset] = (((code >> 12) & 0x0f) | 0xe0) as u8;
            buffer[offset + 1] = (((code >> 6) & 0x3f) | 0x80) as u8;
            buffer[offset + 2] = ((code & 0x3f) | 0x80) as u8;
        }
        _ => {
            buffer[offset] = (((code >> 18) & 0x07) | 0xf0) as u8;
            buffer[offset + 1] = (((code >> 12) & 0x3f) | 0x80) as u8;
            buffer[offset + 2] = (((code >> 6) & 0x3f) | 0x80) as u8;
            buffer[offset + 3] = ((code & 0x3f) | 0x80) as u8;
        }
    }

    length
}

/// Encode a string into `buffer` starting at `offset`, return the new offset
/// (mirror of `encodeStringTo`).
pub fn encode_string_to(buffer: &mut [u8], offset: usize, value: &str) -> usize {
    let mut offset = offset;
    for c in value.chars() {
        offset += write_character(buffer, offset, c as u32);
    }
    offset
}

/// Encode a string into a new `Vec<u8>` (mirror of `encodeString`).
///
/// Upstream delegates long strings (>1000) to `TextEncoder` (standard UTF-8);
/// the manual path for valid strings yields the same bytes, so the result matches
/// regardless of length.
pub fn encode_string(value: &str) -> Vec<u8> {
    let mut buffer = vec![0u8; string_length_in_bytes(value)];
    encode_string_to(&mut buffer, 0, value);
    buffer
}

/// Read a continuation byte at `index` (mirror of `continuationByte`).
fn continuation_byte(buffer: &[u8], index: usize) -> Result<u32, DecodeUtf8Error> {
    if index >= buffer.len() {
        return Err(DecodeUtf8Error::InvalidByteIndex);
    }

    let continuation_byte = buffer[index];

    if (continuation_byte & 0xC0) == 0x80 {
        Ok((continuation_byte & 0x3F) as u32)
    } else {
        Err(DecodeUtf8Error::InvalidContinuationByte)
    }
}

/// Decode UTF-8 bytes into a string (mirror of `decodeString`).
///
/// Manual parsing is kept on purpose (instead of `String::from_utf8`) to match exact
/// upstream error semantics.
pub fn decode_string(value: &[u8]) -> Result<String, DecodeUtf8Error> {
    let mut result = String::new();
    let mut i = 0usize;

    while i < value.len() {
        let byte1 = value[i] as u32;
        i += 1;
        let code: u32;

        if (byte1 & 0x80) == 0 {
            code = byte1;
        } else if (byte1 & 0xe0) == 0xc0 {
            let byte2 = continuation_byte(value, i)?;
            i += 1;
            code = ((byte1 & 0x1f) << 6) | byte2;

            if code < 0x80 {
                return Err(DecodeUtf8Error::InvalidContinuationByte);
            }
        } else if (byte1 & 0xf0) == 0xe0 {
            let byte2 = continuation_byte(value, i)?;
            i += 1;
            let byte3 = continuation_byte(value, i)?;
            i += 1;
            code = ((byte1 & 0x0f) << 12) | (byte2 << 6) | byte3;

            if code < 0x0800 {
                return Err(DecodeUtf8Error::InvalidContinuationByte);
            }

            if (0xd800..=0xdfff).contains(&code) {
                return Err(DecodeUtf8Error::LoneSurrogate(code));
            }
        } else if (byte1 & 0xf8) == 0xf0 {
            let byte2 = continuation_byte(value, i)?;
            i += 1;
            let byte3 = continuation_byte(value, i)?;
            i += 1;
            let byte4 = continuation_byte(value, i)?;
            i += 1;
            code = ((byte1 & 0x0f) << 0x12) | (byte2 << 0x0c) | (byte3 << 0x06) | byte4;

            if code < 0x01_0000 || code > 0x10_ffff {
                return Err(DecodeUtf8Error::InvalidContinuationByte);
            }
        } else {
            return Err(DecodeUtf8Error::InvalidUtf8Detected);
        }

        // Upstream builds a UTF-16 string (including a surrogate pair for code > 0xFFFF).
        // In Rust the string stores scalar values, so `char::from_u32` is enough.
        // By this point the code has already been validated as a valid scalar value.
        if let Some(ch) = char::from_u32(code) {
            result.push(ch);
        } else {
            // Unreachable for codes that passed the checks, but kept just in case.
            return Err(DecodeUtf8Error::InvalidUtf8Detected);
        }
    }

    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ascii_round_trip() {
        let s = "Hello, World!";
        let bytes = encode_string(s);
        assert_eq!(bytes, s.as_bytes());
        assert_eq!(decode_string(&bytes).unwrap(), s);
    }

    #[test]
    fn empty_round_trip() {
        let s = "";
        let bytes = encode_string(s);
        assert!(bytes.is_empty());
        assert_eq!(string_length_in_bytes(s), 0);
        assert_eq!(decode_string(&bytes).unwrap(), s);
    }

    #[test]
    fn cyrillic_round_trip() {
        let s = "Привет";
        let bytes = encode_string(s);
        // Each Cyrillic letter is 2 bytes in UTF-8 -> 6 chars * 2 = 12 bytes.
        assert_eq!(bytes.len(), 12);
        assert_eq!(string_length_in_bytes(s), 12);
        // first two UTF-8 chars of the Cyrillic fixture = D0 9F D1 80
        assert_eq!(&bytes[0..4], &[0xD0, 0x9F, 0xD1, 0x80]);
        assert_eq!(bytes, s.as_bytes());
        assert_eq!(decode_string(&bytes).unwrap(), s);
    }

    #[test]
    fn three_byte_round_trip() {
        let s = "あ"; // U+3042, 3 bytes
        let bytes = encode_string(s);
        assert_eq!(bytes, vec![0xE3, 0x81, 0x82]);
        assert_eq!(string_length_in_bytes(s), 3);
        assert_eq!(decode_string(&bytes).unwrap(), s);
    }

    #[test]
    fn emoji_surrogate_pair_round_trip() {
        let s = "😀"; // U+1F600, 4 bytes, surrogate pair in UTF-16
        let bytes = encode_string(s);
        assert_eq!(bytes, vec![0xF0, 0x9F, 0x98, 0x80]);
        assert_eq!(string_length_in_bytes(s), 4);
        assert_eq!(decode_string(&bytes).unwrap(), s);
    }

    #[test]
    fn mixed_round_trip() {
        let s = "aЯ あ😀z";
        let bytes = encode_string(s);
        assert_eq!(bytes, s.as_bytes());
        assert_eq!(string_length_in_bytes(s), s.len());
        assert_eq!(decode_string(&bytes).unwrap(), s);
    }

    #[test]
    fn decode_rejects_lone_surrogate() {
        // ED A0 80 -> U+D800, a lone surrogate (upstream throws).
        let err = decode_string(&[0xED, 0xA0, 0x80]).unwrap_err();
        assert_eq!(err, DecodeUtf8Error::LoneSurrogate(0xD800));
    }

    #[test]
    fn decode_rejects_overlong_two_byte() {
        // C0 80 would decode to U+0000 (overlong) -> code < 0x80.
        let err = decode_string(&[0xC0, 0x80]).unwrap_err();
        assert_eq!(err, DecodeUtf8Error::InvalidContinuationByte);
    }

    #[test]
    fn decode_rejects_bad_continuation() {
        // C2 followed by a non-continuation byte.
        let err = decode_string(&[0xC2, 0x20]).unwrap_err();
        assert_eq!(err, DecodeUtf8Error::InvalidContinuationByte);
    }

    #[test]
    fn decode_rejects_truncated() {
        // E3 81 missing third byte -> index out of range.
        let err = decode_string(&[0xE3, 0x81]).unwrap_err();
        assert_eq!(err, DecodeUtf8Error::InvalidByteIndex);
    }

    #[test]
    fn decode_rejects_invalid_lead() {
        let err = decode_string(&[0xFF]).unwrap_err();
        assert_eq!(err, DecodeUtf8Error::InvalidUtf8Detected);
    }
}
