/*
File: rust/crates/psd-x/src/reader.rs

Purpose:
low-level reading of bytes from a PSD buffer (read cursor, number/string primitives).

Source compatibility:
- port of upstream ag-psd `src/psdReader.ts` (1:1 split).

Main responsibilities:
- mirror the corresponding upstream module when porting;
- keep this area's public contract in one place.
*/

// PORT STATUS: primitives and read orchestration ported.
//
// Ported: the low-level byte/string/section reader primitives that operate only
// on the reader buffer/offset plus scalar/length args, plus the full read
// orchestration (readPsd, readLayerInfo, readLayerRecord, readLayerMaskData,
// readLayerBlendingRanges, readLayerChannelImageData, decodeLayerImageData,
// readData, readDataRaw/Zip/RLE, readGlobalLayerMaskInfo,
// readAdditionalLayerInfo, readImageData, readColor, readPattern,
// the cmyk/indexed pixel helpers and the entry-point [`read_psd`]).

//! # Endianness
//!
//! PSD is **big-endian**. Upstream calls `DataView.getInt16/getUint16/getInt32/
//! getUint32/getFloat32/getFloat64` with the `littleEndian` argument either
//! omitted or explicitly `false` (e.g. `getInt16(off, false)`), which means
//! big-endian. The few `*LE` variants pass `true`. This port reproduces that:
//! all default readers use `from_be_bytes`, the `_le` variants use
//! `from_le_bytes`.
//!
//! # Error strategy
//!
//! Upstream throws `Error` in a handful of places (`checkSignature`,
//! `readSection` overflow, `warnOrThrow` when `strict`, the >100MB guard in
//! `readBytes`). It also reads past the end of a slice in some "broken file"
//! recovery paths. We model fallible operations as `Result<T, ReadError>` with
//! a small crate-local [`ReadError`] enum, returned consistently from every
//! primitive that can fail. This is preferred over panicking because callers
//! (the document orchestration) need to distinguish recoverable from
//! fatal conditions, mirroring upstream's `strict`/`warnOrThrow` split.

use crate::psd::ReadOptions;
use std::cell::RefCell;
use std::rc::Rc;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

/// Low-level reader errors (mirror of `throw new Error(...)` from upstream).
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum ReadError {
    /// Read past the end of the buffer (mirror of `Reading bytes exceeding buffer length`
    /// in strict mode, plus general bounds protection in the Rust port).
    #[error("Reading bytes exceeding buffer length")]
    UnexpectedEndOfBuffer,
    /// Guard for `Reading past end of file` (length > 100MB).
    #[error("Reading past end of file")]
    ReadingPastEndOfFile,
    /// `checkSignature`: signature matched neither `a` nor `b`.
    #[error("Invalid signature: '{signature}' at 0x{offset:x}")]
    InvalidSignature { signature: String, offset: usize },
    /// `readSection`: length > 4GB when reading an 8-byte size.
    #[error("Sizes larger than 4GB are not supported")]
    SizeTooLarge,
    /// `readSection`: section extends past the buffer.
    #[error("Section exceeds file size")]
    SectionExceedsFileSize,
    /// Upstream `Exceeded memory limit` (`totalMemoryLimit`).
    #[error("{category:?} allocation would use {observed} bytes; limit is {limit} bytes")]
    ExceededMemoryLimit {
        observed: usize,
        limit: usize,
        category: AllocationCategory,
    },
    /// The platform allocator rejected a policy-approved reservation.
    #[error("{category:?} allocation of {requested} bytes was rejected by the platform")]
    AllocationFailed {
        requested: usize,
        category: AllocationCategory,
    },
    /// Nested descriptor / engine-data structure deeper than the configured max.
    #[error("Recursion depth {observed} exceeds limit {limit}")]
    RecursionLimitExceeded { observed: u32, limit: u32 },
    /// Document side exceeded the configured format-aware ceiling.
    #[error("Document {width}x{height} exceeds side limit {limit}")]
    DocumentLimitExceeded { width: u32, height: u32, limit: u32 },
    /// Canvas pixel count exceeded the configured ceiling.
    #[error("Canvas pixels {pixels} exceed limit {limit}")]
    PixelLimitExceeded { pixels: u128, limit: u64 },
    /// Layer-record count exceeded the configured ceiling.
    #[error("Layer record count {observed} exceeds limit {limit}")]
    LayerLimitExceeded { observed: u64, limit: u32 },
    /// Invalid reader configuration or offset conversion.
    #[error("Invalid PSD input: {0}")]
    InvalidInput(String),
    /// `warnOrThrow` in strict mode (`Exceeded section limits` / `Unread section data`).
    #[error("{0}")]
    StrictViolation(String),
    /// ZIP-compressed channel data the caller was going to consume could not
    /// be decoded, and `ReadOptions::corrupt_channel_is_fatal` asked for that
    /// to be fatal instead of silently leaving the channel zeroed.
    #[error("corrupt channel {channel} data: {detail}")]
    CorruptChannel { channel: i16, detail: String },
}

/// Default untrusted-input memory budget (upstream `totalMemoryLimit` = 2 GiB).
pub const DEFAULT_TOTAL_MEMORY_LIMIT: usize = 2 * 1024 * 1024 * 1024;

/// Default max nesting for descriptor / engine-data descent.
pub const DEFAULT_MAX_RECURSION_DEPTH: u32 = 64;

/// Result of reader operations.
pub type ReadResult<T> = Result<T, ReadError>;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AllocationCategory {
    InputBuffer,
    Metadata,
    Channel,
    Mask,
    LinkedPayload,
    Descriptor,
    EngineData,
    Raster,
}

impl AllocationCategory {
    const fn index(self) -> usize {
        match self {
            Self::InputBuffer => 0,
            Self::Metadata => 1,
            Self::Channel => 2,
            Self::Mask => 3,
            Self::LinkedPayload => 4,
            Self::Descriptor => 5,
            Self::EngineData => 6,
            Self::Raster => 7,
        }
    }

    const fn is_metadata(self) -> bool {
        matches!(self, Self::Metadata | Self::Descriptor | Self::EngineData)
    }
}

const ALLOCATION_CATEGORY_COUNT: usize = 8;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ParserAllocationObservations {
    pub limit_bytes: usize,
    pub metadata_limit_bytes: usize,
    pub live_bytes: usize,
    pub high_water_bytes: usize,
    pub metadata_high_water_bytes: usize,
    pub category_high_water_bytes: AllocationCategoryObservations,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AllocationCategoryObservations {
    pub input_buffer: usize,
    pub metadata: usize,
    pub channel: usize,
    pub mask: usize,
    pub linked_payload: usize,
    pub descriptor: usize,
    pub engine_data: usize,
    pub raster: usize,
}

impl From<[usize; ALLOCATION_CATEGORY_COUNT]> for AllocationCategoryObservations {
    fn from(values: [usize; ALLOCATION_CATEGORY_COUNT]) -> Self {
        Self {
            input_buffer: values[AllocationCategory::InputBuffer.index()],
            metadata: values[AllocationCategory::Metadata.index()],
            channel: values[AllocationCategory::Channel.index()],
            mask: values[AllocationCategory::Mask.index()],
            linked_payload: values[AllocationCategory::LinkedPayload.index()],
            descriptor: values[AllocationCategory::Descriptor.index()],
            engine_data: values[AllocationCategory::EngineData.index()],
            raster: values[AllocationCategory::Raster.index()],
        }
    }
}

#[derive(Debug)]
struct AllocationState {
    limit: usize,
    metadata_limit: usize,
    live: usize,
    high_water: usize,
    metadata_live: usize,
    metadata_high_water: usize,
    category_live: [usize; ALLOCATION_CATEGORY_COUNT],
    category_high_water: [usize; ALLOCATION_CATEGORY_COUNT],
}

#[derive(Debug, Clone)]
struct AllocationLedger(Rc<RefCell<AllocationState>>);

impl AllocationLedger {
    fn new(limit: usize, metadata_limit: usize) -> Self {
        Self(Rc::new(RefCell::new(AllocationState {
            limit,
            metadata_limit,
            live: 0,
            high_water: 0,
            metadata_live: 0,
            metadata_high_water: 0,
            category_live: [0; ALLOCATION_CATEGORY_COUNT],
            category_high_water: [0; ALLOCATION_CATEGORY_COUNT],
        })))
    }

    fn reserve(&self, category: AllocationCategory, bytes: usize) -> ReadResult<AllocationLease> {
        let mut state = self.0.borrow_mut();
        let observed = state
            .live
            .checked_add(bytes)
            .ok_or(ReadError::SizeTooLarge)?;
        if observed > state.limit {
            return Err(ReadError::ExceededMemoryLimit {
                observed,
                limit: state.limit,
                category,
            });
        }
        let metadata_observed = if category.is_metadata() {
            state
                .metadata_live
                .checked_add(bytes)
                .ok_or(ReadError::SizeTooLarge)?
        } else {
            state.metadata_live
        };
        if metadata_observed > state.metadata_limit {
            return Err(ReadError::ExceededMemoryLimit {
                observed: metadata_observed,
                limit: state.metadata_limit,
                category,
            });
        }
        state.live = observed;
        state.high_water = state.high_water.max(observed);
        if category.is_metadata() {
            state.metadata_live = metadata_observed;
            state.metadata_high_water = state.metadata_high_water.max(metadata_observed);
        }
        let index = category.index();
        state.category_live[index] = state.category_live[index]
            .checked_add(bytes)
            .ok_or(ReadError::SizeTooLarge)?;
        state.category_high_water[index] =
            state.category_high_water[index].max(state.category_live[index]);
        drop(state);
        Ok(AllocationLease {
            ledger: self.clone(),
            category,
            bytes,
            persistent: false,
        })
    }

    fn observations(&self) -> ParserAllocationObservations {
        let state = self.0.borrow();
        ParserAllocationObservations {
            limit_bytes: state.limit,
            metadata_limit_bytes: state.metadata_limit,
            live_bytes: state.live,
            high_water_bytes: state.high_water,
            metadata_high_water_bytes: state.metadata_high_water,
            category_high_water_bytes: state.category_high_water.into(),
        }
    }

    fn release(&self, category: AllocationCategory, bytes: usize) {
        let mut state = self.0.borrow_mut();
        state.live = state.live.saturating_sub(bytes);
        if category.is_metadata() {
            state.metadata_live = state.metadata_live.saturating_sub(bytes);
        }
        let index = category.index();
        state.category_live[index] = state.category_live[index].saturating_sub(bytes);
    }
}

#[derive(Debug)]
pub struct AllocationLease {
    ledger: AllocationLedger,
    category: AllocationCategory,
    bytes: usize,
    persistent: bool,
}

impl AllocationLease {
    /// Retain the charge for data moved into the parsed document model.
    pub fn persist(mut self) {
        self.persistent = true;
    }
}

impl Drop for AllocationLease {
    fn drop(&mut self) {
        if self.persistent {
            return;
        }
        self.ledger.release(self.category, self.bytes);
    }
}

#[derive(Debug, Clone, Default)]
pub struct ReadCancellationToken(Arc<AtomicBool>);

impl ReadCancellationToken {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn cancel(&self) {
        self.0.store(true, Ordering::Release);
    }

    pub fn is_cancelled(&self) -> bool {
        self.0.load(Ordering::Acquire)
    }
}

/// Low-level reader state (mirror of TS `interface PsdReader extends ReadOptions`).
///
/// Product callers (Cloud and browser WASM) pass a borrowed byte slice.
/// TS `DataView(buffer, offset, length)` shifts the view base; here that is
/// expressed by the caller passing an already-trimmed slice (as
/// `createReader(buffer, offset, length)` creates a view on a sub-range). The
/// `offset` field is the cursor position inside `buffer`, exactly like `reader.offset`.
#[derive(Debug)]
pub struct PsdReader<'a> {
    input: &'a [u8],
    pub offset: usize,
    // mirror of ReadOptions fields that upstream mixes into the reader.
    pub strict: bool,
    pub debug: bool,
    pub large: bool,
    pub global_alpha: bool,
    pub options: ReadOptions,
    allocation_ledger: AllocationLedger,
    /// Internal image resource 1026 (`layersGroup`) — applied in [`read_layer_info`].
    pub layers_group: Vec<f64>,
    /// Internal image resource 1072 (`layerGroupsEnabledId`).
    pub layer_groups_enabled_id: Vec<f64>,
    /// Cumulative layer records across the main and alternate layer sections.
    pub layer_records_seen: u64,
    /// Document pixel size from the PSD header (for `vmsk` bezier scale).
    pub doc_width: f64,
    pub doc_height: f64,
}

impl<'a> PsdReader<'a> {
    /// Mirror of `createReader(buffer, offset?, length?)`.
    ///
    /// Upstream `offset`/`length` define a `DataView` window; here that is expressed
    /// as a sub-slice `buffer[offset..offset+length]`. If `length` is unset — through
    /// the end of the buffer. The cursor (`offset` field) always starts at 0 relative to
    /// the window, as upstream (`offset: 0`).
    pub fn new(buffer: &'a [u8], offset: Option<usize>, length: Option<usize>) -> PsdReader<'a> {
        let start = offset.unwrap_or(0);
        let end = length.and_then(|len| start.checked_add(len));
        let window = match (start <= buffer.len(), end) {
            (true, Some(end)) if end <= buffer.len() => &buffer[start..end],
            (true, None) if length.is_none() => &buffer[start..],
            _ => &buffer[..0],
        };
        PsdReader {
            input: window,
            offset: 0,
            strict: false,
            debug: false,
            large: false,
            global_alpha: false,
            options: ReadOptions::default(),
            allocation_ledger: AllocationLedger::new(
                DEFAULT_TOTAL_MEMORY_LIMIT,
                DEFAULT_TOTAL_MEMORY_LIMIT,
            ),
            layers_group: Vec::new(),
            layer_groups_enabled_id: Vec::new(),
            layer_records_seen: 0,
            doc_width: 1.0,
            doc_height: 1.0,
        }
    }

    fn child(buffer: &'a [u8], parent: &PsdReader<'_>) -> PsdReader<'a> {
        let mut child = PsdReader::new(buffer, None, None);
        child.strict = parent.strict;
        child.debug = parent.debug;
        child.large = parent.large;
        child.options = parent.options.clone();
        child.allocation_ledger = parent.allocation_ledger.clone();
        child
    }

