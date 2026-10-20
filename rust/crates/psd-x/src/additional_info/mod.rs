/*
File: rust/crates/psd-x/src/additional_info/mod.rs

Purpose:
PSD layer additional information (8BIM/8B64 "additional layer
information" sections). Port of upstream ag-psd `src/additionalInfo.ts`.

DELIBERATE DIVERGENCE FROM UPSTREAM LAYOUT:
upstream keeps everything in one `additionalInfo.ts` file (~5445 lines). Here it is
deliberately split into a DIRECTORY MODULE: `mod.rs` (framework + dispatcher) plus
one file per logical key group (`metadata_keys.rs`,
`text_keys.rs`, ...). Reason — file size, and so groups can be
filled by SEVERAL parallel workers independently of each other.
mod.rs owns the canonical key order (important for write — Photoshop
writes keys in handler-registration order, not data order) and
routes read/write to group-modules.

Main responsibilities:
- CANONICAL ORDERED key registry (mirror of `addHandler` call order);
- public read entry point `read_additional_info_key`;
- public write entry point `write_additional_info`;
- GROUP-MODULE CONTRACT implemented by each group-module.

Source compatibility:
- mirror of ag-psd `src/additionalInfo.ts` (`infoHandlers` /
  `infoHandlersMap`, `addHandler` / `addHandlerAlias` infrastructure, framing in
  `readAdditionalLayerInfo` / `writeAdditionalLayerInfo`).
*/

use crate::helpers::LARGE_ADDITIONAL_INFO_KEYS;
use crate::psd::{
    Annotation, LayerAdditionalInfo, LinkedFile, PsdArtboards, ReadOptions, WriteOptions,
};
use crate::reader::{PsdReader, ReadResult};
use crate::writer::{PsdWriter, WriteError, WriteResult, write_section, write_signature};

pub mod metadata_keys;

// Group modules (one per GROUP-MODULE CONTRACT below), each owning the keys
// in its `Group` tag.
pub mod adjustment_keys;
pub mod doc_keys;
pub mod effects_keys;
pub mod filter_fx;
pub mod linked_files;
pub mod misc_keys;
pub mod shmd;
pub mod smart_object_keys;
pub mod text_keys;
mod text_path;
pub mod timeline;
mod vector_fill;
pub mod vector_keys;

/// Shared section-level round-trip harness (no upstream counterpart).
///
/// Available under `cfg(test)` and the `test-support` feature so unit tests and
/// integration tests share one copy. See [`test_support`].
#[cfg(any(test, feature = "test-support"))]
pub mod test_support;

// ===========================================================================
// Group tags
// ===========================================================================

/// Logical key group. The dispatcher routes read/write to
/// the matching group-module by this tag.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Group {
    /// Simple scalar/string/enum keys (implemented: `metadata_keys.rs`).
    Metadata,
    /// Text layers (`TySh`, `Txt2`) — `text_keys.rs`.
    Text,
    /// Layer effects (`lmfx`, `lrFX`, `lfxs`, `lfx2`) — `effects_keys.rs`.
    Effects,
    /// Smart objects / linked / placed (`PlLd`, `SoLd`, `SoLE`, `lnk2`, `lnkE`,
    /// `PxSc`, `Patt`, ...) — `smart_object_keys.rs`.
    SmartObject,
    /// Vector masks / fills / strokes (`vmsk`, `vsms`, `vscg`, `vstk`,
    /// `vogk`, `vowv`, `SoCo`, `GdFl`, `PtFl`, `pths`) — `vector_keys.rs`.
    Vector,
    /// Adjustment layers (`brit`, `levl`, `curv`, ...) — `adjustment_keys.rs`.
    Adjustment,
    /// Everything else that did not fit the groups above (`Lr16`, `Lr32`, `LMsk`,
    /// `FMsk`, `FEid`, `Anno`, `shmd`, `artb`, `artd`, `cinf`, `extn`, `CAI `,
    /// `OCIO`, `GenI`, `sn2P`, `lfxs` neighbor, ...) — `misc_keys.rs`.
    Misc,
}

