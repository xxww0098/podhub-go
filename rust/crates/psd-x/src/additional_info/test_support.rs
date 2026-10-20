/*
File: rust/crates/psd-x/src/additional_info/test_support.rs

Purpose:
Shared round-trip harness for additional-info key tests. No upstream
counterpart — upstream tests through whole `.psd` fixtures.

Availability:
compiled when `cfg(test)` (crate-internal unit tests) **or** the
`test-support` feature is enabled (integration tests / external crates).
Default feature builds do not include this module.

Why this exists:
every group-module used to carry its own copy of `write_layer` / `read_layer` /
`roundtrip`. The copies had already drifted apart on two points that matter:

- `large`: two copies used `sig == "8B64" || is_large_key(key)`. That is wrong.
  `write_additional_info` emits `8B64` only when `psb && is_large_key(key)`, so
  on a non-PSB write a large key (`cinf`, `FMsk`, `FEid`, `lnk2`, `LMsk`,
  `Lr16`, `Lr32`) is written as `8BIM` with a single 4-byte length. A reader
  that decides `large` from the key rather than the signature then expects two
  4-byte words and fails with `SizeTooLarge`. The bug was dormant only because
  neither of those two groups owns a large key.
- `round`: one copy hardcoded 2 instead of taking `four_bytes` from [`HANDLERS`].
  Dormant for `write_total_length = true` keys (their written length already
  includes the padding), live for the five keys that write an unpadded length
  (`Txt2`, `cinf`, `extn`, `CAI `, `OCIO`).

Both rules now live here once. The harness mirrors `read_additional_layer_info`
(reader.rs) and `write_additional_info` (mod.rs) — if those change, this changes
with them, in one place.

Main responsibilities:
- frame a `LayerAdditionalInfo` into additional-info sections and back;
- own the `large` / `round` derivation so tests never restate it;
- hide the `left` closure and ctx construction from test bodies.
*/

use super::{
    HANDLERS, ReadCtx, WriteCtx, alias_target, read_additional_info_key, write_additional_info,
};
use crate::psd::{LayerAdditionalInfo, ReadOptions, WriteOptions};
use crate::reader::{PsdReader, read_section, read_signature, skip_bytes};
use crate::writer::create_writer;

/// Round-trip harness for layer additional-info sections.
///
/// The interface is the three verbs (`write_layer`, `read_layer`, `roundtrip`)
/// plus the document context a few keys need. Section framing, signature
/// selection, `large`/`round` derivation and the `left` closure are
/// implementation details.
///
/// ```ignore
/// let out = Harness::new().roundtrip(info);          // non-PSB, 1x1 document
/// let out = Harness::new().psb().roundtrip(info);    // PSB (8B64 for large keys)
/// let out = Harness::new().doc_size(w, h).roundtrip(info);
/// ```
pub struct Harness {
    psb: bool,
    doc_width: f64,
    doc_height: f64,
    read_options: ReadOptions,
    write_options: WriteOptions,
}

impl Default for Harness {
    fn default() -> Self {
        Self::new()
    }
}

impl Harness {
    pub fn new() -> Self {
        Self {
            psb: false,
            doc_width: 1.0,
            doc_height: 1.0,
            read_options: ReadOptions::default(),
            write_options: WriteOptions::default(),
        }
    }

    /// Write as PSB: large keys get an `8B64` signature and an 8-byte length,
    /// and `vmsk` is written as `vsms`.
    pub fn psb(mut self) -> Self {
        self.psb = true;
        self
    }

    /// Document pixel size, used by `vmsk` bezier normalization on both sides.
    pub fn doc_size(mut self, width: f64, height: f64) -> Self {
        self.doc_width = width;
        self.doc_height = height;
        self
    }

    pub fn read_options(mut self, options: ReadOptions) -> Self {
        self.read_options = options;
        self
    }

    pub fn write_options(mut self, options: WriteOptions) -> Self {
        self.write_options = options;
        self
    }

    /// Write every section `info` carries, in canonical registry order.
    pub fn write_layer(&self, info: &LayerAdditionalInfo) -> Vec<u8> {
        let mut ctx = WriteCtx::new(&self.write_options, self.psb);
        ctx.doc_width = self.doc_width;
        ctx.doc_height = self.doc_height;
        let mut writer = create_writer(1024);
        write_additional_info(&mut writer, info, &mut ctx).expect("write additional info");
        writer.to_bytes()
    }