    pub fn len(&self) -> usize {
        self.input.len()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    fn read_exact_at(&self, offset: usize, output: &mut [u8]) -> ReadResult<()> {
        let end = offset
            .checked_add(output.len())
            .ok_or(ReadError::SizeTooLarge)?;
        if end > self.len() {
            return Err(ReadError::UnexpectedEndOfBuffer);
        }
        output.copy_from_slice(&self.input[offset..end]);
        Ok(())
    }

    fn read_vec_at(
        &self,
        offset: usize,
        length: usize,
        category: AllocationCategory,
        persistent: bool,
    ) -> ReadResult<Vec<u8>> {
        let lease = self.reserve_allocation(category, length)?;
        let mut output = Vec::new();
        output
            .try_reserve_exact(length)
            .map_err(|_| ReadError::AllocationFailed {
                requested: length,
                category,
            })?;
        output.resize(length, 0);
        self.read_exact_at(offset, &mut output)?;
        if persistent {
            lease.persist();
        }
        Ok(output)
    }

    pub fn max_recursion_depth(&self) -> u32 {
        self.options
            .max_recursion_depth
            .unwrap_or(DEFAULT_MAX_RECURSION_DEPTH)
    }

    pub fn reserve_allocation(
        &self,
        category: AllocationCategory,
        bytes: usize,
    ) -> ReadResult<AllocationLease> {
        self.allocation_ledger.reserve(category, bytes)
    }

    pub fn allocation_observations(&self) -> ParserAllocationObservations {
        self.allocation_ledger.observations()
    }

    /// Configure allocation ceilings for callers that parse through an existing reader.
    pub fn configure_allocation_limits(
        &mut self,
        total_limit: usize,
        metadata_limit: usize,
    ) -> ReadResult<()> {
        self.allocation_ledger = AllocationLedger::new(total_limit, metadata_limit);
        Ok(())
    }
}

/// Upstream `isValidBoxSize` (psdReader.ts:467).
pub fn is_valid_box_size(top: f64, left: f64, bottom: f64, right: f64, large: bool) -> bool {
    let width = right - left;
    let height = bottom - top;
    let max_size = if large { 300_000.0 } else { 30_000.0 };
    width >= 0.0 && height >= 0.0 && width <= max_size && height <= max_size
}

/// Mirror of `warnOrThrow(reader, message)`.
///
/// In strict mode upstream throws — here we return `Err`. Outside
/// strict (with `debug`) — just logging, which we omit as behavior,
/// not data; return `Ok(())`.
pub fn warn_or_throw(reader: &PsdReader, message: &str) -> ReadResult<()> {
    if reader.strict {
        return Err(ReadError::StrictViolation(message.to_string()));
    }
    // `if (reader.debug) reader.log(message);` — log omitted.
    Ok(())
}

// ===========================================================================
// Scalar readers (big-endian, except *_le)
// ===========================================================================

#[inline]
fn ensure(reader: &PsdReader, len: usize) -> ReadResult<usize> {
    let start = reader.offset;
    let end = start.checked_add(len).ok_or(ReadError::SizeTooLarge)?;
    if end > reader.len() {
        return Err(ReadError::UnexpectedEndOfBuffer);
    }
    Ok(start)
}

/// Convert a validated untrusted size to the platform allocation/index type.
pub fn checked_platform_size(value: u128) -> ReadResult<usize> {
    usize::try_from(value).map_err(|_| ReadError::SizeTooLarge)
}

fn read_array<const N: usize>(reader: &PsdReader, start: usize) -> ReadResult<[u8; N]> {
    let mut bytes = [0_u8; N];
    reader.read_exact_at(start, &mut bytes)?;
    Ok(bytes)
}

pub fn read_uint8(reader: &mut PsdReader) -> ReadResult<u8> {
    let start = ensure(reader, 1)?;
    reader.offset += 1;
    Ok(read_array::<1>(reader, start)?[0])
}

/// Mirror of `peekUint8` — reads without advancing the cursor.
pub fn peek_uint8(reader: &PsdReader) -> ReadResult<u8> {
    let start = ensure(reader, 1)?;
    Ok(read_array::<1>(reader, start)?[0])
}

/// Does upstream have `readInt8`? No separate function, but the task asks for it —
/// implement via signed interpretation of the byte (DataView.getInt8).
pub fn read_int8(reader: &mut PsdReader) -> ReadResult<i8> {
    Ok(read_uint8(reader)? as i8)
}

pub fn read_int16(reader: &mut PsdReader) -> ReadResult<i16> {
    let start = ensure(reader, 2)?;
    reader.offset += 2;
    Ok(i16::from_be_bytes(read_array(reader, start)?))
}

pub fn read_uint16(reader: &mut PsdReader) -> ReadResult<u16> {
    let start = ensure(reader, 2)?;
    reader.offset += 2;
    Ok(u16::from_be_bytes(read_array(reader, start)?))
}

/// Mirror of `readUint16LE` (little-endian).
pub fn read_uint16_le(reader: &mut PsdReader) -> ReadResult<u16> {
    let start = ensure(reader, 2)?;
    reader.offset += 2;
    Ok(u16::from_le_bytes(read_array(reader, start)?))
}

pub fn read_int32(reader: &mut PsdReader) -> ReadResult<i32> {
    let start = ensure(reader, 4)?;
    reader.offset += 4;
    Ok(i32::from_be_bytes(read_array(reader, start)?))
}

/// Mirror of `readInt32LE` (little-endian).
pub fn read_int32_le(reader: &mut PsdReader) -> ReadResult<i32> {
    let start = ensure(reader, 4)?;
    reader.offset += 4;
    Ok(i32::from_le_bytes(read_array(reader, start)?))
}

pub fn read_uint32(reader: &mut PsdReader) -> ReadResult<u32> {
    let start = ensure(reader, 4)?;
    reader.offset += 4;
    Ok(u32::from_be_bytes(read_array(reader, start)?))
}

pub fn read_float32(reader: &mut PsdReader) -> ReadResult<f32> {
    let start = ensure(reader, 4)?;
    reader.offset += 4;
    Ok(f32::from_be_bytes(read_array(reader, start)?))
}

pub fn read_float64(reader: &mut PsdReader) -> ReadResult<f64> {
    let start = ensure(reader, 8)?;
    reader.offset += 8;
    Ok(f64::from_be_bytes(read_array(reader, start)?))
}

/// Mirror of `readFixedPoint32` — 32-bit fixed-point 16.16 number.
pub fn read_fixed_point32(reader: &mut PsdReader) -> ReadResult<f64> {
    Ok(read_int32(reader)? as f64 / (1i64 << 16) as f64)
}

/// Mirror of `readFixedPointPath32` — 32-bit fixed-point 8.24 number.
pub fn read_fixed_point_path32(reader: &mut PsdReader) -> ReadResult<f64> {
    Ok(read_int32(reader)? as f64 / (1i64 << 24) as f64)
}

/// Mirror of `readBytes(reader, length)`.
///
/// When past the end of the buffer, upstream warns (or throws in
/// strict), then returns a zeroed buffer of the requested length, partially filled
/// with the available bytes (fix for truncated PSDs). Guard: length > 100MB → throw.
///
/// Returns `Vec<u8>`, not a slice: in the common case this is `buffer[start..start+len]`
/// (like a zero-copy sub-Uint8Array upstream), but the recovery path needs
/// its own buffer, so for a uniform signature we return an owning
/// `Vec`. For a zero-copy sub-slice see [`read_bytes_slice`].
pub fn read_bytes(reader: &mut PsdReader, length: usize) -> ReadResult<Vec<u8>> {
    read_bytes_in_category(reader, length, AllocationCategory::Metadata, false)
}

/// Read bytes retained by the parsed document and keep their ledger charge live.
pub fn read_bytes_owned(
    reader: &mut PsdReader,
    length: usize,
    category: AllocationCategory,
) -> ReadResult<Vec<u8>> {
    read_bytes_in_category(reader, length, category, true)
}

/// Read a temporary category-specific buffer; its charge is released on return.
pub fn read_bytes_category(
    reader: &mut PsdReader,
    length: usize,
    category: AllocationCategory,
) -> ReadResult<Vec<u8>> {
    read_bytes_in_category(reader, length, category, false)
}

fn read_bytes_in_category(
    reader: &mut PsdReader,
    length: usize,
    category: AllocationCategory,
    persistent: bool,
) -> ReadResult<Vec<u8>> {
    let start = reader.offset;
    reader.offset = reader
        .offset
        .checked_add(length)
        .ok_or(ReadError::SizeTooLarge)?;

    if reader.offset > reader.len() {
        // fix for truncated PSDs missing the end of the file.
        warn_or_throw(reader, "Reading bytes exceeding buffer length")?;
        if length > 100 * 1024 * 1024 {
            return Err(ReadError::ReadingPastEndOfFile);
        }
        let lease = reader.reserve_allocation(category, length)?;
        let mut result = Vec::new();
        result
            .try_reserve_exact(length)
            .map_err(|_| ReadError::AllocationFailed {
                requested: length,
                category,
            })?;
        result.resize(length, 0);
        let avail = reader.len().saturating_sub(start);
        let len = length.min(avail);
        if len > 0 {
            reader.read_exact_at(start, &mut result[..len])?;
        }
        if persistent {
            lease.persist();
        }
        Ok(result)
    } else {
        reader.read_vec_at(start, length, category, persistent)
    }
}

/// Zero-copy byte-read variant: returns a sub-slice of the source buffer.
///
/// Equivalent of the successful (non-recovery) upstream branch
/// `new Uint8Array(reader.view.buffer, start, length)`. Errors if it goes
/// past the buffer (no recovery branch here — that needs allocation).
pub fn read_bytes_slice<'a>(reader: &mut PsdReader<'a>, length: usize) -> ReadResult<&'a [u8]> {
    let start = ensure(reader, length)?;
    reader.offset += length;
    Ok(&reader.input[start..start + length])
}

/// Mirror of `skipBytes(reader, count)`.
pub fn skip_bytes(reader: &mut PsdReader, count: usize) {
    reader.offset = reader.offset.checked_add(count).unwrap_or(usize::MAX);
}

// ===========================================================================
// String readers
// ===========================================================================

/// Mirror of private `readShortString(reader, length)`.
///
/// Upstream builds the string via `String.fromCharCode(byte)` for each byte —
/// i.e. **each byte 0..=255 becomes a UTF-16 code unit** (Latin-1-like);
/// this is NOT UTF-8 decoding. Reproduce exactly: each byte → `char`.
pub fn read_short_string(reader: &mut PsdReader, length: usize) -> ReadResult<String> {
    let buffer = read_bytes(reader, length)?;
    let capacity = buffer.len().checked_mul(2).ok_or(ReadError::SizeTooLarge)?;
    let lease = reader.reserve_allocation(AllocationCategory::Metadata, capacity)?;
    let mut result = String::new();
    result
        .try_reserve_exact(capacity)
        .map_err(|_| ReadError::AllocationFailed {
            requested: capacity,
            category: AllocationCategory::Metadata,
        })?;
    for &b in &buffer {
        result.push(b as char); // char::from(u8) == fromCharCode for 0..=255
    }
    drop(lease);
    Ok(result)
}

/// Mirror of `readAsciiString(reader, length)`.
pub fn read_ascii_string(reader: &mut PsdReader, length: usize) -> ReadResult<String> {
    let capacity = length.checked_mul(2).ok_or(ReadError::SizeTooLarge)?;
    let lease = reader.reserve_allocation(AllocationCategory::Metadata, capacity)?;
    let mut result = String::new();
    result
        .try_reserve_exact(capacity)
        .map_err(|_| ReadError::AllocationFailed {
            requested: capacity,
            category: AllocationCategory::Metadata,
        })?;
    for _ in 0..length {
        result.push(read_uint8(reader)? as char);
    }
    drop(lease);
    Ok(result)
}

/// Mirror of `readSignature(reader)` — 4-byte signature.
pub fn read_signature(reader: &mut PsdReader) -> ReadResult<String> {
    read_short_string(reader, 4)
}

/// Mirror of `validSignatureAt(reader, offset)` — `8BIM`/`8B64` at an absolute offset.
pub fn valid_signature_at(reader: &PsdReader, offset: usize) -> bool {
    if offset.checked_add(4).is_none_or(|end| end > reader.len()) {
        return false;
    }
    read_array::<4>(reader, offset).is_ok_and(|sig| sig == *b"8BIM" || sig == *b"8B64")
}

/// Mirror of `readPascalString(reader, padTo)`.
///
/// Layout: 1 length byte, then `length` text bytes, then padding so that
/// `(length + 1)` (count includes the length byte) is a multiple of `padTo`.
pub fn read_pascal_string(reader: &mut PsdReader, pad_to: usize) -> ReadResult<String> {
    if pad_to == 0 {
        return Err(ReadError::InvalidInput(
            "Pascal-string alignment must be non-zero".to_owned(),
        ));
    }
    let mut length = read_uint8(reader)? as usize;
    let text = if length != 0 {
        read_short_string(reader, length)?
    } else {
        String::new()
    };

    // `while (++length % padTo) reader.offset++;`
    loop {
        length = length.checked_add(1).ok_or(ReadError::SizeTooLarge)?;
        if length % pad_to == 0 {
            break;
        }
        reader.offset = reader
            .offset
            .checked_add(1)
            .ok_or(ReadError::SizeTooLarge)?;
    }

    Ok(text)
}

/// Mirror of `readUnicodeString(reader)` — uint32 length (in code units), then the string.
pub fn read_unicode_string(reader: &mut PsdReader) -> ReadResult<String> {
    let length = read_uint32(reader)? as usize;
    read_unicode_string_with_length(reader, length)
}

/// Mirror of `readUnicodeStringWithLength(reader, length)` (big-endian uint16 code units).
///
/// Each code unit is read as `readUint16` and appended via
/// `String.fromCharCode`; a final `\0` (value 0 at the last position)
/// is dropped. See [`push_code_unit`] about surrogates.
pub fn read_unicode_string_with_length(
    reader: &mut PsdReader,
    length: usize,
) -> ReadResult<String> {
    let bytes = length
        .checked_mul(std::mem::size_of::<u16>())
        .ok_or(ReadError::SizeTooLarge)?;
    let lease = reader.reserve_allocation(AllocationCategory::Metadata, bytes)?;
    let mut units: Vec<u16> = Vec::new();
    units
        .try_reserve_exact(length)
        .map_err(|_| ReadError::AllocationFailed {
            requested: bytes,
            category: AllocationCategory::Metadata,
        })?;
    let mut remaining = length;
    while remaining > 0 {
        remaining -= 1;
        let value = read_uint16(reader)?;
        // `if (value || length > 0)` — strip trailing \0 (last iteration).
        if value != 0 || remaining > 0 {
            units.push(value);
        }
    }
    let result = utf16_units_to_string(&units)?;
    drop(lease);
    Ok(result)
}

/// Mirror of `readUnicodeStringWithLengthLE` (little-endian uint16 code units).
pub fn read_unicode_string_with_length_le(
    reader: &mut PsdReader,
    length: usize,
) -> ReadResult<String> {
    let bytes = length
        .checked_mul(std::mem::size_of::<u16>())
        .ok_or(ReadError::SizeTooLarge)?;
    let lease = reader.reserve_allocation(AllocationCategory::Metadata, bytes)?;
    let mut units: Vec<u16> = Vec::new();
    units
        .try_reserve_exact(length)
        .map_err(|_| ReadError::AllocationFailed {
            requested: bytes,
            category: AllocationCategory::Metadata,
        })?;
    let mut remaining = length;
    while remaining > 0 {
        remaining -= 1;
        let value = read_uint16_le(reader)?;
        if value != 0 || remaining > 0 {
            units.push(value);
        }
    }
    let result = utf16_units_to_string(&units)?;
    drop(lease);
    Ok(result)
}

/// Build a string from UTF-16 code units.
///
/// Upstream accumulates a JS string directly from `fromCharCode(unit)`, which
/// allows lone surrogates. Rust `String` stores only valid scalar
/// values, so for broken/lone surrogates we use
/// `decode_utf16` with U+FFFD replacement — for all well-formed PSD strings the result
/// matches upstream.
fn utf16_units_to_string(units: &[u16]) -> ReadResult<String> {
    let capacity = units.len().checked_mul(3).ok_or(ReadError::SizeTooLarge)?;
    let mut result = String::new();
    result
        .try_reserve_exact(capacity)
        .map_err(|_| ReadError::AllocationFailed {
            requested: capacity,
            category: AllocationCategory::Metadata,
        })?;
    for value in char::decode_utf16(units.iter().copied()) {
        result.push(value.unwrap_or(char::REPLACEMENT_CHARACTER));
    }
    Ok(result)
}

/// Mirror of `checkSignature(reader, a, b?)`.
///
/// Reads a 4-byte signature; if it equals neither `a` nor (optionally) `b` —
/// returns `Err(InvalidSignature)` (upstream `throw`).
pub fn check_signature(reader: &mut PsdReader, a: &str, b: Option<&str>) -> ReadResult<()> {
    let offset = reader.offset;
    let signature = read_signature(reader)?;

    if signature != a && Some(signature.as_str()) != b {
        return Err(ReadError::InvalidSignature { signature, offset });
    }
    Ok(())
}

// ===========================================================================
// Section helper
// ===========================================================================