// ===========================================================================
// GROUP-MODULE CONTRACT
// ===========================================================================
//
// Each group-module implements:
//
// - `read(key, reader, info, left, ctx) -> ReadResult<Option<()>>`
//       Ok(Some(())) — key handled; Ok(None) — "not my key".
// - `has(key, info[, ctx]) -> Option<bool>`
//       Some(b) — this group owns the key; b = whether to write it;
//       None — "not my key".
// - `write(key, writer, info, ctx) -> Option<ReadResult<()>>`
//       Some(Ok(())) — written;
//       Some(Err(_)) — validation failed mid-body (partial bytes may already
//       be in the writer; they are NOT rewound);
//       None — "not my key".
//       Called ONLY when has == Some(true), inside an already-open writeSection.
//
// Public orchestration:
// - `write_additional_info(...) -> WriteResult<()>`.
//   Maps `Some(Err(e))` to `WriteError::Internal("<key>: <e>")`; dropping the
//   inner Result would report success for a truncated section. Callers that write into an external
//   stream must discard the stream on Err; Vec-backed `write_psd` is fine.

// ===========================================================================
// CANONICAL ORDERED key registry
// ===========================================================================

/// Canonical key-registry entry.
#[derive(Debug, Clone, Copy)]
pub struct KeyHandler {
    /// 4-character section key (as in the file; e.g. `"luni"`, `"CAI "`).
    pub key: &'static str,
    /// Logical group (selects the group-module).
    pub group: Group,
    /// `writeSection` round for writing: some keys write a 4-byte
    /// section length (round=4) instead of 2-byte (round=2). Mirror of `fourBytes`
    /// in `writeAdditionalLayerInfo`.
    pub four_bytes: bool,
    /// `writeTotalLength` for `writeSection` — mirror of the same-named flag.
    /// `true` for most keys; `false` for `Txt2`/`cinf`/`extn`/`CAI `/`OCIO`.
    pub write_total_length: bool,
}

const fn h(key: &'static str, group: Group) -> KeyHandler {
    KeyHandler {
        key,
        group,
        four_bytes: false,
        write_total_length: true,
    }
}

const fn h4(key: &'static str, group: Group) -> KeyHandler {
    KeyHandler {
        key,
        group,
        four_bytes: true,
        write_total_length: true,
    }
}

const fn h4_no_total(key: &'static str, group: Group) -> KeyHandler {
    KeyHandler {
        key,
        group,
        four_bytes: true,
        write_total_length: false,
    }
}

const fn h_no_total(key: &'static str, group: Group) -> KeyHandler {
    KeyHandler {
        key,
        group,
        four_bytes: false,
        write_total_length: false,
    }
}

/// CANONICAL ORDERED registry — THE SAME ORDER as the `addHandler` calls in
/// upstream (important for write: PS writes keys in handler-registration order).
///
/// Aliases (`addHandlerAlias`) do NOT add new entries to the write order —
/// they only make the key recognizable on read (see [`alias_target`]).
///
/// `fourBytes` / `writeTotalLength` repeat the upstream flags
/// `writeAdditionalLayerInfo`.
pub const HANDLERS: &[KeyHandler] = &[
    h("TySh", Group::Text), // NOT in fourBytes list upstream
    h("SoCo", Group::Vector),
    h4("GdFl", Group::Vector),
    h("PtFl", Group::Vector),
    h4("vscg", Group::Vector),
    h4("vmsk", Group::Vector),
    h("vowv", Group::Vector), // NOT in fourBytes list upstream
    h4("vogk", Group::Vector),
    h4("lmfx", Group::Effects),
    h4("lrFX", Group::Effects),
    h4("luni", Group::Metadata),
    h("lnsr", Group::Metadata),
    h("lyid", Group::Metadata),
    h("lsct", Group::Metadata),
    h("clbl", Group::Metadata),
    h("infx", Group::Metadata),
    h("knko", Group::Metadata),
    h("lmgm", Group::Metadata),
    h("lspf", Group::Metadata),
    h("lclr", Group::Metadata),
    h("shmd", Group::Misc),
    h("PxSc", Group::SmartObject),
    h("vstk", Group::Vector),
    h4("artb", Group::Misc),
    h("sn2P", Group::Misc),
    h4("PlLd", Group::SmartObject),
    h4("SoLd", Group::SmartObject),
    h("fxrp", Group::Metadata),
    h("Lr16", Group::Misc),
    h("Lr32", Group::Misc),
    h("LMsk", Group::Misc),
    h("Patt", Group::SmartObject),
    h("Patt", Group::SmartObject), // second Patt handler (upstream registers twice)
    h4_no_total("CAI ", Group::Misc),
    h4_no_total("CAI ", Group::Misc), // second CAI handler
    h4_no_total("OCIO", Group::Misc),
    h4("GenI", Group::Misc),
    h4("Anno", Group::Misc),
    h4("lnk2", Group::SmartObject), // createLnkHandler('lnk2') (in fourBytes list)
    h("lnkE", Group::SmartObject),  // createLnkHandler('lnkE') (NOT in fourBytes list upstream)
    h("pths", Group::Vector),
    h("lyvr", Group::Metadata),
    h("lfxs", Group::Effects),
    h("brit", Group::Adjustment),
    h("levl", Group::Adjustment),
    h4("curv", Group::Adjustment),
    h("expA", Group::Adjustment),
    h4("vibA", Group::Adjustment),
    h("hue2", Group::Adjustment),
    h("blnc", Group::Adjustment),
    h4("blwh", Group::Adjustment),
    h("phfl", Group::Adjustment),
    h("mixr", Group::Adjustment),
    h("clrL", Group::Adjustment),
    h("nvrt", Group::Adjustment),
    h("post", Group::Adjustment),
    h("thrs", Group::Adjustment),
    h4("grdm", Group::Adjustment),
    h("selc", Group::Adjustment),
    h4("CgEd", Group::Adjustment),
    h4_no_total("Txt2", Group::Text), // four_bytes + writeTotalLength=false
    h4("FEid", Group::Misc),
    h("FMsk", Group::Misc),
    h("artd", Group::Misc),
    h("lfx2", Group::Effects),
    h4_no_total("cinf", Group::Misc),
    h_no_total("extn", Group::Misc),
    h("iOpa", Group::Metadata),
    h("brst", Group::Metadata),
    h("tsly", Group::Metadata),
];