    /// Read a stream of additional-info sections back, mirroring the
    /// orchestration in `read_additional_layer_info`.
    pub fn read_layer(&self, bytes: &[u8]) -> LayerAdditionalInfo {
        let mut info = LayerAdditionalInfo::default();
        let mut reader = PsdReader::new(bytes, None, None);

        // Each section is at minimum signature (4) + key (4).
        while reader.offset + 8 <= reader.len() {
            let signature = read_signature(&mut reader).expect("section signature");
            assert!(
                signature == "8BIM" || signature == "8B64",
                "bad additional-info signature {signature:?} at offset {}",
                reader.offset - 4
            );
            let key = read_signature(&mut reader).expect("section key");

            // `large` follows the SIGNATURE, not the key: `write_additional_info`
            // only emits 8B64 when `psb && is_large_key(key)`.
            let large = signature == "8B64";
            let round = section_round(&key);

            let mut ctx = ReadCtx::new(&self.read_options, large);
            ctx.doc_width = self.doc_width;
            ctx.doc_height = self.doc_height;

            read_section::<(), _>(
                &mut reader,
                round,
                |r, left| {
                    let handled = read_additional_info_key(&key, r, &mut info, left, &mut ctx)?;
                    if !handled || left(r) != 0 {
                        skip_bytes(r, left(r));
                    }
                    Ok(())
                },
                false,
                large,
            )
            .unwrap_or_else(|e| panic!("read section for key {key:?}: {e:?}"));
        }

        info
    }

    pub fn roundtrip(&self, info: &LayerAdditionalInfo) -> LayerAdditionalInfo {
        self.read_layer(&self.write_layer(info))
    }

    /// Write exactly one key, with the same framing `write_additional_info`
    /// would give it, ignoring `has` and the rest of `info`.
    ///
    /// Use this to pin a single key independently of registry order. Unlike
    /// calling a group-module's `write` directly, this still exercises
    /// signature selection, `four_bytes` round and section backpatching.
    pub fn write_key(&self, key: &str, info: &LayerAdditionalInfo) -> Vec<u8> {
        let handler = HANDLERS
            .iter()
            .find(|h| h.key == alias_target(key))
            .unwrap_or_else(|| panic!("key {key:?} is not registered in HANDLERS"));

        let mut ctx = WriteCtx::new(&self.write_options, self.psb);
        ctx.doc_width = self.doc_width;
        ctx.doc_height = self.doc_height;

        let large = self.psb && super::is_large_key(key);
        let round = if handler.four_bytes { 4 } else { 2 };
        let mut writer = create_writer(1024);

        crate::writer::write_signature(&mut writer, if large { "8B64" } else { "8BIM" })
            .expect("signature");
        crate::writer::write_signature(&mut writer, key).expect("key");
        crate::writer::write_section(
            &mut writer,
            round,
            |w| {
                let handled = super::group_write(handler.group, key, w, info, &mut ctx);
                assert!(
                    handled.is_some(),
                    "group {:?} does not handle write for key {key:?}",
                    handler.group
                );
                handled.unwrap().expect("write body");
                Ok(())
            },
            handler.write_total_length,
            large,
        )
        .expect("write section");

        writer.to_bytes()
    }

    /// Frame one key, read the stream back. See [`Harness::write_key`].
    pub fn roundtrip_key(&self, key: &str, info: &LayerAdditionalInfo) -> LayerAdditionalInfo {
        self.read_layer(&self.write_key(key, info))
    }
}

/// `writeSection` round for a key, from the registry (`four_bytes`).
fn section_round(key: &str) -> usize {
    let target = alias_target(key);
    HANDLERS
        .iter()
        .find(|h| h.key == target)
        .map(|h| if h.four_bytes { 4 } else { 2 })
        .unwrap_or(2)
}

// --- convenience wrappers for the common (non-PSB, 1x1) case ----------------

pub fn write_layer(info: &LayerAdditionalInfo) -> Vec<u8> {
    Harness::new().write_layer(info)
}

pub fn read_layer(bytes: &[u8]) -> LayerAdditionalInfo {
    Harness::new().read_layer(bytes)
}

pub fn roundtrip(info: &LayerAdditionalInfo) -> LayerAdditionalInfo {
    Harness::new().roundtrip(info)
}

pub fn roundtrip_key(key: &str, info: &LayerAdditionalInfo) -> LayerAdditionalInfo {
    Harness::new().roundtrip_key(key, info)
}