/// Mirror of `readSection<T>(reader, round, func, skipEmpty = true, eightBytes = false)`.
///
/// Reads a length-prefixed section, calls `func` with a `left()` closure
/// (bytes remaining until section end), then aligns the cursor to the section end
/// rounded so that `length` becomes a multiple of `round`.
///
/// Rounding logic reproduced exactly: `while (length % round) { length++; end++; }`.
///
/// `func` takes `&mut PsdReader` and `&dyn Fn(&PsdReader) -> usize` (computing
/// `left()`). Because Rust does not let a closure capture `reader` that is
/// also passed mutably into `func`, `left` takes the current reader
/// as an explicit argument — equivalent to upstream, where `left` reads `reader.offset`.
pub fn read_section<T, F>(
    reader: &mut PsdReader,
    round: usize,
    func: F,
    skip_empty: bool,
    eight_bytes: bool,
) -> ReadResult<Option<T>>
where
    F: FnOnce(&mut PsdReader, &dyn Fn(&PsdReader) -> usize) -> ReadResult<T>,
{
    let mut length = read_uint32(reader)? as usize;

    if eight_bytes {
        if length != 0 {
            return Err(ReadError::SizeTooLarge);
        }
        length = read_uint32(reader)? as usize;
    }

    // `if (length <= 0 && skipEmpty) return undefined;` (length unsigned → == 0)
    if length == 0 && skip_empty {
        return Ok(None);
    }

    let mut end = reader
        .offset
        .checked_add(length)
        .ok_or(ReadError::SizeTooLarge)?;
    if end > reader.len() {
        return Err(ReadError::SectionExceedsFileSize);
    }
    // Reject absurd section lengths against the remaining decode budget.
    let allocation = reader.allocation_observations();
    let observed = allocation
        .live_bytes
        .checked_add(length)
        .ok_or(ReadError::SizeTooLarge)?;
    if observed > allocation.limit_bytes {
        return Err(ReadError::ExceededMemoryLimit {
            observed,
            limit: allocation.limit_bytes,
            category: AllocationCategory::Metadata,
        });
    }

    let left = move |r: &PsdReader| end_minus_offset(end, r);
    let result = func(reader, &left)?;

    if reader.offset != end {
        if reader.offset > end {
            warn_or_throw(reader, "Exceeded section limits")?;
        } else {
            warn_or_throw(reader, "Unread section data")?;
        }
    }

    if round == 0 {
        return Err(ReadError::InvalidInput(
            "section alignment must be non-zero".to_owned(),
        ));
    }
    let padding = (round - (length % round)) % round;
    end = end.checked_add(padding).ok_or(ReadError::SizeTooLarge)?;

    reader.offset = end;

    Ok(Some(result))
}

#[inline]
fn end_minus_offset(end: usize, reader: &PsdReader) -> usize {
    end.saturating_sub(reader.offset)
}

// ===========================================================================
// Document orchestration (port of psdReader.ts readPsd & friends)
// ===========================================================================

use crate::additional_info::{ReadCtx, read_additional_info_key};
use crate::helpers::{
    ColorSpace, LayerMaskFlags, MaskParams, decode_bitmap, offset_for_channel, to_blend_mode,
    try_create_image_data, try_image_data_to_canvas,
};
use crate::image_resources::read_image_resource;
use crate::psd::{
    ChannelId, Cmyk, Color, ColorMode, Compression, GlobalLayerMaskInfo, Grayscale, Hsb,
    ImageResources, Lab, Layer, LayerAdditionalInfo, LayerMaskData, LayerRawData,
    LayerRawDataChannel, PatternBounds, PatternInfo, PixelData, Rgb, SectionDividerType,
};

/// Internal per-channel `{ id, length }` (mirror of TS `ChannelInfo`).
#[derive(Debug, Clone, Copy)]
struct ChannelInfo {
    id: i16,
    length: usize,
}

/// Mirror `supportedColorModes`.
fn is_supported_color_mode(mode: u16) -> bool {
    matches!(mode, 0 | 1 | 3 | 2) // Bitmap, Grayscale, RGB, Indexed
}

fn color_mode_from_u16(mode: u16) -> Option<ColorMode> {
    Some(match mode {
        0 => ColorMode::Bitmap,
        1 => ColorMode::Grayscale,
        2 => ColorMode::Indexed,
        3 => ColorMode::Rgb,
        4 => ColorMode::Cmyk,
        7 => ColorMode::Multichannel,
        8 => ColorMode::Duotone,
        9 => ColorMode::Lab,
        _ => return None,
    })
}

/// Pixel storage backing a `PixelData` during decode.
///
/// Mirrors upstream TypedArray views: samples are stored native-endian at
/// `depth` bits (8 / 16 / 32), interleaved by `channels`.
pub struct DecodeTarget {
    pub width: usize,
    pub height: usize,
    /// Native-endian interleaved sample bytes.
    pub data: Vec<u8>,
    pub channels: usize,
    /// Bits per sample: 8, 16, or 32.
    pub depth: u32,
}

impl DecodeTarget {
    pub fn rgba(width: usize, height: usize) -> DecodeTarget {
        Self::rgba_depth(width, height, 8)
    }

    pub fn rgba_depth(width: usize, height: usize, depth: u32) -> DecodeTarget {
        let bps = bytes_per_sample(depth);
        DecodeTarget {
            width,
            height,
            data: vec![
                0u8;
                width
                    .saturating_mul(height)
                    .saturating_mul(4)
                    .saturating_mul(bps)
            ],
            channels: 4,
            depth,
        }
    }

    pub fn wide(width: usize, height: usize, channels: usize) -> DecodeTarget {
        DecodeTarget {
            width,
            height,
            data: vec![0u8; width.saturating_mul(height).saturating_mul(channels)],
            channels,
            depth: 8,
        }
    }

    fn try_tracked(
        reader: &PsdReader<'_>,
        width: usize,
        height: usize,
        channels: usize,
        depth: u32,
        category: AllocationCategory,
    ) -> ReadResult<DecodeTarget> {
        let (target, lease) =
            Self::try_temporary(reader, width, height, channels, depth, category)?;
        lease.persist();
        Ok(target)
    }

    fn try_temporary(
        reader: &PsdReader<'_>,
        width: usize,
        height: usize,
        channels: usize,
        depth: u32,
        category: AllocationCategory,
    ) -> ReadResult<(DecodeTarget, AllocationLease)> {
        let bytes = width
            .checked_mul(height)
            .and_then(|value| value.checked_mul(channels))
            .and_then(|value| value.checked_mul(bytes_per_sample(depth)))
            .ok_or(ReadError::SizeTooLarge)?;
        let lease = reader.reserve_allocation(category, bytes)?;
        let mut data = Vec::new();
        data.try_reserve_exact(bytes)
            .map_err(|_| ReadError::AllocationFailed {
                requested: bytes,
                category,
            })?;
        data.resize(bytes, 0);
        Ok((
            DecodeTarget {
                width,
                height,
                data,
                channels,
                depth,
            },
            lease,
        ))
    }

    pub fn bytes_per_sample(&self) -> usize {
        bytes_per_sample(self.depth)
    }

    pub fn into_pixel_data(self) -> PixelData {
        PixelData {
            width: self.width as u32,
            height: self.height as u32,
            data: self.data,
            depth: self.depth as u8,
        }
    }
}

fn tracked_canvas(
    reader: &PsdReader<'_>,
    pixel_data: &PixelData,
    category: AllocationCategory,
) -> ReadResult<PixelData> {
    let bytes = (pixel_data.width as usize)
        .checked_mul(pixel_data.height as usize)
        .and_then(|value| value.checked_mul(4))
        .ok_or(ReadError::SizeTooLarge)?;
    let lease = reader.reserve_allocation(category, bytes)?;
    let canvas = try_image_data_to_canvas(pixel_data).map_err(|_| ReadError::AllocationFailed {
        requested: bytes,
        category,
    })?;
    lease.persist();
    Ok(canvas)
}

fn tracked_rgba8(
    reader: &PsdReader<'_>,
    width: u32,
    height: u32,
    category: AllocationCategory,
) -> ReadResult<PixelData> {
    let bytes = (width as usize)
        .checked_mul(height as usize)
        .and_then(|value| value.checked_mul(4))
        .ok_or(ReadError::SizeTooLarge)?;
    let lease = reader.reserve_allocation(category, bytes)?;
    let pixels = try_create_image_data(width, height).map_err(|_| ReadError::AllocationFailed {
        requested: bytes,
        category,
    })?;
    lease.persist();
    Ok(pixels)
}

#[inline]
fn bytes_per_sample(depth: u32) -> usize {
    match depth {
        16 => 2,
        32 => 4,
        _ => 1,
    }
}

/// Write a single PackBits byte into a TypedArray-style element slot.
/// Matches upstream `data[p] = value` on Uint8 / Uint16 / Float32 views.
fn write_element_sample(data: &mut [u8], elem_index: usize, value: u8, depth: u32) {
    match depth {
        16 => {
            let off = elem_index * 2;
            if off + 1 < data.len() {
                let ne = (value as u16).to_ne_bytes();
                data[off] = ne[0];
                data[off + 1] = ne[1];
            }
        }
        32 => {
            let off = elem_index * 4;
            if off + 3 < data.len() {
                data[off..off + 4].copy_from_slice(&(value as f32).to_ne_bytes());
            }
        }
        _ => {
            if elem_index < data.len() {
                data[elem_index] = value;
            }
        }
    }
}

// ---------------------------------------------------------------------------
// readPsd
// ---------------------------------------------------------------------------

/// High-level entry point. Mirror of upstream `readPsd(reader, readOptions)`,
/// but takes a byte slice + options and builds a [`PsdReader`] internally.
pub fn read_psd(buffer: &[u8], options: &ReadOptions) -> ReadResult<crate::psd::Psd> {
    read_psd_with_observations(buffer, options).map(|(document, _)| document)
}

/// Parse an in-memory PSD/PSB and return parser allocation high-water evidence.
pub fn read_psd_with_observations(
    buffer: &[u8],
    options: &ReadOptions,
) -> ReadResult<(crate::psd::Psd, ParserAllocationObservations)> {
    let mut reader = PsdReader::new(buffer, None, None);
    apply_read_options(&mut reader, options)?;
    let document = read_psd_from_reader(&mut reader)?;
    Ok((document, reader.allocation_observations()))
}

fn apply_read_options(reader: &mut PsdReader<'_>, options: &ReadOptions) -> ReadResult<()> {
    reader.options = options.clone();
    reader.strict = options.strict.unwrap_or(false);
    reader.debug = options.debug.unwrap_or(false);
    let total_limit = options
        .total_memory_limit
        .unwrap_or(DEFAULT_TOTAL_MEMORY_LIMIT);
    let metadata_limit = options.max_metadata_bytes.unwrap_or(total_limit);
    reader.configure_allocation_limits(total_limit, metadata_limit)?;
    Ok(())
}

/// Mirror of upstream `readPsd` operating on an existing reader (options must
/// already be set on the reader, as upstream does via `Object.assign`).
pub fn read_psd_from_reader(reader: &mut PsdReader) -> ReadResult<crate::psd::Psd> {
    // header
    check_signature(reader, "8BPS", None)?;
    let version = read_uint16(reader)?;
    if version != 1 && version != 2 {
        return Err(ReadError::StrictViolation(format!(
            "Invalid PSD file version: {}",
            version
        )));
    }

    skip_bytes(reader, 6);
    let channels = read_uint16(reader)?;
    let height = read_uint32(reader)?;
    let width = read_uint32(reader)?;
    let bits_per_channel = read_uint16(reader)?;
    let color_mode_raw = read_uint16(reader)?;
    let max_size = if version == 1 {
        reader.options.max_psd_side.unwrap_or(30_000)
    } else {
        reader.options.max_psb_side.unwrap_or(300_000)
    };

    if width > max_size || height > max_size {
        return Err(ReadError::DocumentLimitExceeded {
            width,
            height,
            limit: max_size,
        });
    }
    let canvas_pixels = u128::from(width)
        .checked_mul(u128::from(height))
        .ok_or(ReadError::SizeTooLarge)?;
    let _platform_pixels = checked_platform_size(canvas_pixels)?;
    if let Some(limit) = reader.options.max_canvas_pixels {
        if canvas_pixels > u128::from(limit) {
            return Err(ReadError::PixelLimitExceeded {
                pixels: canvas_pixels,
                limit,
            });
        }
    }
    if channels > 16 {
        return Err(ReadError::StrictViolation(format!(
            "Invalid channel count: {}",
            channels
        )));
    }
    if ![1, 8, 16, 32].contains(&bits_per_channel) {
        return Err(ReadError::StrictViolation(format!(
            "Invalid bitsPerChannel: {}",
            bits_per_channel
        )));
    }
    if !is_supported_color_mode(color_mode_raw) {
        return Err(ReadError::StrictViolation(format!(
            "Color mode not supported: {}",
            color_mode_raw
        )));
    }

    let color_mode = color_mode_from_u16(color_mode_raw);

    let mut psd = crate::psd::Psd {
        width: width as f64,
        height: height as f64,
        channels: Some(channels as f64),
        bits_per_channel: Some(bits_per_channel as f64),
        color_mode,
        ..Default::default()
    };

    reader.large = version == 2;
    reader.global_alpha = false;
    reader.doc_width = width as f64;
    reader.doc_height = height as f64;

    // color mode data
    let palette = read_section(
        reader,
        1,
        |reader, left| {
            if left(reader) == 0 {
                return Ok(None);
            }
            let mut palette: Option<Vec<Rgb>> = None;
            if color_mode == Some(ColorMode::Indexed) {
                if left(reader) != 768 {
                    return Err(ReadError::StrictViolation(
                        "Invalid color palette size".to_string(),
                    ));
                }
                let mut pal: Vec<Rgb> = Vec::with_capacity(256);
                for _ in 0..256 {
                    pal.push(Rgb {
                        r: read_uint8(reader)? as f64,
                        g: 0.0,
                        b: 0.0,
                    });
                }
                for i in 0..256 {
                    pal[i].g = read_uint8(reader)? as f64;
                }
                for i in 0..256 {
                    pal[i].b = read_uint8(reader)? as f64;
                }
                palette = Some(pal);
            }
            skip_bytes(reader, left(reader));
            Ok(palette)
        },
        true,
        false,
    )?;
    if let Some(Some(p)) = palette {
        psd.palette = Some(p);
    }

    // image resources
    let mut image_resources = ImageResources::default();
    read_section(
        reader,
        1,
        |reader, left| {
            while left(reader) > 0 {
                realign_with_signature(reader, is_valid_image_resource_signature)?;
                let id = read_uint16(reader)?;
                read_pascal_string(reader, 2)?; // name

                read_section(
                    reader,
                    2,
                    |reader, left| {
                        let skip = id == 1036 && reader.options.skip_thumbnail == Some(true);
                        let throw_for_missing =
                            reader.options.throw_for_missing_features == Some(true);
                        let block_len = left(reader);
                        if !skip {
                            match read_image_resource(id, reader, &mut image_resources, block_len) {
                                Ok(()) => {}
                                Err(e) => {
                                    if throw_for_missing {
                                        return Err(e);
                                    }
                                    skip_bytes(reader, left(reader));
                                }
                            }
                        } else {
                            skip_bytes(reader, left(reader));
                        }
                        Ok(())
                    },
                    false,
                    false,
                )?;
            }
            Ok(())
        },
        true,
        false,
    )?;
    psd.image_resources = Some(image_resources);

    // layer and mask info
    read_section(
        reader,
        1,
        |reader, left| {
            read_section(
                reader,
                2,
                |reader, left| {
                    let layers = read_layer_info(reader, &mut psd)?;
                    psd.children = Some(layers);
                    skip_bytes(reader, left(reader));
                    Ok(())
                },
                true,
                reader.large,
            )?;

            // SAI does not include this section
            if left(reader) > 0 {
                if let Some(info) = read_global_layer_mask_info(reader)? {
                    psd.global_layer_mask_info = Some(info);
                }
            } else {
                skip_bytes(reader, left(reader));
            }

            while left(reader) > 0 {
                // sometimes there are empty bytes here
                while left(reader) > 0 && peek_uint8(reader)? == 0 {
                    skip_bytes(reader, 1);
                }

                if left(reader) >= 12 {
                    // additional layer info applied to the whole document.
                    // Take `additional_info` out so ReadCtx can hold `&mut psd`
                    // for keys like Lr16/Lr32 that call back into read_layer_info.
                    let mut info = std::mem::take(&mut psd.additional_info);
                    read_additional_layer_info(reader, &mut info, Some(&mut psd))?;
                    psd.additional_info = info;
                } else {
                    skip_bytes(reader, left(reader));
                    break;
                }
            }
            Ok(())
        },
        true,
        reader.large,
    )?;

    let has_children = psd.children.as_ref().map_or(false, |c| !c.is_empty());
    let skip_layer = reader.options.skip_layer_image_data == Some(true);
    let skip_composite =
        reader.options.skip_composite_image_data == Some(true) && (skip_layer || has_children);

    if !skip_composite {
        if reader.options.use_raw_data == Some(true) {
            // Upstream: view of remaining bytes from the composite section onward.
            let remaining = reader.len().saturating_sub(reader.offset);
            psd.raw_composite_data = Some(read_bytes(reader, remaining)?);
        } else {
            read_image_data(reader, &mut psd)?;
        }
    }

    Ok(psd)
}