/// Read aliases (`addHandlerAlias(key, target)`): file key → target key
/// whose handler processes the data. These keys are NOT written.
pub const ALIASES: &[(&str, &str)] = &[
    ("vsms", "vmsk"),
    // Upstream comments out the reverse alias (`// addHandlerAlias('vmsk', 'vsms')`).
    // Mapping `vmsk` → `vsms` makes `group_for_key` miss the handler (vsms is not
    // in HANDLERS) and silently skip the section.
    ("lsdk", "lsct"),
    ("SoLE", "SoLd"),
    ("Pat2", "Patt"),
    ("Pat3", "Patt"),
    ("lnkD", "lnk2"),
    ("lnk3", "lnk2"),
    ("FXid", "FEid"),
];

/// Returns the alias target key (or the key itself if not an alias).
///
/// Used only on READ for routing: alias-key data is
/// read by the target-key handler. NOTE: when reading `lsdk`/`lsct` the group
/// is determined by the target key, but the actual key is passed to the group-module
/// unchanged (group-modules that handle aliases must account for both).
pub fn alias_target(key: &str) -> &str {
    for (alias, target) in ALIASES {
        if *alias == key {
            return target;
        }
    }
    key
}

/// Group the key belongs to (aliases considered). `None` if the key
/// is unknown.
pub fn group_for_key(key: &str) -> Option<Group> {
    let target = alias_target(key);
    HANDLERS.iter().find(|h| h.key == target).map(|h| h.group)
}

/// Whether the key uses a "large" (8-byte) section size. Mirror of
/// `largeAdditionalInfoKeys.indexOf(key) !== -1`.
pub fn is_large_key(key: &str) -> bool {
    LARGE_ADDITIONAL_INFO_KEYS.contains(&key)
}

// ===========================================================================
// Context structs (orchestration glue)
// ===========================================================================

/// Read context passed into group-modules. Mirror of the trailing arguments of
/// upstream `ReadMethod` (`psd`, `imageResources`) plus reader options.
///
/// Fields are optional references so the metadata group (which does not
/// need context) can be called without a fully built `Psd`.
/// Groups that need `psd`/resources (`Lr16`/`Lr32`, smart objects, linked
/// files) require those fields — that is part of the GROUP-MODULE CONTRACT.
pub struct ReadCtx<'a> {
    pub options: &'a ReadOptions,
    pub large: bool,
    /// Document being read. Present for document-level additional-info
    /// (e.g. `Lr16`/`Lr32`); absent when parsing per-layer extra data.
    pub psd: Option<&'a mut crate::psd::Psd>,
    /// Document pixel size for `vmsk` bezier denormalization (upstream passes
    /// `{width,height}` into the vmsk handler). Defaults to 1×1 when unknown.
    pub doc_width: f64,
    pub doc_height: f64,
}

