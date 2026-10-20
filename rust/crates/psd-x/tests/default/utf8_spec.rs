//! Port of upstream ag-psd `src/test/utf8.spec.ts`.
//!
//! ## Policy: Err vs upstream U+FFFD
//!
//! Upstream `decodeString` (and the browser `TextDecoder`) replace malformed
//! UTF-8 / lone surrogates with U+FFFD. Rust `psdx::utf8::decode_string` returns
//! [`DecodeUtf8Error`] instead — an intentional, stricter contract that still
//! covers the same invalid-input cases. Length / encode / valid round-trip
//! tests match upstream; malformed decode tests assert `Err` rather than `�`.
//!
//! Lone UTF-16 surrogates cannot appear in a Rust `&str`, so encode-side
//! surrogate replacement tests are not ported (documented intentional gap).

use psdx::utf8::{
    DecodeUtf8Error, decode_string, encode_string, encode_string_to, string_length_in_bytes,
};

#[test]
fn string_length_in_bytes_cases() {
    assert_eq!(string_length_in_bytes(""), 0);
    assert_eq!(string_length_in_bytes("Hello"), 5);
    assert_eq!(string_length_in_bytes("ą"), 2);
    assert_eq!(string_length_in_bytes("ąćęłńóśźż"), 9 * 2);
    assert_eq!(string_length_in_bytes("你好世界"), 4 * 3);
    assert_eq!(string_length_in_bytes("こんにちは"), 5 * 3);
    assert_eq!(string_length_in_bytes("カタカナ"), 4 * 3);
    assert_eq!(string_length_in_bytes("漢字"), 2 * 3);
    assert_eq!(string_length_in_bytes("😀"), 4);
    assert_eq!(string_length_in_bytes("😀🎉👍"), 3 * 4);
}

#[test]
fn string_length_matches_encode_string() {
    let samples = [
        "Hello",
        "Zażółć gęślą jaźń",
        "你好，世界",
        "こんにちは世界",
        "😀🎉👨‍👩‍👧‍👦",
    ];
    for sample in samples {
        assert_eq!(
            string_length_in_bytes(sample),
            encode_string(sample).len(),
            "{sample}"
        );
    }
}

#[test]
fn encode_decode_round_trip_samples() {
    let samples = [
        "",
        "The quick brown fox jumps over the lazy dog.",
        "Zażółć gęślą jaźń",
        "你好，世界！这是一段中文文本。",
        "こんにちは世界、これは日本語のテキストです。",
        "😀🎉👍🍕🚀",
        "👍🏽",
        "👨‍👩‍👧‍👦",
        "Hello Zażółć 你好 こんにちは 😀",
    ];
    for value in samples {
        let encoded = encode_string(value);
        assert_eq!(encoded, value.as_bytes(), "encode {value}");
        assert_eq!(decode_string(&encoded).unwrap(), value, "decode {value}");
    }
}

#[test]
fn encode_string_to_offset() {
    let mut buffer = vec![0xffu8; 20];
    let offset = encode_string_to(&mut buffer, 3, "ą😀");
    assert_eq!(offset, 3 + 2 + 4);
    assert_eq!(&buffer[..3], &[0xff, 0xff, 0xff]);
    assert!(buffer[9..].iter().all(|&b| b == 0xff));
}

#[test]
fn decode_malformed_returns_err() {
    // Intentional difference vs upstream U+FFFD replacement — see module docs.
    assert!(matches!(
        decode_string(&[0x61, 0xff, 0x62]),
        Err(DecodeUtf8Error::InvalidUtf8Detected)
    ));
    assert!(decode_string(&[0x61, 0xe2, 0x28, 0xa1]).is_err());
    assert!(decode_string(&[0x61, 0xe2, 0x82]).is_err());
    assert!(decode_string(&[0xc0, 0x80]).is_err());
    assert!(decode_string(&[0xed, 0xa0, 0x80]).is_err());
    assert!(decode_string(&[0xf4, 0x90, 0x80, 0x80]).is_err());
}

#[test]
fn long_valid_round_trip() {
    let value = "Zażółć 你好 こんにちは 😀 ".repeat(60);
    let value = &value[..value.len().min(1500)];
    // Ensure we don't slice mid-char.
    let value = match value.char_indices().take_while(|(i, _)| *i < 1500).last() {
        Some((i, c)) => &value[..i + c.len_utf8()],
        None => value,
    };
    assert_eq!(decode_string(&encode_string(value)).unwrap(), value);
}