fn is_valid_image_resource_signature(sig: &str) -> bool {
    sig == "8BIM" || sig == "MeSa" || sig == "AgHg" || sig == "PHUT" || sig == "DCSR"
}

// ---------------------------------------------------------------------------
// readLayerInfo
// ---------------------------------------------------------------------------

/// Read a layer-info block and return the nested layer tree.
///
/// Callers assign the result to `psd.children` (main layer section or
/// `Lr16`/`Lr32`). Returning `Vec<Layer>` avoids borrow conflicts when
/// document-level additional-info holds `&mut Psd` via [`ReadCtx`].
pub(crate) fn read_layer_info(
    reader: &mut PsdReader,
    psd: &mut crate::psd::Psd,
) -> ReadResult<Vec<Layer>> {
    let mut layer_count = read_int16(reader)? as i32;

    if layer_count < 0 {
        reader.global_alpha = true;
        layer_count = -layer_count;
    }
    let layer_count = layer_count as usize;
    let layer_count_u64 = u64::try_from(layer_count).map_err(|_| ReadError::SizeTooLarge)?;
    let observed = reader
        .layer_records_seen
        .checked_add(layer_count_u64)
        .ok_or(ReadError::SizeTooLarge)?;
    if let Some(limit) = reader.options.max_layer_records {
        if observed > u64::from(limit) {
            return Err(ReadError::LayerLimitExceeded { observed, limit });
        }
    }
    reader.layer_records_seen = observed;

    let layer_bytes = layer_count
        .checked_mul(std::mem::size_of::<Layer>())
        .ok_or(ReadError::SizeTooLarge)?;
    let channel_index_bytes = layer_count
        .checked_mul(std::mem::size_of::<Vec<ChannelInfo>>())
        .ok_or(ReadError::SizeTooLarge)?;
    let layer_lease = reader.reserve_allocation(AllocationCategory::Metadata, layer_bytes)?;
    let channel_index_lease =
        reader.reserve_allocation(AllocationCategory::Channel, channel_index_bytes)?;
    let mut layers: Vec<Layer> = Vec::new();
    layers
        .try_reserve_exact(layer_count)
        .map_err(|_| ReadError::AllocationFailed {
            requested: layer_bytes,
            category: AllocationCategory::Metadata,
        })?;
    let mut layer_channels: Vec<Vec<ChannelInfo>> = Vec::new();
    layer_channels
        .try_reserve_exact(layer_count)
        .map_err(|_| ReadError::AllocationFailed {
            requested: channel_index_bytes,
            category: AllocationCategory::Channel,
        })?;

    for i in 0..layer_count {
        let (mut layer, channels) = read_layer_record(reader, psd)?;
        if let Some(g) = reader.layers_group.get(i) {
            layer.link_group = Some(*g);
        }
        if let Some(e) = reader.layer_groups_enabled_id.get(i) {
            layer.link_group_enabled = Some(*e != 0.0);
        }
        layers.push(layer);
        layer_channels.push(channels);
    }

    for i in 0..layer_count {
        read_layer_channel_image_data(reader, psd, &mut layers[i], &layer_channels[i])?;
    }
    drop(channel_index_lease);
    layer_lease.persist();

    // Build the tree. We mirror upstream's stack-based unshift algorithm, but
    // since Rust ownership makes a stack of mutable references hard, we collect
    // into a nesting structure by tracking a path of indices.
    let tree_lease = reader.reserve_allocation(AllocationCategory::Metadata, layer_bytes)?;
    let tree = build_layer_tree(layers, reader.options.max_layer_depth.unwrap_or(u32::MAX))?;
    drop(tree_lease);
    Ok(tree)
}

/// Mirror of the upstream stack/unshift folder-nesting algorithm.
fn build_layer_tree(mut layers: Vec<Layer>, max_depth: u32) -> ReadResult<Vec<Layer>> {
    // Pre-process: apply opened/children/blendMode for folders.
    // We process from the end (as upstream loops i = len-1 .. 0) building nested
    // vectors. `stack` holds the children-list under construction; each entry is
    // a Vec<Layer>. When we open a folder we push a new list; when we hit a
    // bounding divider we pop and attach to the parent's last-unshifted folder.
    //
    // Because upstream unshifts (prepends) and we iterate end->start, the final
    // order is preserved by pushing to front of each list.

    // Stack of (children list, optional folder layer awaiting its children).
    struct Frame {
        children: Vec<Layer>,
        folder: Option<Layer>,
    }

    let mut stack: Vec<Frame> = vec![Frame {
        children: Vec::new(),
        folder: None,
    }];

    for i in (0..layers.len()).rev() {
        let l = std::mem::take(&mut layers[i]);
        let ty = l
            .additional_info
            .section_divider
            .as_ref()
            .map(|d| d.divider_type)
            .unwrap_or(SectionDividerType::Other);

        match ty {
            SectionDividerType::OpenFolder | SectionDividerType::ClosedFolder => {
                let next_depth = stack.len() as u128;
                if next_depth > u128::from(max_depth) {
                    return Err(ReadError::RecursionLimitExceeded {
                        observed: u32::try_from(next_depth).unwrap_or(u32::MAX),
                        limit: max_depth,
                    });
                }
                let mut folder = l;
                folder.opened = Some(ty == SectionDividerType::OpenFolder);
                folder.children = Some(Vec::new());
                if let Some(div) = &folder.additional_info.section_divider {
                    if let Some(key) = &div.key {
                        if let Some(bm) = to_blend_mode(key) {
                            folder.blend_mode = Some(bm);
                        }
                    }
                }
                // push the folder frame; its children come from subsequent
                // (deeper-in-file, earlier-in-loop) layers between this and the
                // bounding divider.
                stack.push(Frame {
                    children: Vec::new(),
                    folder: Some(folder),
                });
            }
            SectionDividerType::BoundingSectionDivider => {
                // close current frame: attach collected children to folder, then
                // unshift folder into parent.
                if stack.len() == 1 {
                    // A stray bounding divider must not consume the root frame.
                    continue;
                }
                let Some(frame) = stack.pop() else {
                    return Err(ReadError::StrictViolation(
                        "layer tree frame disappeared".into(),
                    ));
                };
                if let Some(mut folder) = frame.folder {
                    folder.children = Some(frame.children);
                    if let Some(parent) = stack.last_mut() {
                        parent.children.insert(0, folder);
                    }
                } else {
                    // bounding divider without matching folder; ignore body.
                    if let Some(parent) = stack.last_mut() {
                        for layer in frame.children.into_iter().rev() {
                            parent.children.insert(0, layer);
                        }
                    }
                }
            }
            _ => {
                if let Some(top) = stack.last_mut() {
                    top.children.insert(0, l);
                }
            }
        }
    }

    // Drain any unterminated folders (defensive — well-formed files end clean).
    while stack.len() > 1 {
        let Some(frame) = stack.pop() else {
            break;
        };
        if let Some(mut folder) = frame.folder {
            folder.children = Some(frame.children);
            if let Some(parent) = stack.last_mut() {
                parent.children.insert(0, folder);
            }
        } else if let Some(parent) = stack.last_mut() {
            for layer in frame.children.into_iter().rev() {
                parent.children.insert(0, layer);
            }
        }
    }

    stack
        .pop()
        .map(|frame| frame.children)
        .ok_or_else(|| ReadError::StrictViolation("layer tree root disappeared".into()))
}

// ---------------------------------------------------------------------------
// readLayerRecord
// ---------------------------------------------------------------------------

fn read_layer_record(
    reader: &mut PsdReader,
    _psd: &mut crate::psd::Psd,
) -> ReadResult<(Layer, Vec<ChannelInfo>)> {
    let mut layer = Layer::default();
    layer.top = Some(read_int32(reader)? as f64);
    layer.left = Some(read_int32(reader)? as f64);
    layer.bottom = Some(read_int32(reader)? as f64);
    layer.right = Some(read_int32(reader)? as f64);
    if !is_valid_box_size(
        layer.top.unwrap_or(0.0),
        layer.left.unwrap_or(0.0),
        layer.bottom.unwrap_or(0.0),
        layer.right.unwrap_or(0.0),
        reader.large,
    ) {
        return Err(ReadError::StrictViolation("Invalid layer size".to_string()));
    }

    let channel_count = read_uint16(reader)?;
    let channel_count_usize = usize::from(channel_count);
    let channel_bytes = channel_count_usize
        .checked_mul(std::mem::size_of::<ChannelInfo>())
        .ok_or(ReadError::SizeTooLarge)?;
    let channel_lease = reader.reserve_allocation(AllocationCategory::Channel, channel_bytes)?;
    let mut channels: Vec<ChannelInfo> = Vec::new();
    channels
        .try_reserve_exact(channel_count_usize)
        .map_err(|_| ReadError::AllocationFailed {
            requested: channel_bytes,
            category: AllocationCategory::Channel,
        })?;

    for _ in 0..channel_count {
        let id = read_int16(reader)?;
        let mut length = read_uint32(reader)? as usize;
        if reader.large {
            if length != 0 {
                return Err(ReadError::StrictViolation(
                    "Sizes larger than 4GB are not supported".to_string(),
                ));
            }
            length = read_uint32(reader)? as usize;
        }
        channels.push(ChannelInfo { id, length });
    }

    check_signature(reader, "8BIM", None)?;
    let blend_mode = read_signature(reader)?;
    match to_blend_mode(&blend_mode) {
        Some(bm) => layer.blend_mode = Some(bm),
        None => {
            return Err(ReadError::StrictViolation(format!(
                "Invalid blend mode: '{}'",
                blend_mode
            )));
        }
    }

    layer.opacity = Some(read_uint8(reader)? as f64 / 0xff as f64);
    layer.clipping = Some(read_uint8(reader)? == 1);

    let flags = read_uint8(reader)?;
    layer.transparency_protected = Some((flags & 0x01) != 0);
    layer.hidden = Some((flags & 0x02) != 0);
    if flags & 0x20 != 0 {
        layer.effects_open = Some(true);
    }

    skip_bytes(reader, 1);

    // extra data section
    let large = reader.large;
    let mut info = std::mem::take(&mut layer.additional_info);
    read_section(
        reader,
        1,
        |reader, left| {
            read_layer_mask_data(reader, &mut info)?;

            if let Some(ranges) = read_layer_blending_ranges(reader)? {
                info.blending_ranges = Some(ranges);
            }
            info.name = Some(read_pascal_string(reader, 1)?);

            // HACK: skip junk until a valid signature
            while left(reader) > 4 && !valid_signature_at(reader, reader.offset) {
                reader.offset += 1;
            }

            while left(reader) >= 12 {
                // Per-layer extras: no document `psd` in ReadCtx (Lr16/Lr32
                // only appear at the document additional-info level).
                read_additional_layer_info(reader, &mut info, None)?;
            }

            skip_bytes(reader, left(reader));
            Ok(())
        },
        true,
        false,
    )?;
    let _ = large;
    layer.additional_info = info;

    drop(channel_lease);
    Ok((layer, channels))
}

fn read_layer_mask_data(reader: &mut PsdReader, info: &mut LayerAdditionalInfo) -> ReadResult<()> {
    read_section(
        reader,
        1,
        |reader, left| {
            if left(reader) == 0 {
                return Ok(());
            }
            let mut mask = LayerMaskData::default();
            mask.top = Some(read_int32(reader)? as f64);
            mask.left = Some(read_int32(reader)? as f64);
            mask.bottom = Some(read_int32(reader)? as f64);
            mask.right = Some(read_int32(reader)? as f64);
            if !is_valid_box_size(
                mask.top.unwrap_or(0.0),
                mask.left.unwrap_or(0.0),
                mask.bottom.unwrap_or(0.0),
                mask.right.unwrap_or(0.0),
                reader.large,
            ) {
                return Err(ReadError::StrictViolation("Invalid mask size".to_string()));
            }
            mask.default_color = Some(read_uint8(reader)? as f64);

            let flags = read_uint8(reader)?;
            mask.position_relative_to_layer =
                Some((flags & LayerMaskFlags::PositionRelativeToLayer as u8) != 0);
            mask.disabled = Some((flags & LayerMaskFlags::LayerMaskDisabled as u8) != 0);
            mask.from_vector_data =
                Some((flags & LayerMaskFlags::LayerMaskFromRenderingOtherData as u8) != 0);

            if left(reader) >= 18 {
                let mut real_mask = LayerMaskData::default();
                let real_flags = read_uint8(reader)?;
                real_mask.position_relative_to_layer =
                    Some((real_flags & LayerMaskFlags::PositionRelativeToLayer as u8) != 0);
                real_mask.disabled =
                    Some((real_flags & LayerMaskFlags::LayerMaskDisabled as u8) != 0);
                real_mask.from_vector_data =
                    Some((real_flags & LayerMaskFlags::LayerMaskFromRenderingOtherData as u8) != 0);
                real_mask.default_color = Some(read_uint8(reader)? as f64);
                real_mask.top = Some(read_int32(reader)? as f64);
                real_mask.left = Some(read_int32(reader)? as f64);
                real_mask.bottom = Some(read_int32(reader)? as f64);
                real_mask.right = Some(read_int32(reader)? as f64);
                if !is_valid_box_size(
                    real_mask.top.unwrap_or(0.0),
                    real_mask.left.unwrap_or(0.0),
                    real_mask.bottom.unwrap_or(0.0),
                    real_mask.right.unwrap_or(0.0),
                    reader.large,
                ) {
                    return Err(ReadError::StrictViolation(
                        "Invalid realMask size".to_string(),
                    ));
                }
                info.real_mask = Some(real_mask);
            }

            if flags & LayerMaskFlags::MaskHasParametersAppliedToIt as u8 != 0 {
                let params = read_uint8(reader)?;
                if params & MaskParams::UserMaskDensity as u8 != 0 {
                    mask.user_mask_density = Some(read_uint8(reader)? as f64 / 0xff as f64);
                }
                if params & MaskParams::UserMaskFeather as u8 != 0 {
                    mask.user_mask_feather = Some(read_float64(reader)?);
                }
                if params & MaskParams::VectorMaskDensity as u8 != 0 {
                    mask.vector_mask_density = Some(read_uint8(reader)? as f64 / 0xff as f64);
                }
                if params & MaskParams::VectorMaskFeather as u8 != 0 {
                    mask.vector_mask_feather = Some(read_float64(reader)?);
                }
            }

            info.mask = Some(mask);
            skip_bytes(reader, left(reader));
            Ok(())
        },
        true,
        false,
    )?;
    Ok(())
}

fn read_blending_range(reader: &mut PsdReader) -> ReadResult<Vec<f64>> {
    let mut range = Vec::new();
    range
        .try_reserve_exact(4)
        .map_err(|_| ReadError::AllocationFailed {
            requested: 4 * std::mem::size_of::<f64>(),
            category: AllocationCategory::Metadata,
        })?;
    for _ in 0..4 {
        range.push(read_uint8(reader)? as f64);
    }
    Ok(range)
}