impl<'a> ReadCtx<'a> {
    pub fn new(options: &'a ReadOptions, large: bool) -> Self {
        Self {
            options,
            large,
            psd: None,
            doc_width: 1.0,
            doc_height: 1.0,
        }
    }
}

/// Write context. Mirror of `ExtendedWriteOptions` (options + `layerIds` /
/// `layerToId` for id deduplication in `lyid`).
pub struct WriteCtx<'a> {
    pub options: &'a WriteOptions,
    pub psb: bool,
    /// already-used layer ids (see `lyid` handler: duplicates are shifted +100).
    pub layer_ids: std::collections::HashSet<u32>,
    /// Pointer identity map for `lyid` → resolved id (upstream `layerToId`).
    /// Key is `*const LayerAdditionalInfo as usize` of the write target.
    pub layer_to_id: std::collections::HashMap<usize, u32>,
    /// Document-level linked files for `lnk2`/`lnkE` (absent on per-layer writes).
    pub linked_files: Option<&'a [LinkedFile]>,
    /// Document-level artboards for `artd`.
    pub artboards: Option<&'a PsdArtboards>,
    /// Document-level annotations for `Anno`.
    pub annotations: Option<&'a [Annotation]>,
    /// Document pixel size for `vmsk` bezier normalization on write.
    pub doc_width: f64,
    pub doc_height: f64,
}

impl<'a> WriteCtx<'a> {
    pub fn new(options: &'a WriteOptions, psb: bool) -> Self {
        WriteCtx {
            options,
            psb,
            layer_ids: std::collections::HashSet::new(),
            layer_to_id: std::collections::HashMap::new(),
            linked_files: None,
            artboards: None,
            annotations: None,
            doc_width: 1.0,
            doc_height: 1.0,
        }
    }
}

// ===========================================================================
// PUBLIC READ ENTRY POINT
// ===========================================================================

/// Read the body of one additional-info key WITHIN an already-open section.
///
/// Mirror of the insides of `readAdditionalLayerInfo`: the calling orchestration
/// (`read_additional_layer_info` in reader.rs) itself reads
/// the `8BIM`/`8B64` signature and opens `readSection`, then calls this function
/// with `key` and a `left` closure (bytes remaining in the section).
///
/// Returns `Ok(true)` if the key was recognized and handled; `Ok(false)` if
/// the key is unknown (caller should `skip_bytes(reader, left())`).
///
/// STABLE SIGNATURE — orchestration and group-modules rely on it.
pub fn read_additional_info_key(
    key: &str,
    reader: &mut PsdReader,
    info: &mut LayerAdditionalInfo,
    left: &dyn Fn(&PsdReader) -> usize,
    ctx: &mut ReadCtx,
) -> ReadResult<bool> {
    let group = match group_for_key(key) {
        Some(g) => g,
        None => return Ok(false),
    };

    let result = match group {
        Group::Metadata => metadata_keys::read(key, reader, info, left, ctx)?,
        Group::Text => text_keys::read(key, reader, info, left, ctx)?,
        Group::Effects => effects_keys::read(key, reader, info, left, ctx)?,
        Group::SmartObject => smart_object_keys::read(key, reader, info, left, ctx)?,
        Group::Vector => vector_keys::read(key, reader, info, left, ctx)?,
        Group::Adjustment => adjustment_keys::read(key, reader, info, left, ctx)?,
        Group::Misc => misc_keys::read(key, reader, info, left, ctx)?,
    };

    Ok(result.is_some())
}

// ===========================================================================
// PUBLIC WRITE ENTRY POINT
// ===========================================================================