fn read_layer_blending_ranges(
    reader: &mut PsdReader,
) -> ReadResult<Option<crate::psd::BlendingRanges>> {
    let res = read_section(
        reader,
        1,
        |reader, left| {
            let length = left(reader);
            if length < 8 || length % 8 != 0 {
                return Err(ReadError::StrictViolation(
                    "Invalid blending ranges length".into(),
                ));
            }
            let range_count = length / 8 - 1;
            // Each encoded byte becomes an f64; each channel also owns two Vecs.
            let allocation_bytes = length
                .checked_mul(std::mem::size_of::<f64>())
                .and_then(|bytes| {
                    range_count
                        .checked_mul(std::mem::size_of::<crate::psd::BlendingRange>())
                        .and_then(|ranges| bytes.checked_add(ranges))
                })
                .ok_or(ReadError::SizeTooLarge)?;
            let lease =
                reader.reserve_allocation(AllocationCategory::Metadata, allocation_bytes)?;
            let mut ranges: Vec<crate::psd::BlendingRange> = Vec::new();
            ranges
                .try_reserve_exact(range_count)
                .map_err(|_| ReadError::AllocationFailed {
                    requested: allocation_bytes,
                    category: AllocationCategory::Metadata,
                })?;
            let composite_gray_blend_source = read_blending_range(reader)?;
            let composite_graph_blend_destination_range = read_blending_range(reader)?;
            for _ in 0..range_count {
                let source_range = read_blending_range(reader)?;
                let dest_range = read_blending_range(reader)?;
                ranges.push(crate::psd::BlendingRange {
                    source_range,
                    dest_range,
                });
            }
            Ok((
                crate::psd::BlendingRanges {
                    composite_gray_blend_source,
                    composite_graph_blend_destination_range,
                    ranges,
                },
                lease,
            ))
        },
        true,
        false,
    )?;
    Ok(res.map(|(ranges, lease)| {
        lease.persist();
        ranges
    }))
}

// ---------------------------------------------------------------------------
// readLayerChannelImageData
// ---------------------------------------------------------------------------

fn read_layer_channel_image_data(
    reader: &mut PsdReader,
    psd: &crate::psd::Psd,
    layer: &mut Layer,
    channels: &[ChannelInfo],
) -> ReadResult<()> {
    if reader.options.skip_layer_image_data == Some(true) {
        return Ok(());
    }

    let color_mode = psd.color_mode.unwrap_or(ColorMode::Rgb);
    let bits_per_channel = psd.bits_per_channel.unwrap_or(8.0);
    let large = reader.large;

    let raw_channel_bytes = channels
        .len()
        .checked_mul(std::mem::size_of::<LayerRawDataChannel>())
        .ok_or(ReadError::SizeTooLarge)?;
    let raw_channel_lease =
        reader.reserve_allocation(AllocationCategory::Channel, raw_channel_bytes)?;
    let mut raw_channels: Vec<LayerRawDataChannel> = Vec::new();
    raw_channels
        .try_reserve_exact(channels.len())
        .map_err(|_| ReadError::AllocationFailed {
            requested: raw_channel_bytes,
            category: AllocationCategory::Channel,
        })?;

    for channel in channels {
        let start = reader.offset;
        let mut compression = Compression::RawData;
        let mut data: Option<Vec<u8>> = None;

        if channel.length == 1 {
            return Err(ReadError::StrictViolation(
                "Invalid channel length".to_string(),
            ));
        }
        if channel.length != 0 {
            let mut comp = read_uint16(reader)?;
            if comp > 3 {
                reader.offset -= 1;
                comp = read_uint16(reader)?;
            }
            if comp > 3 {
                reader.offset -= 3;
                comp = read_uint16(reader)?;
            }
            if comp > 3 {
                return Err(ReadError::StrictViolation(format!(
                    "Invalid compression: {}",
                    comp
                )));
            }
            compression = compression_from_u16(comp);
            if channel.length > 2 {
                data = Some(read_bytes_category(
                    reader,
                    channel.length - 2,
                    AllocationCategory::Channel,
                )?);
            }
        }

        reader.offset = start + channel.length;
        // Preserve the raw channel id (including spot/extra channels id >= 4).
        raw_channels.push(LayerRawDataChannel {
            id: channel.id,
            compression,
            data,
        });
    }

    layer.raw_data = Some(LayerRawData {
        color_mode,
        bits_per_channel,
        channels: raw_channels,
        large,
    });
    drop(raw_channel_lease);

    if reader.options.use_raw_data != Some(true) {
        let use_image_data = reader.options.use_image_data == Some(true);
        let throw_missing = reader.options.throw_for_missing_features == Some(true);
        decode_layer_image_data(layer, use_image_data, throw_missing, reader)?;
    }

    Ok(())
}

fn compression_from_u16(v: u16) -> Compression {
    match v {
        0 => Compression::RawData,
        1 => Compression::RleCompressed,
        2 => Compression::ZipWithoutPrediction,
        _ => Compression::ZipWithPrediction,
    }
}

fn setup_grayscale(data: &mut [u8], width: usize, height: usize) {
    let size = width * height * 4;
    let mut i = 0;
    while i < size {
        let c = data[i];
        data[i + 1] = c;
        data[i + 2] = c;
        i += 4;
    }
}

/// Copy channel 0 into G/B for any sample depth (element-wise).
fn setup_grayscale_depth(target: &mut DecodeTarget) {
    let bps = target.bytes_per_sample();
    if bps == 1 {
        setup_grayscale(&mut target.data, target.width, target.height);
        return;
    }
    let pixels = target.width * target.height;
    for i in 0..pixels {
        let base = i * 4 * bps;
        let src = base;
        if src + bps > target.data.len() {
            break;
        }
        let sample = target.data[src..src + bps].to_vec();
        for c in 1..3 {
            let dst = base + c * bps;
            if dst + bps <= target.data.len() {
                target.data[dst..dst + bps].copy_from_slice(&sample);
            }
        }
    }
}

fn reset_alpha(target: &mut DecodeTarget, cmyk: bool) {
    let offset = if cmyk { 4 } else { 3 };
    let step = if cmyk { 5 } else { 4 };
    let bps = target.bytes_per_sample();
    let samples = target.data.len() / bps.max(1);
    let mut p = offset;
    while p < samples {
        write_opaque_sample(&mut target.data, p, target.depth);
        p += step;
    }
}

fn write_opaque_sample(data: &mut [u8], elem_index: usize, depth: u32) {
    match depth {
        16 => write_element_sample_u16(data, elem_index, 0xffff),
        32 => {
            let off = elem_index * 4;
            if off + 3 < data.len() {
                data[off..off + 4].copy_from_slice(&1.0f32.to_ne_bytes());
            }
        }
        _ => {
            if elem_index < data.len() {
                data[elem_index] = 0xff;
            }
        }
    }
}

fn write_element_sample_u16(data: &mut [u8], elem_index: usize, value: u16) {
    let off = elem_index * 2;
    if off + 1 < data.len() {
        let ne = value.to_ne_bytes();
        data[off] = ne[0];
        data[off + 1] = ne[1];
    }
}

fn reset_decode_target(target: &mut DecodeTarget) {
    let mut pd = PixelData {
        width: target.width as u32,
        height: target.height as u32,
        data: std::mem::take(&mut target.data),
        depth: target.depth as u8,
    };
    crate::helpers::reset_image_data(&mut pd);
    target.data = pd.data;
}

/// Decode `layer.raw_data` into `image_data` / mask pixels when present.
///
/// Editing helpers call this before replacing raster content so mask channels
/// that only lived in the raw short-circuit path are not lost.
pub(crate) fn materialize_layer_raw_data(layer: &mut Layer) -> ReadResult<()> {
    if layer.raw_data.is_some() {
        let allocation_reader = PsdReader::new(&[], None, None);
        decode_layer_image_data(layer, true, false, &allocation_reader)?;
    }
    Ok(())
}

/// Mirror `decodeLayerImageData`.
fn decode_layer_image_data(
    layer: &mut Layer,
    use_image_data: bool,
    throw_for_missing_features: bool,
    allocation_reader: &PsdReader<'_>,
) -> ReadResult<()> {
    let raw = match layer.raw_data.take() {
        Some(r) => r,
        None => return Ok(()),
    };

    let color_mode = raw.color_mode;
    let bits_per_channel = raw.bits_per_channel as u32;
    let large = raw.large;
    // Renderers opt in to hard-failing on undecodable ZIP channels; the editing
    // helpers leave it off so a damaged mask can still round-trip.
    let corrupt_channel_fatal = allocation_reader.options.corrupt_channel_is_fatal == Some(true);
    let layer_width = (layer.right.unwrap_or(0.0) - layer.left.unwrap_or(0.0)).max(0.0) as usize;
    let layer_height = (layer.bottom.unwrap_or(0.0) - layer.top.unwrap_or(0.0)).max(0.0) as usize;
    let cmyk = color_mode == ColorMode::Cmyk;

    let mut image_data: Option<DecodeTarget> = None;
    let mut initialized_alpha = false;

    if layer_width != 0 && layer_height != 0 {
        if cmyk {
            if bits_per_channel != 8 {
                return Err(ReadError::StrictViolation(
                    "bitsPerChannel Not supported".to_string(),
                ));
            }
            image_data = Some(DecodeTarget::try_tracked(
                allocation_reader,
                layer_width,
                layer_height,
                5,
                8,
                AllocationCategory::Raster,
            )?);
        } else {
            let mut tgt = DecodeTarget::try_tracked(
                allocation_reader,
                layer_width,
                layer_height,
                4,
                bits_per_channel,
                AllocationCategory::Raster,
            )?;
            reset_decode_target(&mut tgt);
            image_data = Some(tgt);
        }
    }

    for ch in &raw.channels {
        let data = match &ch.data {
            Some(d) => d,
            None => continue,
        };
        let mut data_reader = PsdReader::child(data, allocation_reader);

        if ch.id == ChannelId::UserMask as i16 || ch.id == ChannelId::RealUserMask as i16 {
            let mask_ref = if ch.id == ChannelId::UserMask as i16 {
                layer.additional_info.mask.as_ref()
            } else {
                layer.additional_info.real_mask.as_ref()
            };
            let (mtop, mleft, mbottom, mright) = match mask_ref {
                Some(m) => (
                    m.top.unwrap_or(0.0),
                    m.left.unwrap_or(0.0),
                    m.bottom.unwrap_or(0.0),
                    m.right.unwrap_or(0.0),
                ),
                None => {
                    return Err(ReadError::StrictViolation(format!(
                        "Missing layer {} data",
                        if ch.id == ChannelId::UserMask as i16 {
                            "mask"
                        } else {
                            "real mask"
                        }
                    )));
                }
            };
            let mask_width = (mright - mleft) as i64;
            let mask_height = (mbottom - mtop) as i64;
            if !(0..=30000).contains(&mask_width) || !(0..=30000).contains(&mask_height) {
                return Err(ReadError::StrictViolation("Invalid mask size".to_string()));
            }
            let mw = mask_width as usize;
            let mh = mask_height as usize;
            if mw != 0 && mh != 0 {
                let mut mask_data = DecodeTarget::try_tracked(
                    allocation_reader,
                    mw,
                    mh,
                    4,
                    bits_per_channel,
                    AllocationCategory::Mask,
                )?;
                reset_decode_target(&mut mask_data);
                read_data(
                    &mut data_reader,
                    data.len(),
                    Some(&mut mask_data),
                    ch.compression,
                    mw,
                    mh,
                    bits_per_channel,
                    0,
                    large,
                    4,
                    ch.id,
                    corrupt_channel_fatal,
                )?;
                setup_grayscale_depth(&mut mask_data);
                reset_alpha(&mut mask_data, false);
                let pd = mask_data.into_pixel_data();
                let mask = if ch.id == ChannelId::UserMask as i16 {
                    layer.additional_info.mask.as_mut()
                } else {
                    layer.additional_info.real_mask.as_mut()
                };
                if let Some(mask) = mask {
                    if use_image_data {
                        mask.image_data = Some(pd);
                    } else {
                        mask.canvas = Some(tracked_canvas(
                            allocation_reader,
                            &pd,
                            AllocationCategory::Mask,
                        )?);
                    }
                }
            }
        } else {
            let offset = offset_for_channel(ch.id, cmyk);
            let target = if offset < 0 {
                if throw_for_missing_features {
                    return Err(ReadError::StrictViolation(format!(
                        "Channel not supported: {}",
                        ch.id as i32
                    )));
                }
                None
            } else {
                image_data.as_mut()
            };

            let step = if cmyk { 5 } else { 4 };
            read_data(
                &mut data_reader,
                data.len(),
                target,
                ch.compression,
                layer_width,
                layer_height,
                bits_per_channel,
                offset.max(0) as usize,
                large,
                step,
                ch.id,
                corrupt_channel_fatal,
            )?;

            if offset >= 0 && color_mode == ColorMode::Grayscale {
                if let Some(t) = image_data.as_mut() {
                    setup_grayscale_depth(t);
                }
            }
        }

        if ch.id == ChannelId::Transparency as i16 {
            initialized_alpha = true;
        }
    }

    if let Some(mut img) = image_data {
        if !initialized_alpha {
            reset_alpha(&mut img, cmyk);
        }

        let final_pd = if cmyk {
            let mut rgb = tracked_rgba8(
                allocation_reader,
                img.width as u32,
                img.height as u32,
                AllocationCategory::Raster,
            )?;
            cmyk_to_rgb(&img, &mut rgb, false);
            rgb
        } else {
            img.into_pixel_data()
        };

        if use_image_data {
            layer.image_data = Some(final_pd);
        } else {
            layer.canvas = Some(tracked_canvas(
                allocation_reader,
                &final_pd,
                AllocationCategory::Raster,
            )?);
        }
    }

    Ok(())
}

// ---------------------------------------------------------------------------
// Channel image-data codecs
// ---------------------------------------------------------------------------

/// Mirror `readData` dispatch.
///
/// `channel` and `fatal` only feed the ZIP path, which is the only codec that
/// can report *undecodable* bytes instead of merely short ones; they let a
/// renderer turn a channel it was going to consume into
/// [`ReadError::CorruptChannel`] instead of silently rendering it black.
#[allow(clippy::too_many_arguments)]
fn read_data(
    reader: &mut PsdReader,
    length: usize,
    pixels: Option<&mut DecodeTarget>,
    compression: Compression,
    width: usize,
    height: usize,
    bit_depth: u32,
    offset: usize,
    large: bool,
    step: usize,
    channel: i16,
    fatal: bool,
) -> ReadResult<()> {
    if length == 0 {
        return Ok(());
    }
    match compression {
        Compression::RawData => {
            let data = read_bytes(reader, length)?;
            read_data_raw(&data, pixels, bit_depth, step, offset);
            Ok(())
        }
        Compression::RleCompressed => read_data_rle(
            reader,
            pixels,
            width,
            height,
            bit_depth,
            step,
            &[offset],
            large,
        ),
        Compression::ZipWithoutPrediction => {
            let data = read_bytes(reader, length)?;
            read_data_zip(
                reader, &data, pixels, width, height, bit_depth, step, offset, false, channel,
                fatal,
            )
        }
        Compression::ZipWithPrediction => {
            let data = read_bytes(reader, length)?;
            read_data_zip(
                reader, &data, pixels, width, height, bit_depth, step, offset, true, channel, fatal,
            )
        }
    }
}

/// Copy a planar channel of native-endian samples into interleaved `target`.
fn copy_channel_to_pixel_data(
    target: &mut DecodeTarget,
    channel: &[u8],
    offset: usize,
    step: usize,
) {
    let bps = target.bytes_per_sample();
    let size = target.width * target.height;
    for i in 0..size {
        let src = i * bps;
        let dst_elem = offset + i * step;
        let dst = dst_elem * bps;
        if src + bps > channel.len() || dst + bps > target.data.len() {
            break;
        }
        target.data[dst..dst + bps].copy_from_slice(&channel[src..src + bps]);
    }
}

/// Mirror `readDataRaw` — preserves full 16/32-bit sample precision (native endian).
pub fn read_data_raw(
    buffer: &[u8],
    pixel_data: Option<&mut DecodeTarget>,
    bit_depth: u32,
    step: usize,
    offset: usize,
) {
    let pixel_data = match pixel_data {
        Some(p) => p,
        None => return,
    };
    if offset >= step {
        return;
    }
    let native = channel_bytes_to_native(buffer, bit_depth);
    copy_channel_to_pixel_data(pixel_data, &native, offset, step);
}

/// Convert a big-endian PSD channel plane to a native-endian sample byte buffer.
fn channel_bytes_to_native(buffer: &[u8], bit_depth: u32) -> Vec<u8> {
    match bit_depth {
        8 => buffer.to_vec(),
        16 => {
            let mut out = buffer.to_vec();
            let mut i = 0;
            while i + 1 < out.len() {
                out.swap(i, i + 1);
                i += 2;
            }
            out
        }
        32 => {
            let mut out = buffer.to_vec();
            let mut i = 0;
            while i + 3 < out.len() {
                out.swap(i, i + 3);
                out.swap(i + 1, i + 2);
                i += 4;
            }
            out
        }
        _ => buffer.to_vec(),
    }
}

fn decode_predicted_u8(data: &mut [u8], width: usize, height: usize) {
    for y in 0..height {
        let offset = y * width;
        for x in 1..width {
            let o = offset + x;
            data[o] = data[o - 1].wrapping_add(data[o]);
        }
    }
}

fn decode_predicted_u16(data: &mut [u16], width: usize, height: usize) {
    for y in 0..height {
        let offset = y * width;
        for x in 1..width {
            let o = offset + x;
            data[o] = data[o - 1].wrapping_add(data[o]);
        }
    }
}

/// Mirror `readDataZip` (zlib via flate2).
///
/// Decompression is capped at a size derived from the declared pixel geometry
/// so a hostile ZIP bomb cannot grow without bound (`read_to_end` guard).
/// Decode one ZIP-compressed channel plane into `pixel_data`.
///
/// The historical behaviour is recover-and-zero: a stream that fails to inflate
/// leaves the plane untouched and still reports success. `fatal` switches that
/// to [`ReadError::CorruptChannel`] for the failures that mean the bytes are
/// not a valid channel at all (inflate error, output past the declared
/// geometry, a short non-predicted plane). Callers pass `fatal` only when they
/// are about to consume the samples, so skipped channels stay lenient.
#[allow(clippy::too_many_arguments)]
pub fn read_data_zip(
    allocation_reader: &PsdReader<'_>,
    compressed: &[u8],
    pixel_data: Option<&mut DecodeTarget>,
    width: usize,
    height: usize,
    bit_depth: u32,
    step: usize,
    offset: usize,
    prediction: bool,
    channel: i16,
    fatal: bool,
) -> ReadResult<()> {
    use flate2::read::ZlibDecoder;
    use std::io::Read;

    let bytes_per_sample = match bit_depth {
        16 => 2usize,
        32 => 4usize,
        _ => 1usize,
    };
    let row_bytes = width
        .checked_mul(bytes_per_sample)
        .ok_or(ReadError::SizeTooLarge)?;
    let expected_len = row_bytes
        .checked_mul(height)
        .ok_or(ReadError::SizeTooLarge)?;
    // Generous ceiling: full plane plus a small constant slack.
    let max_out = expected_len
        .checked_add(64 * 1024)
        .ok_or(ReadError::SizeTooLarge)?;
    let lease = allocation_reader.reserve_allocation(AllocationCategory::Channel, max_out)?;

    let mut decoder = ZlibDecoder::new(compressed).take(max_out as u64 + 1);
    let mut decompressed: Vec<u8> = Vec::new();
    decompressed
        .try_reserve_exact(max_out)
        .map_err(|_| ReadError::AllocationFailed {
            requested: max_out,
            category: AllocationCategory::Channel,
        })?;
    // Only a channel whose samples are about to be consumed may be reported as
    // corrupt; every other failure keeps the historical recover-and-zero path.
    let consuming = pixel_data.is_some() && offset < step && expected_len != 0;
    if let Err(error) = decoder.read_to_end(&mut decompressed) {
        if fatal && consuming {
            return Err(ReadError::CorruptChannel {
                channel,
                detail: format!("zlib stream is not decodable: {error}"),
            });
        }
        return Ok(());
    }
    if decompressed.len() > max_out {
        if fatal && consuming {
            return Err(ReadError::CorruptChannel {
                channel,
                detail: format!(
                    "zlib stream inflated to {} bytes, past the {} byte ceiling for a {width}x{height} {bit_depth}-bit plane",
                    decompressed.len(),
                    max_out
                ),
            });
        }
        return Ok(());
    }
    if expected_len == 0 {
        return Ok(());
    }

    let pixel_data = match pixel_data {
        Some(p) => p,
        None => return Ok(()),
    };
    if offset >= step {
        return Ok(());
    }
    // Prediction indexes every declared sample, including partially encoded rows.
    if prediction && decompressed.len() < expected_len {
        return Err(ReadError::UnexpectedEndOfBuffer);
    }
    // A non-predicted plane that stops short of the declared geometry would be
    // copied partially and leave the remaining samples zeroed — the same silent
    // black channel this switch exists to catch, only shorter.
    if !prediction && fatal && decompressed.len() < expected_len {
        return Err(ReadError::CorruptChannel {
            channel,
            detail: format!(
                "zlib stream inflated to {} bytes, short of the {expected_len} byte plane for a {width}x{height} {bit_depth}-bit channel",
                decompressed.len()
            ),
        });
    }

    match bit_depth {
        8 => {
            if prediction {
                decode_predicted_u8(&mut decompressed, width, height);
            }
            copy_channel_to_pixel_data(pixel_data, &decompressed, offset, step);
        }
        16 => {
            // PSD stores big-endian; convert to native u16 samples.
            let sample_bytes = decompressed.len();
            let conversion_lease = allocation_reader
                .reserve_allocation(AllocationCategory::Channel, sample_bytes.saturating_mul(2))?;
            let mut samples: Vec<u16> = Vec::new();
            samples
                .try_reserve_exact(decompressed.len() / 2)
                .map_err(|_| ReadError::AllocationFailed {
                    requested: sample_bytes,
                    category: AllocationCategory::Channel,
                })?;
            let mut i = 0;
            while i + 1 < decompressed.len() {
                samples.push(u16::from_be_bytes([decompressed[i], decompressed[i + 1]]));
                i += 2;
            }
            if prediction {
                decode_predicted_u16(&mut samples, width, height);
            }
            let mut bytes = Vec::new();
            bytes
                .try_reserve_exact(samples.len().saturating_mul(2))
                .map_err(|_| ReadError::AllocationFailed {
                    requested: sample_bytes,
                    category: AllocationCategory::Channel,
                })?;
            for s in samples {
                bytes.extend_from_slice(&s.to_ne_bytes());
            }
            copy_channel_to_pixel_data(pixel_data, &bytes, offset, step);
            drop(conversion_lease);
        }
        32 => {
            // 32-bit float, optionally byte-predicted across width*4 bytes.
            if prediction {
                decode_predicted_u8(&mut decompressed, row_bytes, height);
            }
            // Photoshop stores planar bytes; reconstruct floats (native store).
            let bps = 4usize;
            let mut p = offset;
            for y in 0..height {
                let a0 = width * 4 * y;
                for x in 0..width {
                    let a = a0 + x;
                    let b = a + width;
                    let c = b + width;
                    let d = c + width;
                    let dst = p * bps;
                    if d >= decompressed.len() || dst + 3 >= pixel_data.data.len() {
                        break;
                    }
                    let bits = ((decompressed[a] as u32) << 24)
                        | ((decompressed[b] as u32) << 16)
                        | ((decompressed[c] as u32) << 8)
                        | (decompressed[d] as u32);
                    let v = f32::from_bits(bits);
                    pixel_data.data[dst..dst + 4].copy_from_slice(&v.to_ne_bytes());
                    p += step;
                }
            }
        }
        _ => {}
    }
    drop(lease);
    Ok(())
}

/// Mirror `readDataRLE` (PackBits).
///
/// Upstream writes PackBits bytes into TypedArray elements via `data[p] = value`
/// regardless of bit depth (16/32-bit RLE is lossy — known upstream limitation).
pub fn read_data_rle(
    reader: &mut PsdReader,
    mut pixel_data: Option<&mut DecodeTarget>,
    width: usize,
    height: usize,
    bit_depth: u32,
    step: usize,
    offsets: &[usize],
    large: bool,
) -> ReadResult<()> {
    let length_count = offsets
        .len()
        .checked_mul(height)
        .ok_or(ReadError::SizeTooLarge)?;
    let allocation_bytes = length_count
        .checked_mul(std::mem::size_of::<usize>())
        .ok_or(ReadError::SizeTooLarge)?;
    let lengths_lease = reader.reserve_allocation(AllocationCategory::Channel, allocation_bytes)?;
    let mut lengths: Vec<usize> = Vec::new();
    lengths
        .try_reserve_exact(length_count)
        .map_err(|_| ReadError::AllocationFailed {
            requested: allocation_bytes,
            category: AllocationCategory::Channel,
        })?;
    if large {
        for _ in 0..offsets.len() {
            for _ in 0..height {
                lengths.push(read_uint32(reader)? as usize);
            }
        }
    } else {
        for _ in 0..offsets.len() {
            for _ in 0..height {
                lengths.push(read_uint16(reader)? as usize);
            }
        }
    }

    let depth = pixel_data.as_ref().map(|p| p.depth).unwrap_or(bit_depth);
    let extra_limit = step.saturating_sub(1);

    let mut li = 0usize;
    for c in 0..offsets.len() {
        let offset = offsets[c];
        let extra = c > extra_limit || offset > extra_limit;

        let have_data = pixel_data.is_some() && !extra;
        if !have_data {
            for _ in 0..height {
                let len = lengths[li];
                li += 1;
                skip_bytes(reader, len);
            }
            continue;
        }

        let mut p = offset;
        for _ in 0..height {
            let length = lengths[li];
            li += 1;
            let buffer = read_bytes_category(reader, length, AllocationCategory::Channel)?;

            let mut i = 0usize;
            let mut x = 0usize;
            while i < length {
                let header = buffer[i];
                if header > 128 {
                    i += 1;
                    if i >= buffer.len() {
                        break;
                    }
                    let value = buffer[i];
                    let count = (256 - header as usize) as usize;
                    let mut j = 0;
                    while j <= count && x < width {
                        let Some(pd) = pixel_data.as_deref_mut() else {
                            return Err(ReadError::StrictViolation(
                                "RLE pixel data disappeared during decode".into(),
                            ));
                        };
                        write_element_sample(&mut pd.data, p, value, depth);
                        p += step;
                        j += 1;
                        x += 1;
                    }
                } else if header < 128 {
                    let count = header as usize;
                    let mut j = 0;
                    while j <= count && x < width {
                        i += 1;
                        if i >= buffer.len() {
                            break;
                        }
                        let value = buffer[i];
                        let Some(pd) = pixel_data.as_deref_mut() else {
                            return Err(ReadError::StrictViolation(
                                "RLE pixel data disappeared during decode".into(),
                            ));
                        };
                        write_element_sample(&mut pd.data, p, value, depth);
                        p += step;
                        j += 1;
                        x += 1;
                    }
                }
                i += 1;
            }
        }
        let _ = p;
    }

    drop(lengths_lease);
    Ok(())
}

// ---------------------------------------------------------------------------
// readGlobalLayerMaskInfo
// ---------------------------------------------------------------------------

fn read_global_layer_mask_info(reader: &mut PsdReader) -> ReadResult<Option<GlobalLayerMaskInfo>> {
    let res = read_section(
        reader,
        1,
        |reader, left| {
            if left(reader) == 0 {
                return Ok(None);
            }
            let overlay_color_space = read_uint16(reader)? as f64;
            let color_space1 = read_uint16(reader)? as f64;
            let color_space2 = read_uint16(reader)? as f64;
            let color_space3 = read_uint16(reader)? as f64;
            let color_space4 = read_uint16(reader)? as f64;
            let opacity = read_uint16(reader)? as f64 / 0xff as f64;
            let kind = read_uint8(reader)? as f64;
            skip_bytes(reader, left(reader));
            Ok(Some(GlobalLayerMaskInfo {
                overlay_color_space,
                color_space1,
                color_space2,
                color_space3,
                color_space4,
                opacity,
                kind,
            }))
        },
        true,
        false,
    )?;
    Ok(res.flatten())
}

// ---------------------------------------------------------------------------
// realignWithSignature & readAdditionalLayerInfo
// ---------------------------------------------------------------------------

const FIX_OFFSETS: [i32; 9] = [0, 1, -1, 2, -2, 3, -3, 4, -4];

/// Mirror `realignWithSignature`.
fn realign_with_signature(
    reader: &mut PsdReader,
    is_valid: fn(&str) -> bool,
) -> ReadResult<String> {
    let sig_offset = reader.offset as i64;
    let mut sig = String::new();

    for &off in FIX_OFFSETS.iter() {
        let new_off = sig_offset + off as i64;
        if new_off < 0
            || (new_off as usize)
                .checked_add(4)
                .is_none_or(|end| end > reader.len())
        {
            continue;
        }
        reader.offset = new_off as usize;
        if let Ok(s) = read_signature(reader) {
            sig = s;
        }
        if is_valid(&sig) {
            break;
        }
    }

    if !is_valid(&sig) {
        return Err(ReadError::InvalidSignature {
            signature: sig,
            offset: sig_offset as usize,
        });
    }
    Ok(sig)
}

fn is_valid_additional_info_signature(sig: &str) -> bool {
    sig == "8BIM" || sig == "8B64"
}

/// Mirror `readAdditionalLayerInfo`.
///
/// `psd` is `Some` for document-level additional-info so keys like `Lr16`/
/// `Lr32` can recurse into [`read_layer_info`].
fn read_additional_layer_info(
    reader: &mut PsdReader,
    target: &mut LayerAdditionalInfo,
    psd: Option<&mut crate::psd::Psd>,
) -> ReadResult<()> {
    let sig = realign_with_signature(reader, is_valid_additional_info_signature)?;
    let key = read_signature(reader)?;

    let large = reader.large;
    let u64_size = sig == "8B64" || (large && crate::additional_info::is_large_key(&key));

    let options = reader.options.clone();
    let throw_for_missing = options.throw_for_missing_features == Some(true);
    let doc_width = reader.doc_width;
    let doc_height = reader.doc_height;

    read_section(
        reader,
        2,
        |reader, left| {
            let mut ctx = ReadCtx {
                options: &options,
                large,
                psd,
                doc_width,
                doc_height,
            };
            match read_additional_info_key(&key, reader, target, &left_fn_wrap(left), &mut ctx) {
                Ok(handled) => {
                    if !handled {
                        skip_bytes(reader, left(reader));
                    }
                }
                Err(e) => {
                    if throw_for_missing {
                        return Err(e);
                    }
                    // swallow and skip remaining
                }
            }
            if left(reader) > 0 {
                skip_bytes(reader, left(reader));
            }
            Ok(())
        },
        false,
        u64_size,
    )?;
    Ok(())
}

/// `read_additional_info_key` expects `&dyn Fn(&PsdReader)->usize`; the section
/// closure already provides one (`left`). This wrapper just re-types it.
fn left_fn_wrap<'a>(left: &'a dyn Fn(&PsdReader) -> usize) -> impl Fn(&PsdReader) -> usize + 'a {
    move |r: &PsdReader| left(r)
}

// ---------------------------------------------------------------------------
// readImageData (composite)
// ---------------------------------------------------------------------------

/// ES `ToUint8Clamp` / `Uint8ClampedArray` assignment: clamp to [0, 255],
/// round half to even.
fn to_u8_clamped(n: f64) -> u8 {
    if n.is_nan() {
        return 0;
    }
    let clamped = n.clamp(0.0, 255.0);
    let f = clamped.floor();
    if clamped < f + 0.5 {
        f as u8
    } else if clamped > f + 0.5 {
        (f as u8).saturating_add(1)
    } else if (f as u8) % 2 == 0 {
        f as u8
    } else {
        (f as u8).saturating_add(1)
    }
}