/// Write all layer additional-info sections in canonical order.
///
/// Mirror of `writeAdditionalLayerInfo`: iterates [`HANDLERS`] in order,
/// for each key asks its group-module `has(key, info)`; if
/// `Some(true)` — writes signature (`8BIM`/`8B64`) + key + section, delegating
/// the body to the group-module `write(key, ...)`.
///
/// Special cases from upstream:
/// - `Txt2` is skipped when `options.invalidate_text_layers`;
/// - `vmsk` is written as `vsms` when `psb`;
/// - `large` (8B64 / 8-byte length) is enabled when `psb && is_large_key`.
///
/// # Errors
///
/// A group-module write body that fails has already emitted a partial record
/// into `writer` (`write_linked_files`, for one, writes its 8-byte length
/// placeholder and part of a `liFD` record before `check_guid` rejects the id).
/// The buffer cannot be rewound, so the failure is converted to
/// [`WriteError::Internal`] and returned — a truncated section must fail the
/// whole write rather than be reported as a successful `write_psd`.
///
/// **Residual behaviour (not rolled back):** bytes written before the error stay
/// in the buffer. Callers that accumulate into a fresh `Vec` (`write_psd`) can
/// discard it on `Err`. Callers that write into an external stream
/// (`write_psd_to_writer`) must discard whatever was already flushed — the
/// stream is truncated mid-file.
///
/// # Breaking change
///
/// Previously returned `()`. Returning [`WriteResult`] is intentional: the old
/// signature dropped group-module `Err` values and reported success for corrupt
/// output.
///
/// STABLE SIGNATURE.
pub fn write_additional_info(
    writer: &mut PsdWriter,
    info: &LayerAdditionalInfo,
    ctx: &mut WriteCtx,
) -> WriteResult<()> {
    // `HANDLERS` mirrors upstream's read-side double registration (Patt, CAI);
    // the write side must not follow it — the second entry would emit the
    // whole section again, doubling the payload (and doubling once more on
    // every re-read-re-write cycle).
    let mut written_keys: std::collections::HashSet<&'static str> =
        std::collections::HashSet::new();
    for handler in HANDLERS {
        let mut key = handler.key;

        if !written_keys.insert(key) {
            continue;
        }

        // upstream: skip Txt2 when invalidating text layers.
        if key == "Txt2" && ctx.options.invalidate_text_layers == Some(true) {
            continue;
        }
        // upstream: vmsk -> vsms in PSB.
        if key == "vmsk" && ctx.psb {
            key = "vsms";
        }

        let has = group_has(handler.group, key, info, ctx);
        if has != Some(true) {
            continue;
        }

        let large = ctx.psb && is_large_key(key);
        let round = if handler.four_bytes { 4 } else { 2 };

        write_signature(writer, if large { "8B64" } else { "8BIM" })?;
        write_signature(writer, key)?;
        let write_total_length = handler.write_total_length;
        write_section(
            writer,
            round,
            |w| {
                let handled = group_write(handler.group, key, w, info, ctx);
                debug_assert!(
                    handled.is_some(),
                    "group did not handle write for key {key}"
                );
                match handled {
                    Some(result) => result.map_err(|e| WriteError::Internal(format!("{key}: {e}"))),
                    // `key` came out of HANDLERS, so its group must own it. The
                    // section header is already written, so the only honest
                    // outcome in release is a failed write.
                    None => Err(WriteError::Internal(format!(
                        "{key}: group-module has no write arm"
                    ))),
                }
            },
            write_total_length,
            large,
        )?;
    }
    Ok(())
}

// --- internal routing helpers ---------------------------------------------

fn group_has(
    group: Group,
    key: &str,
    info: &LayerAdditionalInfo,
    ctx: &WriteCtx<'_>,
) -> Option<bool> {
    match group {
        Group::Metadata => metadata_keys::has(key, info),
        Group::Text => text_keys::has(key, info),
        Group::Effects => effects_keys::has(key, info),
        Group::SmartObject => smart_object_keys::has(key, info, ctx),
        Group::Vector => vector_keys::has(key, info),
        Group::Adjustment => adjustment_keys::has(key, info),
        Group::Misc => misc_keys::has(key, info, ctx),
    }
}

/// Route one key's write body to its group-module.
///
/// Returns `None` when the group-module does not recognize the key — see the
/// GROUP-MODULE CONTRACT. Callers decide what that means; `write_additional_info`
/// treats it as a bug (the key came from [`HANDLERS`], so its group must own it).
fn group_write(
    group: Group,
    key: &str,
    writer: &mut PsdWriter,
    info: &LayerAdditionalInfo,
    ctx: &mut WriteCtx,
) -> Option<ReadResult<()>> {
    match group {
        Group::Metadata => metadata_keys::write(key, writer, info, ctx),
        Group::Text => text_keys::write(key, writer, info, ctx),
        Group::Effects => effects_keys::write(key, writer, info, ctx),
        Group::SmartObject => smart_object_keys::write(key, writer, info, ctx),
        Group::Vector => vector_keys::write(key, writer, info, ctx),
        Group::Adjustment => adjustment_keys::write(key, writer, info, ctx),
        Group::Misc => misc_keys::write(key, writer, info, ctx),
    }
}