fn read_image_data(reader: &mut PsdReader, psd: &mut crate::psd::Psd) -> ReadResult<()> {
    let compression = compression_from_u16(read_uint16(reader)?);
    let bits_per_channel = psd.bits_per_channel.unwrap_or(8.0) as u32;
    let color_mode = psd.color_mode.unwrap_or(ColorMode::Rgb);

    let width = psd.width as usize;
    let height = psd.height as usize;
    let channels_count = psd.channels.unwrap_or(0.0) as usize;

    if compression != Compression::RawData && compression != Compression::RleCompressed {
        return Err(ReadError::StrictViolation(format!(
            "Compression type not supported: {:?}",
            compression
        )));
    }

    let mut image_data = if color_mode == ColorMode::Bitmap {
        // Bitmap is 1-bit → decoded into 8-bit RGBA.
        DecodeTarget::try_tracked(reader, width, height, 4, 8, AllocationCategory::Raster)?
    } else {
        DecodeTarget::try_tracked(
            reader,
            width,
            height,
            4,
            bits_per_channel.max(8),
            AllocationCategory::Raster,
        )?
    };
    reset_decode_target(&mut image_data);

    match color_mode {
        ColorMode::Bitmap => {
            if bits_per_channel != 1 {
                return Err(ReadError::StrictViolation(
                    "Invalid bitsPerChannel for bitmap color mode".to_string(),
                ));
            }
            let bytes: Vec<u8> = match compression {
                Compression::RawData => read_bytes(reader, ((width + 7) / 8) * height)?,
                Compression::RleCompressed => {
                    let mut tgt = DecodeTarget::try_tracked(
                        reader,
                        width,
                        height,
                        1,
                        8,
                        AllocationCategory::Channel,
                    )?;
                    read_data_rle(
                        reader,
                        Some(&mut tgt),
                        width,
                        height,
                        8,
                        1,
                        &[0],
                        reader.large,
                    )?;
                    tgt.data
                }
                _ => {
                    return Err(ReadError::StrictViolation(
                        "Bitmap compression not supported".to_string(),
                    ));
                }
            };
            decode_bitmap(&bytes, &mut image_data.data, width, height);
        }
        ColorMode::Rgb | ColorMode::Grayscale => {
            let mut channels: Vec<usize> = if color_mode == ColorMode::Grayscale {
                vec![0]
            } else {
                vec![0, 1, 2]
            };

            if channels_count > 3 {
                for i in 3..channels_count {
                    channels.push(i);
                }
            } else if reader.global_alpha {
                channels.push(3);
            }

            match compression {
                Compression::RawData => {
                    for &c in &channels {
                        let data =
                            read_bytes(reader, width * height * (bits_per_channel as usize / 8))?;
                        read_data_raw(&data, Some(&mut image_data), bits_per_channel, 4, c);
                    }
                }
                Compression::RleCompressed => {
                    read_data_rle(
                        reader,
                        Some(&mut image_data),
                        width,
                        height,
                        bits_per_channel,
                        4,
                        &channels,
                        reader.large,
                    )?;
                }
                _ => {}
            }

            if color_mode == ColorMode::Grayscale {
                setup_grayscale_depth(&mut image_data);
            }
        }
        ColorMode::Indexed => {
            if bits_per_channel != 8 {
                return Err(ReadError::StrictViolation(
                    "bitsPerChannel Not supported".to_string(),
                ));
            }
            if channels_count != 1 {
                return Err(ReadError::StrictViolation(
                    "Invalid channel count".to_string(),
                ));
            }
            let palette = psd
                .palette
                .clone()
                .ok_or_else(|| ReadError::StrictViolation("Missing color palette".to_string()))?;

            match compression {
                Compression::RleCompressed => {
                    let mut indexed = DecodeTarget::try_tracked(
                        reader,
                        width,
                        height,
                        1,
                        8,
                        AllocationCategory::Channel,
                    )?;
                    read_data_rle(
                        reader,
                        Some(&mut indexed),
                        width,
                        height,
                        bits_per_channel,
                        1,
                        &[0],
                        reader.large,
                    )?;
                    indexed_to_rgb(&indexed, &mut image_data, &palette);
                }
                _ => return Err(ReadError::StrictViolation("Not implemented".to_string())),
            }
        }
        _ => {
            return Err(ReadError::StrictViolation(format!(
                "Color mode not supported: {:?}",
                color_mode
            )));
        }
    }

    // remove weird white matte
    // Upstream writes into Uint8ClampedArray (round half up); writer re-mattes
    // into Uint8Array (truncate). Match clamped rounding here for RW byte parity.
    if reader.global_alpha && bits_per_channel == 8 {
        let p = &mut image_data.data;
        let size = width * height * 4;
        let mut i = 0;
        while i < size {
            let pa = p[i + 3];
            if pa != 0 && pa != 255 {
                let a = pa as f64 / 255.0;
                let ra = 1.0 / a;
                let inv_a = 255.0 * (1.0 - ra);
                p[i] = to_u8_clamped(p[i] as f64 * ra + inv_a);
                p[i + 1] = to_u8_clamped(p[i + 1] as f64 * ra + inv_a);
                p[i + 2] = to_u8_clamped(p[i + 2] as f64 * ra + inv_a);
            }
            i += 4;
        }
    }

    let pd = image_data.into_pixel_data();
    if reader.options.use_image_data == Some(true) {
        psd.image_data = Some(pd);
    } else {
        psd.canvas = Some(tracked_canvas(reader, &pd, AllocationCategory::Raster)?);
    }

    Ok(())
}

fn cmyk_to_rgb(cmyk: &DecodeTarget, rgb: &mut PixelData, reverse_alpha: bool) {
    let size = (rgb.width as usize) * (rgb.height as usize) * 4;
    let src = &cmyk.data;
    let dst = &mut rgb.data;
    let mut s = 0usize;
    let mut d = 0usize;
    while d < size && s + 4 < src.len() {
        let c = src[s] as u32;
        let m = src[s + 1] as u32;
        let y = src[s + 2] as u32;
        let k = src[s + 3] as u32;
        dst[d] = ((c * k) / 255) as u8;
        dst[d + 1] = ((m * k) / 255) as u8;
        dst[d + 2] = ((y * k) / 255) as u8;
        dst[d + 3] = if reverse_alpha {
            255 - src[s + 4]
        } else {
            src[s + 4]
        };
        s += 5;
        d += 4;
    }
}

fn indexed_to_rgb(indexed: &DecodeTarget, rgb: &mut DecodeTarget, palette: &[Rgb]) {
    let size = indexed.width * indexed.height;
    let mut d = 0usize;
    for s in 0..size {
        let idx = indexed.data[s] as usize;
        if let Some(c) = palette.get(idx) {
            rgb.data[d] = c.r as u8;
            rgb.data[d + 1] = c.g as u8;
            rgb.data[d + 2] = c.b as u8;
            rgb.data[d + 3] = 255;
        }
        d += 4;
    }
}

// ---------------------------------------------------------------------------
// readColor (consolidated) & readPattern
// ---------------------------------------------------------------------------

/// Consolidated `readColor` — the single public implementation. `effects_helpers`,
/// `image_resources`, `additional_info::adjustment_keys`, `doc_keys` and
/// `additional_info::misc_keys` all import this; there are no local copies.
pub fn read_color(reader: &mut PsdReader) -> ReadResult<Color> {
    let color_space = read_uint16(reader)?;
    if color_space == ColorSpace::Rgb as u16 {
        let r = read_uint16(reader)? as f64 / 257.0;
        let g = read_uint16(reader)? as f64 / 257.0;
        let b = read_uint16(reader)? as f64 / 257.0;
        skip_bytes(reader, 2);
        Ok(Color::Rgb(Rgb { r, g, b }))
    } else if color_space == ColorSpace::Hsb as u16 {
        let h = read_uint16(reader)? as f64 / 0xffff as f64;
        let s = read_uint16(reader)? as f64 / 0xffff as f64;
        let b = read_uint16(reader)? as f64 / 0xffff as f64;
        skip_bytes(reader, 2);
        Ok(Color::Hsb(Hsb { h, s, b }))
    } else if color_space == ColorSpace::Cmyk as u16 {
        let c = read_uint16(reader)? as f64 / 257.0;
        let m = read_uint16(reader)? as f64 / 257.0;
        let y = read_uint16(reader)? as f64 / 257.0;
        let k = read_uint16(reader)? as f64 / 257.0;
        Ok(Color::Cmyk(Cmyk { c, m, y, k }))
    } else if color_space == ColorSpace::Lab as u16 {
        let l = read_int16(reader)? as f64 / 10000.0;
        let ta = read_int16(reader)? as f64;
        let tb = read_int16(reader)? as f64;
        let a = if ta < 0.0 { ta / 12800.0 } else { ta / 12700.0 };
        let b = if tb < 0.0 { tb / 12800.0 } else { tb / 12700.0 };
        skip_bytes(reader, 2);
        Ok(Color::Lab(Lab { l, a, b }))
    } else if color_space == ColorSpace::Grayscale as u16 {
        let k = read_uint16(reader)? as f64 * 255.0 / 10000.0;
        skip_bytes(reader, 6);
        Ok(Color::Grayscale(Grayscale { k }))
    } else {
        Err(ReadError::StrictViolation(
            "Invalid color space".to_string(),
        ))
    }
}

/// Consolidated `readPattern` (upstream `psdReader.ts`). Used by ABR, Patt*, and
/// any other pattern section — do not reintroduce private copies.
pub fn read_pattern(reader: &mut PsdReader) -> ReadResult<PatternInfo> {
    let length = read_uint32(reader)? as usize;
    let length = length
        .checked_add((4 - length % 4) % 4)
        .ok_or(ReadError::SizeTooLarge)?;
    let end = reader
        .offset
        .checked_add(length)
        .ok_or(ReadError::SizeTooLarge)?;
    if end > reader.len() {
        return Err(ReadError::SectionExceedsFileSize);
    }
    let version = read_uint32(reader)?;
    if version != 1 {
        return Err(ReadError::StrictViolation(format!(
            "Invalid pattern version: {}",
            version
        )));
    }

    let color_mode_raw = read_uint32(reader)?;
    let color_mode = color_mode_from_u16(color_mode_raw as u16);
    let x = read_int16(reader)? as f64;
    let y = read_int16(reader)? as f64;

    if !matches!(
        color_mode,
        Some(ColorMode::Rgb) | Some(ColorMode::Grayscale) | Some(ColorMode::Indexed)
    ) {
        return Err(ReadError::StrictViolation(format!(
            "Unsupported pattern color mode: {}",
            color_mode_raw
        )));
    }
    let color_mode = match color_mode {
        Some(mode) => mode,
        None => {
            return Err(ReadError::StrictViolation(
                "Unsupported pattern color mode".into(),
            ));
        }
    };

    let name = read_unicode_string(reader)?;
    let id = read_pascal_string(reader, 1)?;

    let mut palette = [Rgb {
        r: 0.0,
        g: 0.0,
        b: 0.0,
    }; 256];
    if color_mode == ColorMode::Indexed {
        for color in &mut palette {
            *color = Rgb {
                r: read_uint8(reader)? as f64,
                g: read_uint8(reader)? as f64,
                b: read_uint8(reader)? as f64,
            };
        }
        skip_bytes(reader, 4);
    }

    let version2 = read_uint32(reader)?;
    if version2 != 3 {
        return Err(ReadError::StrictViolation(format!(
            "Invalid pattern VMAL version: {}",
            version2
        )));
    }

    read_uint32(reader)?; // length
    let top = read_uint32(reader)? as i64;
    let left = read_uint32(reader)? as i64;
    let bottom = read_uint32(reader)? as i64;
    let right = read_uint32(reader)? as i64;
    let channels_count = read_uint32(reader)? as usize;
    let width = usize::try_from(right.checked_sub(left).ok_or(ReadError::SizeTooLarge)?)
        .map_err(|_| ReadError::SizeTooLarge)?;
    let height = usize::try_from(bottom.checked_sub(top).ok_or(ReadError::SizeTooLarge)?)
        .map_err(|_| ReadError::SizeTooLarge)?;
    let channel_slots = channels_count
        .checked_add(2)
        .ok_or(ReadError::SizeTooLarge)?;
    if channel_slots > end.saturating_sub(reader.offset) / 4 {
        return Err(ReadError::UnexpectedEndOfBuffer);
    }
    let (raster, raster_lease) =
        DecodeTarget::try_temporary(reader, width, height, 4, 8, AllocationCategory::Raster)?;
    let mut data = raster.data;
    let mut i = 3;
    while i < data.len() {
        data[i] = 255;
        i += 4;
    }

    let mut ch = 0usize;
    for _ in 0..channel_slots {
        if end.saturating_sub(reader.offset) < 4 {
            return Err(ReadError::SectionExceedsFileSize);
        }
        let has = read_uint32(reader)?;
        if has == 0 {
            continue;
        }
        if end.saturating_sub(reader.offset) < 4 {
            return Err(ReadError::SectionExceedsFileSize);
        }
        let length = read_uint32(reader)? as usize;
        let channel_end = reader
            .offset
            .checked_add(length)
            .ok_or(ReadError::SizeTooLarge)?;
        if channel_end > end {
            return Err(ReadError::SectionExceedsFileSize);
        }
        let data_length = length
            .checked_sub(4 + 16 + 2 + 1)
            .ok_or_else(|| ReadError::StrictViolation("Invalid pattern channel length".into()))?;
        let pixel_depth = read_uint32(reader)?;
        let ctop = read_uint32(reader)? as i64;
        let cleft = read_uint32(reader)? as i64;
        let cbottom = read_uint32(reader)? as i64;
        let cright = read_uint32(reader)? as i64;
        let pixel_depth2 = read_uint16(reader)?;
        let compression_mode = read_uint8(reader)?;

        if pixel_depth != 8 || pixel_depth2 != 8 {
            return Err(ReadError::StrictViolation(
                "16bit pixel depth not supported for patterns".to_string(),
            ));
        }

        // Channel rectangles must fit the VMAL canvas before any decode or copy.
        if ctop < top
            || cleft < left
            || cbottom < ctop
            || cright < cleft
            || cbottom > bottom
            || cright > right
        {
            return Err(ReadError::StrictViolation(
                "Invalid pattern channel bounds".into(),
            ));
        }
        let w = usize::try_from(cright - cleft).map_err(|_| ReadError::SizeTooLarge)?;
        let h = usize::try_from(cbottom - ctop).map_err(|_| ReadError::SizeTooLarge)?;
        let ox = usize::try_from(cleft - left).map_err(|_| ReadError::SizeTooLarge)?;
        let oy = usize::try_from(ctop - top).map_err(|_| ReadError::SizeTooLarge)?;
        let channel_pixels = w.checked_mul(h).ok_or(ReadError::SizeTooLarge)?;
        if compression_mode == 0 && data_length < channel_pixels {
            return Err(ReadError::UnexpectedEndOfBuffer);
        }
        // Borrow complete payloads: padding truncated raw planes would fabricate pixels.
        let cdata = read_bytes_slice(reader, data_length)?;
        if channel_pixels == 0 && compression_mode <= 1 {
            ch += 1;
            continue;
        }

        if compression_mode == 0 {
            if color_mode == ColorMode::Rgb && ch < 3 {
                for yy in 0..h {
                    for xx in 0..w {
                        let src = xx + yy * w;
                        let dst = (ox + xx + (yy + oy) * width) * 4;
                        if dst + ch < data.len() && src < cdata.len() {
                            data[dst + ch] = cdata[src];
                        }
                    }
                }
            } else if color_mode == ColorMode::Grayscale && ch < 1 {
                for yy in 0..h {
                    for xx in 0..w {
                        let src = xx + yy * w;
                        let dst = (ox + xx + (yy + oy) * width) * 4;
                        if dst + 2 < data.len() && src < cdata.len() {
                            let value = cdata[src];
                            data[dst] = value;
                            data[dst + 1] = value;
                            data[dst + 2] = value;
                        }
                    }
                }
            } else if color_mode == ColorMode::Indexed {
                // Upstream readPattern: expand palette indices to RGB (raw only).
                for yy in 0..h {
                    for xx in 0..w {
                        let src = xx + yy * w;
                        let dst = (ox + xx + (yy + oy) * width) * 4;
                        if dst + 2 >= data.len() || src >= cdata.len() {
                            continue;
                        }
                        let index = cdata[src] as usize;
                        let color = palette.get(index).copied().unwrap_or(Rgb {
                            r: 0.0,
                            g: 0.0,
                            b: 0.0,
                        });
                        data[dst] = color.r as u8;
                        data[dst + 1] = color.g as u8;
                        data[dst + 2] = color.b as u8;
                    }
                }
            }
        } else if compression_mode == 1 {
            // Ignored channels must not allocate and zero a decoded plane.
            if (color_mode == ColorMode::Rgb && ch >= 3)
                || (color_mode == ColorMode::Grayscale && ch >= 1)
            {
                ch += 1;
                continue;
            }
            let (mut temp, _channel_lease) =
                DecodeTarget::try_temporary(reader, w, h, 1, 8, AllocationCategory::Channel)?;
            let mut cdata_reader = PsdReader::child(cdata, reader);
            if color_mode == ColorMode::Rgb && ch < 3 {
                read_data_rle(&mut cdata_reader, Some(&mut temp), w, h, 8, 1, &[0], false)?;
                copy_channel_to_rgba(&temp, &mut data, width, ox, oy, ch);
            } else if color_mode == ColorMode::Grayscale && ch < 1 {
                read_data_rle(&mut cdata_reader, Some(&mut temp), w, h, 8, 1, &[0], false)?;
                copy_channel_to_rgba(&temp, &mut data, width, ox, oy, 0);
                // setup grayscale on the destination region is approximated by
                // copying channel 0 into 1 and 2 in copy step below.
                copy_channel_to_rgba(&temp, &mut data, width, ox, oy, 1);
                copy_channel_to_rgba(&temp, &mut data, width, ox, oy, 2);
            } else if color_mode == ColorMode::Indexed {
                // Upstream: TODO / throws for RLE-indexed patterns.
                return Err(ReadError::StrictViolation(
                    "Indexed pattern color mode not implemented".to_string(),
                ));
            }
        } else {
            return Err(ReadError::StrictViolation(
                "Invalid pattern compression mode".to_string(),
            ));
        }

        ch += 1;
    }

    reader.offset = end;
    raster_lease.persist();

    Ok(PatternInfo {
        id,
        name,
        x,
        y,
        bounds: PatternBounds {
            x: left as f64,
            y: top as f64,
            w: width as f64,
            h: height as f64,
        },
        data,
    })
}

fn copy_channel_to_rgba(
    src: &DecodeTarget,
    dst: &mut [u8],
    dst_width: usize,
    ox: usize,
    oy: usize,
    offset: usize,
) {
    let w = src.width;
    let h = src.height;
    for y in 0..h {
        for x in 0..w {
            let s = x + y * w;
            let d = (ox + x + (y + oy) * dst_width) * 4;
            if d + offset < dst.len() && s < src.data.len() {
                dst[d + offset] = src.data[s];
            }
        }
    }
}

#[cfg(test)]
#[path = "reader/security_tests.rs"]
mod security_tests;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scalar_round_trip_big_endian() {
        // Hand-crafted big-endian bytes.
        // u8=0x12, i8=-1(0xFF), i16=-2(0xFFFE), u16=0x0102, i32=-3, u32=0x01020304
        let buf: Vec<u8> = vec![
            0x12, // u8
            0xFF, // i8 = -1
            0xFF, 0xFE, // i16 = -2
            0x01, 0x02, // u16 = 0x0102
            0xFF, 0xFF, 0xFF, 0xFD, // i32 = -3
            0x01, 0x02, 0x03, 0x04, // u32 = 0x01020304
        ];
        let mut r = PsdReader::new(&buf, None, None);
        assert_eq!(read_uint8(&mut r).unwrap(), 0x12);
        assert_eq!(read_int8(&mut r).unwrap(), -1);
        assert_eq!(read_int16(&mut r).unwrap(), -2);
        assert_eq!(read_uint16(&mut r).unwrap(), 0x0102);
        assert_eq!(read_int32(&mut r).unwrap(), -3);
        assert_eq!(read_uint32(&mut r).unwrap(), 0x0102_0304);
        assert_eq!(r.offset, buf.len());
    }

    #[test]
    fn float_round_trip_big_endian() {
        let f32v: f32 = 3.5;
        let f64v: f64 = -1234.5678;
        let mut buf = Vec::new();
        buf.extend_from_slice(&f32v.to_be_bytes());
        buf.extend_from_slice(&f64v.to_be_bytes());
        let mut r = PsdReader::new(&buf, None, None);
        assert_eq!(read_float32(&mut r).unwrap(), f32v);
        assert_eq!(read_float64(&mut r).unwrap(), f64v);
    }

    #[test]
    fn uint16_le_differs_from_be() {
        let buf = vec![0x01, 0x02];
        let mut r = PsdReader::new(&buf, None, None);
        assert_eq!(read_uint16_le(&mut r).unwrap(), 0x0201);
    }

    #[test]
    fn fixed_point() {
        // 16.16: value 1.5 -> int32 = 1.5 * 65536 = 98304 = 0x00018000
        let buf = vec![0x00, 0x01, 0x80, 0x00];
        let mut r = PsdReader::new(&buf, None, None);
        assert_eq!(read_fixed_point32(&mut r).unwrap(), 1.5);
    }

    #[test]
    fn signature_and_check() {
        let buf = b"8BIM".to_vec();
        let mut r = PsdReader::new(&buf, None, None);
        assert!(valid_signature_at(&r, 0));
        check_signature(&mut r, "8BIM", None).unwrap();

        let mut r2 = PsdReader::new(&buf, None, None);
        let err = check_signature(&mut r2, "8BPS", None).unwrap_err();
        assert_eq!(
            err,
            ReadError::InvalidSignature {
                signature: "8BIM".to_string(),
                offset: 0
            }
        );
    }

    #[test]
    fn pascal_string_pad_to_2() {
        // length=3, "abc", padTo=2: bytes consumed = 1(len)+3(text)=4, already
        // multiple of 2 -> no extra padding. count starts at length+1=4.
        let buf = vec![0x03, b'a', b'b', b'c'];
        let mut r = PsdReader::new(&buf, None, None);
        assert_eq!(read_pascal_string(&mut r, 2).unwrap(), "abc");
        assert_eq!(r.offset, 4);
    }

    #[test]
    fn pascal_string_with_padding() {
        // length=2, "ab", padTo=4: total with len byte = 3, must pad to 4 -> +1.
        let buf = vec![0x02, b'a', b'b', 0x00, 0xFF];
        let mut r = PsdReader::new(&buf, None, None);
        assert_eq!(read_pascal_string(&mut r, 4).unwrap(), "ab");
        // consumed: len(1) + text(2) + pad(1) = 4
        assert_eq!(r.offset, 4);
    }

    #[test]
    fn pascal_string_empty() {
        // length=0, padTo=4: count starts at 1, pads to 4 -> 3 extra offset bumps.
        let buf = vec![0x00, 0x00, 0x00, 0x00];
        let mut r = PsdReader::new(&buf, None, None);
        assert_eq!(read_pascal_string(&mut r, 4).unwrap(), "");
        // len byte read (offset 1) + 3 pad bumps = 4
        assert_eq!(r.offset, 4);
    }

    #[test]
    fn unicode_string_with_length() {
        // "Hi" + trailing \0 -> length 3 code units, big-endian uint16 each.
        let buf = vec![
            0x00, 0x00, 0x00, 0x03, // uint32 length = 3
            0x00, 0x48, // 'H'
            0x00, 0x69, // 'i'
            0x00, 0x00, // trailing \0 (dropped)
        ];
        let mut r = PsdReader::new(&buf, None, None);
        assert_eq!(read_unicode_string(&mut r).unwrap(), "Hi");
    }

    #[test]
    fn unicode_string_non_ascii() {
        // Cyrillic YA (U+042F)
        let buf = vec![
            0x00, 0x00, 0x00, 0x01, // length 1
            0x04, 0x2F, // U+042F
        ];
        let mut r = PsdReader::new(&buf, None, None);
        assert_eq!(read_unicode_string(&mut r).unwrap(), "Я");
    }

    #[test]
    fn unicode_string_surrogate_pair() {
        // U+1F600 emoji -> surrogate pair D83D DE00
        let buf = vec![
            0x00, 0x00, 0x00, 0x02, // length 2 units
            0xD8, 0x3D, // high surrogate
            0xDE, 0x00, // low surrogate
        ];
        let mut r = PsdReader::new(&buf, None, None);
        assert_eq!(read_unicode_string(&mut r).unwrap(), "😀");
    }

    #[test]
    fn signature_str_is_latin1_codeunits() {
        // bytes > 127 must map to their code point, not be UTF-8 decoded.
        let buf = vec![0xFF, 0x00, b'A', b'B'];
        let mut r = PsdReader::new(&buf, None, None);
        let sig = read_signature(&mut r).unwrap();
        let chars: Vec<u32> = sig.chars().map(|c| c as u32).collect();
        assert_eq!(chars, vec![0xFF, 0x00, 0x41, 0x42]);
    }

    #[test]
    fn read_bytes_recovery_past_end() {
        let buf = vec![0x01, 0x02];
        let mut r = PsdReader::new(&buf, None, None);
        // ask for 4 bytes; only 2 available, not strict -> zero-filled result.
        let out = read_bytes(&mut r, 4).unwrap();
        assert_eq!(out, vec![0x01, 0x02, 0x00, 0x00]);
        assert_eq!(r.offset, 4);
    }

    #[test]
    fn read_bytes_strict_errors() {
        let buf = vec![0x01, 0x02];
        let mut r = PsdReader::new(&buf, None, None);
        r.strict = true;
        // strict mode routes through warn_or_throw -> StrictViolation (upstream `throw`).
        let err = read_bytes(&mut r, 4).unwrap_err();
        assert_eq!(
            err,
            ReadError::StrictViolation("Reading bytes exceeding buffer length".to_string())
        );
    }

    #[test]
    fn section_rounding() {
        // length prefix = 3 (uint32 BE), then 3 payload bytes, round=4.
        // Payload: read 3 bytes via func. After func offset == end (4+3=7).
        // Rounding: length 3 -> 4, end 7 -> 8. Final offset must be 8.
        let buf = vec![
            0x00, 0x00, 0x00, 0x03, // length = 3
            0xAA, 0xBB, 0xCC, // payload (3 bytes)
            0xEE, // padding byte to reach rounded end
        ];
        let mut r = PsdReader::new(&buf, None, None);
        let collected: Vec<u8> = read_section(
            &mut r,
            4,
            |reader, left| {
                assert_eq!(left(reader), 3);
                let a = read_uint8(reader)?;
                let b = read_uint8(reader)?;
                let c = read_uint8(reader)?;
                assert_eq!(left(reader), 0);
                Ok(vec![a, b, c])
            },
            true,
            false,
        )
        .unwrap()
        .unwrap();
        assert_eq!(collected, vec![0xAA, 0xBB, 0xCC]);
        // end was 7, rounded up to 8.
        assert_eq!(r.offset, 8);
    }

    #[test]
    fn section_empty_skipped() {
        let buf = vec![0x00, 0x00, 0x00, 0x00];
        let mut r = PsdReader::new(&buf, None, None);
        let res: Option<()> = read_section(&mut r, 4, |_r, _left| Ok(()), true, false).unwrap();
        assert!(res.is_none());
    }

    #[test]
    fn section_eight_bytes() {
        // eightBytes: first uint32 must be 0, then real uint32 length.
        let buf = vec![
            0x00, 0x00, 0x00, 0x00, // high u32 = 0
            0x00, 0x00, 0x00, 0x02, // low u32 = 2 (length)
            0x11, 0x22, // payload
        ];
        let mut r = PsdReader::new(&buf, None, None);
        let res: Option<u16> =
            read_section(&mut r, 1, |reader, _left| read_uint16(reader), true, true).unwrap();
        assert_eq!(res, Some(0x1122));
    }

    #[test]
    fn section_exceeds_file() {
        let buf = vec![0x00, 0x00, 0x00, 0x10]; // claims 16 bytes but none follow
        let mut r = PsdReader::new(&buf, None, None);
        let err = read_section::<(), _>(&mut r, 1, |_r, _l| Ok(()), true, false).unwrap_err();
        assert_eq!(err, ReadError::SectionExceedsFileSize);
    }

    // -----------------------------------------------------------------------
    // Real-fixture end-to-end pipeline tests (read_psd).
    // -----------------------------------------------------------------------

    fn fixture_path(rel: &str) -> Option<std::path::PathBuf> {
        let root = crate::test_corpus::corpus_root().join("read");
        let path = root.join(rel).join("src.psd");
        if path.is_file() { Some(path) } else { None }
    }

    fn read_fixture(rel: &str) -> Option<crate::psd::Psd> {
        let path = match fixture_path(rel) {
            Some(p) => p,
            None => {
                eprintln!("fixture missing (set PSDX_FIXTURES_DIR), skipping: {}", rel);
                return None;
            }
        };
        let bytes =
            std::fs::read(&path).unwrap_or_else(|e| panic!("read {}: {}", path.display(), e));
        let opts = ReadOptions::default();
        Some(read_psd(&bytes, &opts).unwrap_or_else(|e| panic!("read_psd {}: {:?}", rel, e)))
    }

    fn count_layers(layers: &[Layer]) -> usize {
        layers
            .iter()
            .map(|l| 1 + l.children.as_ref().map_or(0, |c| count_layers(c)))
            .sum()
    }

    fn any_layer_has_pixels(layers: &[Layer]) -> bool {
        layers.iter().any(|l| {
            let has = l.canvas.as_ref().map_or(false, |c| !c.data.is_empty())
                || l.image_data.as_ref().map_or(false, |c| !c.data.is_empty());
            has || l
                .children
                .as_ref()
                .map_or(false, |c| any_layer_has_pixels(c))
        })
    }

    #[test]
    fn read_fixture_layers_rgb8() {
        let Some(psd) = read_fixture("layers") else {
            return;
        };
        assert_eq!(psd.width, 300.0);
        assert_eq!(psd.height, 200.0);
        assert_eq!(psd.color_mode, Some(ColorMode::Rgb));
        assert_eq!(psd.bits_per_channel, Some(8.0));
        let children = psd.children.as_ref().expect("children");
        assert_eq!(children.len(), 3, "top-level children count");
        assert!(
            any_layer_has_pixels(children),
            "at least one layer has pixel data"
        );
        // composite image should be present (not skipped)
        assert!(psd.canvas.as_ref().map_or(false, |c| !c.data.is_empty()));
    }

    #[test]
    fn read_fixture_groups_nesting() {
        let Some(psd) = read_fixture("groups") else {
            return;
        };
        assert_eq!(psd.width, 300.0);
        assert_eq!(psd.height, 200.0);
        assert_eq!(psd.color_mode, Some(ColorMode::Rgb));
        let children = psd.children.as_ref().expect("children");
        assert_eq!(
            children.len(),
            2,
            "top-level children count (2 incl. group)"
        );
        // total layers across the tree should exceed top-level count (nesting).
        assert!(count_layers(children) >= 3);
        assert!(any_layer_has_pixels(children));
    }

    #[test]
    fn read_fixture_just_bg_no_layers() {
        let Some(psd) = read_fixture("just-bg") else {
            return;
        };
        assert_eq!(psd.width, 100.0);
        assert_eq!(psd.height, 100.0);
        assert_eq!(psd.color_mode, Some(ColorMode::Rgb));
        let count = psd.children.as_ref().map_or(0, |c| c.len());
        assert_eq!(count, 0, "background-only document has no layer children");
        assert!(psd.canvas.as_ref().map_or(false, |c| !c.data.is_empty()));
    }

    #[test]
    fn new_with_offset_window() {
        let buf = vec![0x00, 0x11, 0x22, 0x33, 0x44];
        let mut r = PsdReader::new(&buf, Some(1), Some(2));
        // window is [0x11, 0x22]; cursor starts at 0 relative to window.
        assert_eq!(read_uint8(&mut r).unwrap(), 0x11);
        assert_eq!(read_uint8(&mut r).unwrap(), 0x22);
        assert!(read_uint8(&mut r).is_err());
    }
}
