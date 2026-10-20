/*
File: rust/crates/psd-x/src/writer.rs

Purpose:
low-level writing of bytes into a PSD buffer (write structures/cursor, number/string primitives).

Source compatibility:
- port of upstream ag-psd `src/psdWriter.ts` (1:1 split).

Main responsibilities:
- mirror the corresponding upstream module while porting;
- keep this area's public contract in one place.
*/

// PORT STATUS: primitives ported; document orchestration ported.

use crate::additional_info::{WriteCtx, write_additional_info};
use crate::helpers::{
    Bounds as ChannelBounds, ChannelData, ColorSpace, LayerChannelData, LayerMaskFlags, MaskParams,
    clamp, from_blend_mode, has_alpha, offset_for_channel, write_data_rle,
    write_data_zip_without_prediction,
};
use crate::image_resources::{RESOURCE_IDS, has_image_resource, write_image_resource};
use crate::psd::{
    BlendMode, ChannelId, Color, ColorMode, Compression, GlobalLayerMaskInfo, Layer,
    LayerAdditionalInfo, LayerMaskData, PatternInfo, PixelData, Psd, SectionDividerType,
    WriteOptions,
};

/// Errors from the write path (mirror of upstream `throw new Error(...)` strings).
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum WriteError {
    /// Upstream: `Invalid document size`
    #[error("Invalid document size")]
    InvalidDocumentSize,
    /// Upstream: `Document size is too large (max is 30000x30000, use PSB format instead)`
    #[error("Document size is too large (max is 30000x30000, use PSB format instead)")]
    DocumentTooLarge,
    /// Upstream: `bitsPerChannel other than 8 are not supported for writing`
    #[error("bitsPerChannel other than 8 are not supported for writing")]
    UnsupportedBitsPerChannel,
    /// Upstream: `Document canvas must have the same size as document`
    #[error("Document canvas must have the same size as document")]
    CanvasSizeMismatch,
    /// Upstream: `Invalid layer, cannot have both 'canvas' and 'children' properties`
    #[error("Invalid layer, cannot have both 'canvas' and 'children' properties")]
    InvalidLayerCanvasAndChildren,
    /// Upstream: `Invalid layer, cannot have both 'imageData' and 'children' properties`
    #[error("Invalid layer, cannot have both 'imageData' and 'children' properties")]
    InvalidLayerImageDataAndChildren,
    /// Upstream typo retained: `Invalid imageData dimentions`
    #[error("Invalid imageData dimentions")]
    InvalidImageDataDimentions,
    /// Upstream: `Invalid signature: '…'`
    #[error("Invalid signature: '{0}'")]
    InvalidSignature(String),
    /// Upstream: `String too long`
    #[error("String too long")]
    StringTooLong,
    /// I/O or compression failure while encoding.
    #[error("{0}")]
    Io(String),
    /// Internal invariant / unexpected failure.
    #[error("{0}")]
    Internal(String),
}

/// Result type for write operations.
pub type WriteResult<T> = Result<T, WriteError>;

/// Port of the TS `PsdWriter` interface.
///
/// Upstream uses a preallocated fixed-size `ArrayBuffer`
/// plus `DataView` plus an `offset` cursor; the buffer grows by doubling (`resizeBuffer`).
/// Here `buffer: Vec<u8>` holds "capacity" filled with zeros,
/// and `offset` bytes are actually written. This matches upstream byte-for-byte:
/// `getWriterBuffer` returns the `[0, offset)` slice, and `ensureSize`/`resizeBuffer`
/// reproduce the doubling logic. `tempBuffer` belongs to document orchestration
/// (RLE buffer) and is unused by these primitives, but the field is kept for
/// mirroring.
#[derive(Debug, Clone)]
pub struct PsdWriter {
    /// Analog of a fixed-capacity `ArrayBuffer` (zero-filled to the end).
    pub buffer: Vec<u8>,
    /// Write cursor (number of bytes actually written).
    pub offset: usize,
    /// Temporary buffer for RLE compression (used by document orchestration).
    pub temp_buffer: Option<Vec<u8>>,
}

/// Port of `createWriter(size = 4096)`.
pub fn create_writer(size: usize) -> PsdWriter {
    PsdWriter {
        buffer: vec![0u8; size],
        offset: 0,
        temp_buffer: None,
    }
}

/// Port of `createWriter()` with default size 4096.
pub fn create_writer_default() -> PsdWriter {
    create_writer(4096)
}

impl PsdWriter {
    /// Port of `getWriterBuffer(writer)` — `buffer.slice(0, offset)` (copy).
    pub fn to_bytes(&self) -> Vec<u8> {
        self.buffer[..self.offset].to_vec()
    }

    /// Port of `getWriterBufferNoCopy(writer)` — `Uint8Array(buffer, 0, offset)` (no copy).
    pub fn as_bytes(&self) -> &[u8] {
        &self.buffer[..self.offset]
    }
}

// ===========================================================================
// Buffer growth (resizeBuffer / ensureSize / addSize)
// ===========================================================================

/// Port of `resizeBuffer(writer, size)`.
fn resize_buffer(writer: &mut PsdWriter, size: usize) {
    let mut new_length = writer.buffer.len();

    // do { newLength *= 2; } while (size > newLength);
    loop {
        new_length *= 2;
        if size <= new_length {
            break;
        }
    }

    writer.buffer.resize(new_length, 0);
}

/// Port of `ensureSize(writer, size)`.
fn ensure_size(writer: &mut PsdWriter, size: usize) {
    if size > writer.buffer.len() {
        resize_buffer(writer, size);
    }
}

/// Port of `addSize(writer, size)` — returns the previous `offset`, advances the cursor.
fn add_size(writer: &mut PsdWriter, size: usize) -> usize {
    let offset = writer.offset;
    writer.offset += size;
    ensure_size(writer, writer.offset);
    offset
}

// ===========================================================================
// Big-endian / little-endian helpers (mirror DataView.setXxx)
//
// Endianness: upstream all `view.setInt16/Uint16/Int32/Uint32/Float32/Float64`
// are called with `littleEndian = false`, i.e. PSD is big-endian. Exceptions are explicit
// `*LE` variants (`setUint16(..., true)`, `setInt32(..., true)`).
// ===========================================================================

#[inline]
fn set_bytes_be(writer: &mut PsdWriter, offset: usize, bytes: &[u8]) {
    writer.buffer[offset..offset + bytes.len()].copy_from_slice(bytes);
}

// ===========================================================================
// Scalar writers
// ===========================================================================

/// Port of `writeUint8`.
pub fn write_uint8(writer: &mut PsdWriter, value: u8) {
    let offset = add_size(writer, 1);
    writer.buffer[offset] = value;
}

/// Port of `writeInt16` (big-endian).
pub fn write_int16(writer: &mut PsdWriter, value: i16) {
    let offset = add_size(writer, 2);
    set_bytes_be(writer, offset, &value.to_be_bytes());
}

/// Port of `writeUint16` (big-endian).
pub fn write_uint16(writer: &mut PsdWriter, value: u16) {
    let offset = add_size(writer, 2);
    set_bytes_be(writer, offset, &value.to_be_bytes());
}

/// Port of `writeUint16LE` (little-endian).
pub fn write_uint16_le(writer: &mut PsdWriter, value: u16) {
    let offset = add_size(writer, 2);
    set_bytes_be(writer, offset, &value.to_le_bytes());
}

/// Port of `writeInt32` (big-endian).
pub fn write_int32(writer: &mut PsdWriter, value: i32) {
    let offset = add_size(writer, 4);
    set_bytes_be(writer, offset, &value.to_be_bytes());
}

/// Port of `writeInt32LE` (little-endian).
pub fn write_int32_le(writer: &mut PsdWriter, value: i32) {
    let offset = add_size(writer, 4);
    set_bytes_be(writer, offset, &value.to_le_bytes());
}

/// Port of `writeUint32` (big-endian).
pub fn write_uint32(writer: &mut PsdWriter, value: u32) {
    let offset = add_size(writer, 4);
    set_bytes_be(writer, offset, &value.to_be_bytes());
}

/// Port of `writeFloat32` (big-endian).
pub fn write_float32(writer: &mut PsdWriter, value: f32) {
    let offset = add_size(writer, 4);
    set_bytes_be(writer, offset, &value.to_be_bytes());
}

/// Port of `writeFloat64` (big-endian).
pub fn write_float64(writer: &mut PsdWriter, value: f64) {
    let offset = add_size(writer, 8);
    set_bytes_be(writer, offset, &value.to_be_bytes());
}

/// Port of `writeFixedPoint32` — 32-bit fixed-point 16.16 number.
pub fn write_fixed_point32(writer: &mut PsdWriter, value: f64) {
    write_int32(writer, (value * (1i64 << 16) as f64) as i32);
}

/// Port of `writeFixedPointPath32` — 32-bit fixed-point 8.24 number.
pub fn write_fixed_point_path32(writer: &mut PsdWriter, value: f64) {
    write_int32(writer, (value * (1i64 << 24) as f64) as i32);
}

/// Port of `writeBytes`. In Rust an empty slice equals `undefined`/empty buffer.
pub fn write_bytes(writer: &mut PsdWriter, buffer: Option<&[u8]>) {
    if let Some(buffer) = buffer {
        ensure_size(writer, writer.offset + buffer.len());
        let offset = writer.offset;
        writer.buffer[offset..offset + buffer.len()].copy_from_slice(buffer);
        writer.offset += buffer.len();
    }
}

/// Port of `writeZeros(writer, count)`.
pub fn write_zeros(writer: &mut PsdWriter, count: usize) {
    for _ in 0..count {
        write_uint8(writer, 0);
    }
}

/// Port of `writeSignature(writer, signature)` — exactly 4 ASCII characters.
pub fn write_signature(writer: &mut PsdWriter, signature: &str) -> WriteResult<()> {
    if signature.len() != 4 {
        return Err(WriteError::InvalidSignature(signature.to_string()));
    }

    for b in signature.bytes() {
        write_uint8(writer, b);
    }
    Ok(())
}

/// Port of `writeAsciiString(writer, text)` — one char-code per byte.
///
/// Upstream uses `charCodeAt` (UTF-16 code unit); for non-ASCII strings
/// the result is truncated to the low byte. Here we mirror via character
/// codes (`char as u32 as u8`), which matches for ASCII.
pub fn write_ascii_string(writer: &mut PsdWriter, text: &str) {
    for ch in text.chars() {
        write_uint8(writer, (ch as u32) as u8);
    }
}

/// Port of `writePascalString(writer, text, padTo)`.
pub fn write_pascal_string(writer: &mut PsdWriter, text: &str, pad_to: usize) -> WriteResult<()> {
    if pad_to == 0 {
        return Err(WriteError::Internal(
            "Pascal string padding must be non-zero".into(),
        ));
    }
    let chars: Vec<char> = text.chars().collect();
    let mut length = chars.len();
    if length > 255 {
        return Err(WriteError::StringTooLong);
    }

    write_uint8(writer, length as u8);

    for &ch in &chars {
        let code = ch as u32;
        // code < 128 ? code : '?'
        write_uint8(writer, if code < 128 { code as u8 } else { b'?' });
    }

    // while (++length % padTo) writeUint8(0)
    length += 1;
    while length % pad_to != 0 {
        write_uint8(writer, 0);
        length += 1;
    }
    Ok(())
}

/// Port of `writeUnicodeStringWithoutLength` — UTF-16 BE code units, no length prefix.
pub fn write_unicode_string_without_length(writer: &mut PsdWriter, text: &str) {
    for unit in text.encode_utf16() {
        write_uint16(writer, unit);
    }
}

/// Port of `writeUnicodeStringWithoutLengthLE` — UTF-16 LE code units, no length prefix.
pub fn write_unicode_string_without_length_le(writer: &mut PsdWriter, text: &str) {
    for unit in text.encode_utf16() {
        write_uint16_le(writer, unit);
    }
}

/// Port of `writeUnicodeString` — length prefix (in UTF-16 code units) + BE string.
pub fn write_unicode_string(writer: &mut PsdWriter, text: &str) {
    let len = text.encode_utf16().count();
    write_uint32(writer, len as u32);
    write_unicode_string_without_length(writer, text);
}

/// Port of `writeUnicodeStringWithPadding` — length+1, BE string, trailing 0.
pub fn write_unicode_string_with_padding(writer: &mut PsdWriter, text: &str) {
    let len = text.encode_utf16().count();
    write_uint32(writer, (len + 1) as u32);

    for unit in text.encode_utf16() {
        write_uint16(writer, unit);
    }

    write_uint16(writer, 0);
}

// ===========================================================================
// Section helper
// ===========================================================================

/// Port of `writeSection(writer, round, func, writeTotalLength = false, large = false)`.
///
/// Writes a length prefix (4 bytes BE; when `large` — two 4-byte words),
/// runs `func`, then adds padding to a multiple of `round` and
/// backpatches the section length.
pub fn write_section<F>(
    writer: &mut PsdWriter,
    round: usize,
    func: F,
    write_total_length: bool,
    large: bool,
) -> WriteResult<()>
where
    F: FnOnce(&mut PsdWriter) -> WriteResult<()>,
{
    if large {
        write_uint32(writer, 0);
    }
    let offset = writer.offset;
    write_uint32(writer, 0);

    func(writer)?;

    let mut length = writer.offset - offset - 4;
    let mut len = length;

    while len % round != 0 {
        write_uint8(writer, 0);
        len += 1;
    }

    if write_total_length {
        length = len;
    }

    // writer.view.setUint32(offset, length, false)
    set_bytes_be(writer, offset, &(length as u32).to_be_bytes());
    Ok(())
}

// ===========================================================================
// Color / Pattern generic helpers
// ===========================================================================

/// Port of `writeColor(writer, color)`.
pub fn write_color(writer: &mut PsdWriter, color: Option<&Color>) {
    match color {
        None => {
            write_uint16(writer, ColorSpace::Rgb as u16);
            write_zeros(writer, 8);
        }
        Some(Color::Rgba(c)) => {
            // 'r' in color
            write_uint16(writer, ColorSpace::Rgb as u16);
            write_uint16(writer, (c.r * 257.0).round() as u16);
            write_uint16(writer, (c.g * 257.0).round() as u16);
            write_uint16(writer, (c.b * 257.0).round() as u16);
            write_uint16(writer, 0);
        }
        Some(Color::Rgb(c)) => {
            // 'r' in color
            write_uint16(writer, ColorSpace::Rgb as u16);
            write_uint16(writer, (c.r * 257.0).round() as u16);
            write_uint16(writer, (c.g * 257.0).round() as u16);
            write_uint16(writer, (c.b * 257.0).round() as u16);
            write_uint16(writer, 0);
        }
        Some(Color::Frgb(c)) => {
            // 'fr' in color
            write_uint16(writer, ColorSpace::Rgb as u16);
            write_uint16(writer, (c.fr * 255.0 * 257.0).round() as u16);
            write_uint16(writer, (c.fg * 255.0 * 257.0).round() as u16);
            write_uint16(writer, (c.fb * 255.0 * 257.0).round() as u16);
            write_uint16(writer, 0);
        }
        Some(Color::Lab(c)) => {
            // 'l' in color
            write_uint16(writer, ColorSpace::Lab as u16);
            write_int16(writer, (c.l * 10000.0).round() as i16);
            write_int16(
                writer,
                (if c.a < 0.0 {
                    c.a * 12800.0
                } else {
                    c.a * 12700.0
                })
                .round() as i16,
            );
            write_int16(
                writer,
                (if c.b < 0.0 {
                    c.b * 12800.0
                } else {
                    c.b * 12700.0
                })
                .round() as i16,
            );
            write_uint16(writer, 0);
        }
        Some(Color::Hsb(c)) => {
            // 'h' in color
            write_uint16(writer, ColorSpace::Hsb as u16);
            write_uint16(writer, (c.h * 0xffff as f64).round() as u16);
            write_uint16(writer, (c.s * 0xffff as f64).round() as u16);
            write_uint16(writer, (c.b * 0xffff as f64).round() as u16);
            write_uint16(writer, 0);
        }
        Some(Color::Cmyk(c)) => {
            // 'c' in color
            write_uint16(writer, ColorSpace::Cmyk as u16);
            write_uint16(writer, (c.c * 257.0).round() as u16);
            write_uint16(writer, (c.m * 257.0).round() as u16);
            write_uint16(writer, (c.y * 257.0).round() as u16);
            write_uint16(writer, (c.k * 257.0).round() as u16);
        }
        Some(Color::Grayscale(c)) => {
            // else
            write_uint16(writer, ColorSpace::Grayscale as u16);
            write_uint16(writer, (c.k * 10000.0 / 255.0).round() as u16);
            write_zeros(writer, 6);
        }
    }
}

/// Port of `writePattern(writer, pattern)`.
///
/// Operates only on `PatternInfo` and the `write_data_rle` primitive, with no knowledge of
/// the Psd/Layer shape, so it stays in the primitives layer.
pub fn write_pattern(writer: &mut PsdWriter, pattern: &PatternInfo) {
    let width = pattern.bounds.w as u32;
    let height = pattern.bounds.h as u32;
    let pixel_data = PixelData::rgba8(width, height, pattern.data.clone());

    write_uint32(writer, 0); // length, fixed up below
    let patts_offset = writer.offset;

    write_uint32(writer, 1); // version
    write_uint32(writer, ColorMode::Rgb as u32); // color mode - rgb only

    write_int16(writer, pattern.x as i16);
    write_int16(writer, pattern.y as i16);

    write_unicode_string(writer, &format!("{}\0", pattern.name)); // name
    write_pascal_string(writer, &pattern.id, 1).expect("pattern id pascal string"); // id

    // virtual memory array list
    write_uint32(writer, 3); // version
    write_uint32(writer, 0); // length, fixed up below
    let vl_offset = writer.offset;

    let top = pattern.bounds.y as u32;
    let left = pattern.bounds.x as u32;
    let bottom = top + height;
    let right = left + width;

    write_uint32(writer, top);
    write_uint32(writer, left);
    write_uint32(writer, bottom);
    write_uint32(writer, right);

    write_uint32(writer, 24); // channels count

    // channels: RGB at indices 0,1,2 and alpha at index 25
    for i in 0..(24 + 2) {
        let offset: i32 = if i < 3 {
            i
        } else if i == 25 {
            3
        } else {
            -1
        };

        if offset < 0 {
            write_uint32(writer, 0); // has
            continue;
        }

        // worst-case RLE size for a single channel
        let mut buffer = vec![0u8; (width * height + 2 * height + 2 * width + 16) as usize];
        let data = write_data_rle(&mut buffer, &pixel_data, &[offset as usize], false)
            .expect("write_data_rle returned None for pattern channel");

        write_uint32(writer, 1); // has
        write_uint32(writer, (data.len() + 4 + 16 + 2 + 1) as u32); // length
        write_uint32(writer, 8); // pixelDepth
        write_uint32(writer, top);
        write_uint32(writer, left);
        write_uint32(writer, bottom);
        write_uint32(writer, right);
        write_uint16(writer, 8); // pixelDepth2
        write_uint8(writer, 1); // compressionMode - rle
        write_bytes(writer, Some(&data));
    }

    let vl_length = writer.offset - vl_offset;
    let mut patts_length = writer.offset - patts_offset;

    while patts_length % 4 != 0 {
        write_zeros(writer, 1);
        patts_length += 1;
    }

    set_bytes_be(writer, vl_offset - 4, &(vl_length as u32).to_be_bytes());
    set_bytes_be(
        writer,
        patts_offset - 4,
        &(patts_length as u32).to_be_bytes(),
    );
}

// ===========================================================================
// Document orchestration (port of psdWriter.ts writePsd & friends)
// ===========================================================================

/// Port of `getLargestLayerSize(layers)`.
fn largest_layer_size(layers: Option<&[Layer]>) -> usize {
    let mut max = 0usize;
    let layers = match layers {
        Some(l) => l,
        None => return 0,
    };
    for layer in layers {
        if layer.canvas.is_some() || layer.image_data.is_some() {
            let (width, height) =
                layer_dimensions(layer.canvas.as_ref(), layer.image_data.as_ref());
            let (w, h) = (width as usize, height as usize);
            max = max.max(2 * h + 2 * w * h);
        }
        if let Some(children) = &layer.children {
            max = max.max(largest_layer_size(Some(children)));
        }
    }
    max
}

/// Port of `getLayerDimentions({ canvas, imageData })`.
/// imageData takes priority over canvas (as upstream).
fn layer_dimensions(canvas: Option<&PixelData>, image_data: Option<&PixelData>) -> (u32, u32) {
    if let Some(d) = image_data {
        (d.width, d.height)
    } else if let Some(c) = canvas {
        (c.width, c.height)
    } else {
        (0, 0)
    }
}

/// Port of `verifyBitCount(target)`. In the byte model PixelData is always 8-bit
/// (no Uint16Array/Uint32Array), so the check trivially passes. Kept
/// for mirroring (no-op recursion).
fn verify_bit_count(_target_children: Option<&[Layer]>) {
    // PixelData is always RGBA8 in this port; nothing to verify.
}

/// Public entry point: build `.psd` bytes from a document.
/// Port of the `writePsd` (psd.ts) + `writePsd(writer, ...)` (psdWriter.ts) pairing.
pub fn write_psd(psd: &Psd, options: &WriteOptions) -> WriteResult<Vec<u8>> {
    let mut writer = create_writer_default();
    write_psd_to_writer(&mut writer, psd, options)?;
    Ok(writer.to_bytes())
}

/// Port of `writePsd(writer, psd, options)`.
pub fn write_psd_to_writer(
    writer: &mut PsdWriter,
    psd: &Psd,
    options: &WriteOptions,
) -> WriteResult<()> {
    if !(psd.width > 0.0 && psd.height > 0.0) {
        return Err(WriteError::InvalidDocumentSize);
    }

    let psb = options.psb == Some(true);

    if (psd.width > 30000.0 || psd.height > 30000.0) && !psb {
        return Err(WriteError::DocumentTooLarge);
    }

    let bits_per_channel = psd.bits_per_channel.unwrap_or(8.0);
    if bits_per_channel != 8.0 {
        return Err(WriteError::UnsupportedBitsPerChannel);
    }

    verify_bit_count(psd.children.as_deref());

    // imageResources: { ...psd.imageResources }, optionally with generated thumbnail.
    let mut image_resources = psd.image_resources.clone().unwrap_or_default();
    if options.generate_thumbnail == Some(true) {
        if let Some(thumb) = crate::thumbnail::create_thumbnail(psd) {
            image_resources.thumbnail = Some(thumb);
        }
    }

    // imageData (composite). Our model stores both image_data and canvas as
    // PixelData; image_data takes priority, falling back to canvas.
    let image_data: Option<&PixelData> = psd.image_data.as_ref().or(psd.canvas.as_ref());

    if let Some(id) = image_data {
        if psd.width as u32 != id.width || psd.height as u32 != id.height {
            return Err(WriteError::CanvasSizeMismatch);
        }
    }

    let global_alpha = image_data.map(has_alpha).unwrap_or(false);

    let max_buffer_size = largest_layer_size(psd.children.as_deref())
        .max(4 * 2 * (psd.width as usize) * (psd.height as usize) + 2 * (psd.height as usize));
    writer.temp_buffer = Some(vec![0u8; max_buffer_size]);

    // header
    write_signature(writer, "8BPS")?;
    write_uint16(writer, if psb { 2 } else { 1 }); // version
    write_zeros(writer, 6);
    write_uint16(writer, if global_alpha { 4 } else { 3 }); // channels
    write_uint32(writer, psd.height as u32);
    write_uint32(writer, psd.width as u32);
    write_uint16(writer, bits_per_channel as u16);
    write_uint16(writer, ColorMode::Rgb as u16); // we only support saving RGB

    // color mode data
    let palette = psd.palette.clone();
    write_section(
        writer,
        1,
        |w| {
            if let Some(palette) = &palette {
                for i in 0..256 {
                    w_palette_byte(w, palette.get(i).map(|c| c.r));
                }
                for i in 0..256 {
                    w_palette_byte(w, palette.get(i).map(|c| c.g));
                }
                for i in 0..256 {
                    w_palette_byte(w, palette.get(i).map(|c| c.b));
                }
            }
            Ok(())
        },
        false,
        false,
    )?;

    // layers (flattened with section dividers)
    //
    // upstream unconditionally does `if (!layers.length) layers.push({})`, which
    // materialises a single empty placeholder layer even for documents that have
    // no layers section at all (e.g. a background-only PSD where `psd.children`
    // is absent). That makes read(write(x)) gain a spurious child for such files.
    // We only add the placeholder when the document actually carries a layers
    // section (`children` present), so a background-only / no-layer document
    // round-trips to the same (zero) child count it was read with. Documents with
    // an explicit (possibly empty) children list still get the placeholder, as
    // upstream requires for a valid layer section.
    let has_layer_section = psd.children.is_some();
    let mut layers: Vec<Layer> = Vec::new();
    add_children(&mut layers, psd.children.as_deref())?;
    if layers.is_empty() && has_layer_section {
        layers.push(Layer::default());
    }

    // image resources — upstream always writes layersGroup / layerGroupsEnabledId
    // (1026 / 1072) from the flattened layer list.
    image_resources.layers_group =
        Some(layers.iter().map(|l| l.link_group.unwrap_or(0.0)).collect());
    image_resources.layer_groups_enabled_id = Some(
        layers
            .iter()
            .map(|l| {
                if l.link_group_enabled == Some(false) {
                    0.0
                } else {
                    1.0
                }
            })
            .collect(),
    );
    write_section(
        writer,
        1,
        |w| {
            for &id in RESOURCE_IDS {
                let count = has_image_resource(id, &image_resources);
                for i in 0..count {
                    write_signature(w, "8BIM")?;
                    write_uint16(w, id);
                    write_pascal_string(w, "", 2)?;
                    write_section(
                        w,
                        2,
                        |w| {
                            write_image_resource(id, w, &image_resources, i).map_err(|e| {
                                WriteError::Internal(format!("write_image_resource: {e}"))
                            })?;
                            Ok(())
                        },
                        false,
                        false,
                    )?;
                }
            }
            Ok(())
        },
        false,
        false,
    )?;

    // layer and mask info
    write_section(
        writer,
        2,
        |w| {
            write_layer_info(w, &layers, psd, global_alpha, options, psb)?;
            write_global_layer_mask_info(w, psd.global_layer_mask_info.as_ref())?;
            // document-level additional layer info (linked files / artboards / Anno)
            let mut ctx = WriteCtx::new(options, psb);
            ctx.linked_files = psd.linked_files.as_deref();
            ctx.artboards = psd.artboards.as_ref();
            ctx.annotations = psd.annotations.as_deref();
            ctx.doc_width = psd.width;
            ctx.doc_height = psd.height;
            write_additional_info(w, &psd.additional_info, &mut ctx)?;
            Ok(())
        },
        false,
        psb,
    )?;

    // image data (composite)
    let channels: Vec<usize> = if global_alpha {
        vec![0, 1, 2, 3]
    } else {
        vec![0, 1, 2]
    };
    let width = image_data.map(|d| d.width).unwrap_or(psd.width as u32);
    let height = image_data.map(|d| d.height).unwrap_or(psd.height as u32);
    let mut data = PixelData::rgba8(
        width,
        height,
        vec![0u8; (width as usize) * (height as usize) * 4],
    );

    write_uint16(writer, Compression::RleCompressed as u16);

    if let Some(id) = image_data {
        data.data[..id.data.len()].copy_from_slice(&id.data);

        // add weird white matte
        if global_alpha {
            let size = (data.width as usize) * (data.height as usize) * 4;
            let p = &mut data.data;
            let mut i = 0;
            while i < size {
                let pa = p[i + 3];
                if pa != 0 && pa != 255 {
                    let a = pa as f64 / 255.0;
                    let ra = 255.0 * (1.0 - a);
                    p[i] = (p[i] as f64 * a + ra) as u8;
                    p[i + 1] = (p[i + 1] as f64 * a + ra) as u8;
                    p[i + 2] = (p[i + 2] as f64 * a + ra) as u8;
                }
                i += 4;
            }
        }
    }

    let mut temp = writer.temp_buffer.take().unwrap();
    let rle = write_data_rle(&mut temp, &data, &channels, psb);
    writer.temp_buffer = Some(temp);
    write_bytes(writer, rle.as_deref());
    Ok(())
}

/// Write one palette byte (0 if color is absent).
fn w_palette_byte(writer: &mut PsdWriter, value: Option<f64>) {
    write_uint8(writer, value.unwrap_or(0.0) as u8);
}

/// Port of `writeLayerInfo(writer, layers, psd, globalAlpha, options)`.
fn write_layer_info(
    writer: &mut PsdWriter,
    layers: &[Layer],
    psd: &Psd,
    global_alpha: bool,
    options: &WriteOptions,
    psb: bool,
) -> WriteResult<()> {
    write_section(
        writer,
        4,
        |w| {
            write_int16(
                w,
                if global_alpha {
                    -(layers.len() as i16)
                } else {
                    layers.len() as i16
                },
            );

            // extract channels for every layer
            let mut temp = w.temp_buffer.take().unwrap();
            let mut layers_data: Vec<LayerChannelData> = Vec::with_capacity(layers.len());
            for (i, l) in layers.iter().enumerate() {
                layers_data.push(collect_channels(&mut temp, l, i == 0, options, psb)?);
            }
            w.temp_buffer = Some(temp);

            // layer records
            let mut ctx = WriteCtx::new(options, psb);
            ctx.doc_width = psd.width;
            ctx.doc_height = psd.height;
            for layer_data in &layers_data {
                let layer = &layer_data.layer;
                write_int32(w, layer_data.top);
                write_int32(w, layer_data.left);
                write_int32(w, layer_data.bottom);
                write_int32(w, layer_data.right);
                write_uint16(w, layer_data.channels.len() as u16);

                for c in &layer_data.channels {
                    write_int16(w, c.channel_id);
                    if psb {
                        write_uint32(w, 0);
                    }
                    write_uint32(w, c.length as u32);
                }

                write_signature(w, "8BIM")?;
                let blend = layer.blend_mode.map(from_blend_mode).unwrap_or("norm");
                write_signature(w, blend)?;
                write_uint8(
                    w,
                    (clamp(layer.opacity.unwrap_or(1.0), 0.0, 1.0) * 255.0).round() as u8,
                );
                write_uint8(w, if layer.clipping == Some(true) { 1 } else { 0 });

                let mut flags: u8 = 0x08;
                if layer.transparency_protected == Some(true) {
                    flags |= 0x01;
                }
                if layer.hidden == Some(true) {
                    flags |= 0x02;
                }
                let info = &layer.additional_info;
                let section_irrelevant = info
                    .section_divider
                    .as_ref()
                    .map_or(false, |sd| sd.divider_type != SectionDividerType::Other);
                if info.vector_mask.is_some() || section_irrelevant || info.adjustment.is_some() {
                    flags |= 0x10;
                }
                if layer.effects_open == Some(true) {
                    flags |= 0x20;
                }

                write_uint8(w, flags);
                write_uint8(w, 0); // filler

                write_section(
                    w,
                    1,
                    |w| {
                        write_layer_mask_data(w, info, layer_data)?;
                        write_layer_blending_ranges(w, info)?;
                        let name = info.name.clone().unwrap_or_default();
                        let name: String = name.chars().take(255).collect();
                        write_pascal_string(w, &name, 4)?;
                        write_additional_info(w, info, &mut ctx)?;
                        Ok(())
                    },
                    false,
                    false,
                )?;
            }

            // layer channel image data
            for layer_data in &mut layers_data {
                for channel in &layer_data.channels {
                    write_uint16(w, channel.compression as u16);
                    if let Some(buffer) = &channel.buffer {
                        write_bytes(w, Some(buffer));
                    }
                }
            }
            Ok(())
        },
        true,
        psb,
    )
}

/// Port of `writeLayerMaskData(writer, { mask, realMask }, layerData)`.
fn write_layer_mask_data(
    writer: &mut PsdWriter,
    info: &LayerAdditionalInfo,
    layer_data: &LayerChannelData,
) -> WriteResult<()> {
    let mask = info.mask.as_ref();
    let real_mask = info.real_mask.as_ref();
    write_section(
        writer,
        1,
        |w| {
            if mask.is_none() && real_mask.is_none() {
                return Ok(());
            }

            let mut params: u8 = 0;
            let mut flags: u8 = 0;
            let mut real_flags: u8 = 0;

            if let Some(mask) = mask {
                if mask.user_mask_density.is_some() {
                    params |= MaskParams::UserMaskDensity as u8;
                }
                if mask.user_mask_feather.is_some() {
                    params |= MaskParams::UserMaskFeather as u8;
                }
                if mask.vector_mask_density.is_some() {
                    params |= MaskParams::VectorMaskDensity as u8;
                }
                if mask.vector_mask_feather.is_some() {
                    params |= MaskParams::VectorMaskFeather as u8;
                }

                if mask.disabled == Some(true) {
                    flags |= LayerMaskFlags::LayerMaskDisabled as u8;
                }
                if mask.position_relative_to_layer == Some(true) {
                    flags |= LayerMaskFlags::PositionRelativeToLayer as u8;
                }
                if mask.from_vector_data == Some(true) {
                    flags |= LayerMaskFlags::LayerMaskFromRenderingOtherData as u8;
                }
                if params != 0 {
                    flags |= LayerMaskFlags::MaskHasParametersAppliedToIt as u8;
                }
            }

            let m = layer_data.mask.unwrap_or_default();
            write_int32(w, m.top);
            write_int32(w, m.left);
            write_int32(w, m.bottom);
            write_int32(w, m.right);
            write_uint8(w, mask.and_then(|m| m.default_color).unwrap_or(0.0) as u8);
            write_uint8(w, flags);

            if let Some(real_mask) = real_mask {
                if real_mask.disabled == Some(true) {
                    real_flags |= LayerMaskFlags::LayerMaskDisabled as u8;
                }
                if real_mask.position_relative_to_layer == Some(true) {
                    real_flags |= LayerMaskFlags::PositionRelativeToLayer as u8;
                }
                if real_mask.from_vector_data == Some(true) {
                    real_flags |= LayerMaskFlags::LayerMaskFromRenderingOtherData as u8;
                }

                let r = layer_data.real_mask.unwrap_or_default();
                write_uint8(w, real_flags);
                write_uint8(w, real_mask.default_color.unwrap_or(0.0) as u8);
                write_int32(w, r.top);
                write_int32(w, r.left);
                write_int32(w, r.bottom);
                write_int32(w, r.right);
            }

            if params != 0 {
                if let Some(mask) = mask {
                    write_uint8(w, params);
                    if let Some(v) = mask.user_mask_density {
                        write_uint8(w, (v * 0xff as f64).round() as u8);
                    }
                    if let Some(v) = mask.user_mask_feather {
                        write_float64(w, v);
                    }
                    if let Some(v) = mask.vector_mask_density {
                        write_uint8(w, (v * 0xff as f64).round() as u8);
                    }
                    if let Some(v) = mask.vector_mask_feather {
                        write_float64(w, v);
                    }
                }
            }

            write_zeros(w, 2);
            Ok(())
        },
        false,
        false,
    )
}

/// Port of `writerBlendingRange`.
fn write_blending_range(writer: &mut PsdWriter, range: &[f64]) {
    write_uint8(writer, range[0] as u8);
    write_uint8(writer, range[1] as u8);
    write_uint8(writer, range[2] as u8);
    write_uint8(writer, range[3] as u8);
}

/// Port of `writeLayerBlendingRanges(writer, layer)`.
fn write_layer_blending_ranges(
    writer: &mut PsdWriter,
    info: &LayerAdditionalInfo,
) -> WriteResult<()> {
    let ranges = info.blending_ranges.clone();
    write_section(
        writer,
        1,
        |w| {
            if let Some(ranges) = &ranges {
                write_blending_range(w, &ranges.composite_gray_blend_source);
                write_blending_range(w, &ranges.composite_graph_blend_destination_range);
                for r in &ranges.ranges {
                    write_blending_range(w, &r.source_range);
                    write_blending_range(w, &r.dest_range);
                }
            }
            Ok(())
        },
        false,
        false,
    )
}

/// Port of `writeGlobalLayerMaskInfo(writer, info)`.
fn write_global_layer_mask_info(
    writer: &mut PsdWriter,
    info: Option<&GlobalLayerMaskInfo>,
) -> WriteResult<()> {
    let info = info.cloned();
    write_section(
        writer,
        1,
        |w| {
            if let Some(info) = &info {
                write_uint16(w, info.overlay_color_space as u16);
                write_uint16(w, info.color_space1 as u16);
                write_uint16(w, info.color_space2 as u16);
                write_uint16(w, info.color_space3 as u16);
                write_uint16(w, info.color_space4 as u16);
                write_uint16(w, (info.opacity * 0xff as f64) as u16);
                write_uint8(w, info.kind as u8);
                write_zeros(w, 3);
            }
            Ok(())
        },
        false,
        false,
    )
}

/// Port of `addChildren(layers, children)`.
fn add_children(layers: &mut Vec<Layer>, children: Option<&[Layer]>) -> WriteResult<()> {
    let children = match children {
        Some(c) => c,
        None => return Ok(()),
    };

    for c in children {
        if c.children.is_some() && c.canvas.is_some() {
            return Err(WriteError::InvalidLayerCanvasAndChildren);
        }
        if c.children.is_some() && c.image_data.is_some() {
            return Err(WriteError::InvalidLayerImageDataAndChildren);
        }

        if c.children.is_some() {
            // bounding section divider
            let mut open_layer = Layer::default();
            open_layer.additional_info.name = Some("</Layer group>".to_string());
            open_layer.additional_info.section_divider = Some(crate::psd::SectionDivider {
                divider_type: SectionDividerType::BoundingSectionDivider,
                key: None,
                sub_type: None,
            });
            layers.push(open_layer);

            add_children(layers, c.children.as_deref())?;

            // closing folder layer: copy of `c` with adjusted blend mode + divider
            let mut folder = c.clone();
            folder.children = None;
            if folder.blend_mode == Some(BlendMode::PassThrough) {
                folder.blend_mode = Some(BlendMode::Normal);
            }
            let key = c
                .blend_mode
                .map(from_blend_mode)
                .unwrap_or("pass")
                .to_string();
            folder.additional_info.section_divider = Some(crate::psd::SectionDivider {
                divider_type: if c.opened == Some(false) {
                    SectionDividerType::ClosedFolder
                } else {
                    SectionDividerType::OpenFolder
                },
                key: Some(key),
                sub_type: Some(0.0),
            });
            layers.push(folder);
        } else {
            layers.push(c.clone());
        }
    }
    Ok(())
}

/// Port of `getChannels(tempBuffer, layer, background, options)`.
fn collect_channels(
    temp_buffer: &mut [u8],
    layer: &Layer,
    background: bool,
    options: &WriteOptions,
    psb: bool,
) -> WriteResult<LayerChannelData> {
    // Upstream psdWriter.ts:661-664 — pass through pre-encoded channel bytes.
    if let Some(raw) = &layer.raw_data {
        let top = layer.top.unwrap_or(0.0) as i32;
        let left = layer.left.unwrap_or(0.0) as i32;
        let right = layer.right.unwrap_or(0.0) as i32;
        let bottom = layer.bottom.unwrap_or(0.0) as i32;
        let mask = layer.additional_info.mask.as_ref().map(|m| ChannelBounds {
            top: m.top.unwrap_or(0.0) as i32,
            left: m.left.unwrap_or(0.0) as i32,
            right: m.right.unwrap_or(0.0) as i32,
            bottom: m.bottom.unwrap_or(0.0) as i32,
        });
        let real_mask = layer
            .additional_info
            .real_mask
            .as_ref()
            .map(|m| ChannelBounds {
                top: m.top.unwrap_or(0.0) as i32,
                left: m.left.unwrap_or(0.0) as i32,
                right: m.right.unwrap_or(0.0) as i32,
                bottom: m.bottom.unwrap_or(0.0) as i32,
            });
        return Ok(LayerChannelData {
            layer: layer.clone(),
            channels: raw
                .channels
                .iter()
                .map(|c| ChannelData {
                    channel_id: c.id,
                    compression: c.compression,
                    buffer: c.data.clone(),
                    length: 2 + c.data.as_ref().map(|d| d.len()).unwrap_or(0),
                })
                .collect(),
            top,
            left,
            right,
            bottom,
            mask,
            real_mask,
        });
    }

    let mut layer_data = layer_channels(temp_buffer, layer, background, options, psb);
    if let Some(mask) = &layer.additional_info.mask {
        append_mask_channel(temp_buffer, &mut layer_data, mask, options, psb, false)?;
    }
    if let Some(real_mask) = &layer.additional_info.real_mask {
        append_mask_channel(temp_buffer, &mut layer_data, real_mask, options, psb, true)?;
    }
    Ok(layer_data)
}

/// Port of `getMaskChannels(...)`.
fn append_mask_channel(
    temp_buffer: &mut [u8],
    layer_data: &mut LayerChannelData,
    mask: &LayerMaskData,
    options: &WriteOptions,
    psb: bool,
    real_mask: bool,
) -> WriteResult<()> {
    let top = mask.top.unwrap_or(0.0) as i32;
    let left = mask.left.unwrap_or(0.0) as i32;
    let (width, height) = layer_dimensions(mask.canvas.as_ref(), mask.image_data.as_ref());

    let image_data = mask.image_data.as_ref().or(mask.canvas.as_ref());

    if let Some(id) = image_data {
        if id.width != width || id.height != height {
            return Err(WriteError::InvalidImageDataDimentions);
        }
    }

    let right = left + width as i32;
    let bottom = top + height as i32;

    let (buffer, compression): (Vec<u8>, Compression) = if image_data.is_none() {
        (Vec::new(), Compression::RleCompressed)
    } else if options.compress == Some(true) {
        (
            write_data_zip_without_prediction(image_data.unwrap(), &[0]).unwrap_or_default(),
            Compression::ZipWithoutPrediction,
        )
    } else {
        (
            write_data_rle(temp_buffer, image_data.unwrap(), &[0], psb).unwrap_or_default(),
            Compression::RleCompressed,
        )
    };

    let length = 2 + buffer.len();
    layer_data.channels.push(ChannelData {
        channel_id: if real_mask {
            ChannelId::RealUserMask as i16
        } else {
            ChannelId::UserMask as i16
        },
        compression,
        buffer: Some(buffer),
        length,
    });

    let bounds = ChannelBounds {
        top,
        left,
        right,
        bottom,
    };
    if real_mask {
        layer_data.real_mask = Some(bounds);
    } else {
        layer_data.mask = Some(bounds);
    }
    Ok(())
}

/// Port of `cropImageData(data, left, top, width, height)`.
fn crop_image_data(
    data: &PixelData,
    left: usize,
    top: usize,
    width: usize,
    height: usize,
) -> PixelData {
    let mut dst = vec![0u8; width * height * 4];
    let src = &data.data;
    let dw = data.width as usize;
    for y in 0..height {
        for x in 0..width {
            let s = ((x + left) + (y + top) * dw) * 4;
            let d = (x + y * width) * 4;
            dst[d] = src[s];
            dst[d + 1] = src[s + 1];
            dst[d + 2] = src[s + 2];
            dst[d + 3] = src[s + 3];
        }
    }
    PixelData::rgba8(width as u32, height as u32, dst)
}

/// Port of `getLayerChannels(tempBuffer, layer, background, options)`.
fn layer_channels(
    temp_buffer: &mut [u8],
    layer: &Layer,
    background: bool,
    options: &WriteOptions,
    psb: bool,
) -> LayerChannelData {
    let mut top = layer.top.unwrap_or(0.0) as i32;
    let mut left = layer.left.unwrap_or(0.0) as i32;
    #[allow(unused_assignments)]
    let mut right = layer.right.unwrap_or(0.0) as i32;
    #[allow(unused_assignments)]
    let mut bottom = layer.bottom.unwrap_or(0.0) as i32;

    // default empty channel set (Transparency, Color0..2), all length=2.
    let default_channels = || {
        vec![
            ChannelData {
                channel_id: ChannelId::Transparency as i16,
                compression: Compression::RawData,
                buffer: None,
                length: 2,
            },
            ChannelData {
                channel_id: ChannelId::Color0 as i16,
                compression: Compression::RawData,
                buffer: None,
                length: 2,
            },
            ChannelData {
                channel_id: ChannelId::Color1 as i16,
                compression: Compression::RawData,
                buffer: None,
                length: 2,
            },
            ChannelData {
                channel_id: ChannelId::Color2 as i16,
                compression: Compression::RawData,
                buffer: None,
                length: 2,
            },
        ]
    };

    let (mut width, mut height) =
        layer_dimensions(layer.canvas.as_ref(), layer.image_data.as_ref());

    if (layer.canvas.is_none() && layer.image_data.is_none()) || width == 0 || height == 0 {
        right = left;
        bottom = top;
        return LayerChannelData {
            layer: layer.clone(),
            channels: default_channels(),
            top,
            left,
            right,
            bottom,
            mask: None,
            real_mask: None,
        };
    }

    right = left + width as i32;
    bottom = top + height as i32;

    let mut data: PixelData = layer
        .image_data
        .clone()
        .or_else(|| layer.canvas.clone())
        .unwrap();

    if options.trim_image_data == Some(true) {
        let trimmed = trim_data(&data);
        if trimmed.left != 0
            || trimmed.top != 0
            || trimmed.right != data.width as i32
            || trimmed.bottom != data.height as i32
        {
            left += trimmed.left;
            top += trimmed.top;
            right -= data.width as i32 - trimmed.right;
            bottom -= data.height as i32 - trimmed.bottom;
            width = (right - left) as u32;
            height = (bottom - top) as u32;

            if width == 0 || height == 0 {
                return LayerChannelData {
                    layer: layer.clone(),
                    channels: default_channels(),
                    top,
                    left,
                    right,
                    bottom,
                    mask: None,
                    real_mask: None,
                };
            }

            data = crop_image_data(
                &data,
                trimmed.left as usize,
                trimmed.top as usize,
                width as usize,
                height as usize,
            );
        }
    }

    let mut channel_ids = vec![
        ChannelId::Color0 as i16,
        ChannelId::Color1 as i16,
        ChannelId::Color2 as i16,
    ];

    if !background
        || options.no_background == Some(true)
        || layer.additional_info.mask.is_some()
        || has_alpha(&data)
    {
        channel_ids.insert(0, ChannelId::Transparency as i16);
    }

    let channels: Vec<ChannelData> = channel_ids
        .into_iter()
        .map(|channel_id| {
            let offset = offset_for_channel(channel_id, false) as usize;
            let (buffer, compression): (Vec<u8>, Compression) = if options.compress == Some(true) {
                (
                    write_data_zip_without_prediction(&data, &[offset]).unwrap_or_default(),
                    Compression::ZipWithoutPrediction,
                )
            } else {
                (
                    write_data_rle(temp_buffer, &data, &[offset], psb).unwrap_or_default(),
                    Compression::RleCompressed,
                )
            };
            let length = 2 + buffer.len();
            ChannelData {
                channel_id,
                compression,
                buffer: Some(buffer),
                length,
            }
        })
        .collect();

    LayerChannelData {
        layer: layer.clone(),
        channels,
        top,
        left,
        right,
        bottom,
        mask: None,
        real_mask: None,
    }
}

/// Port of `isRowEmpty`.
fn is_row_empty(data: &PixelData, y: usize, left: usize, right: usize) -> bool {
    let width = data.width as usize;
    let start = (y * width + left) * 4 + 3;
    let end = start + (right - left) * 4;
    let mut i = start;
    while i < end {
        if data.data[i] != 0 {
            return false;
        }
        i += 4;
    }
    true
}

/// Port of `isColEmpty`.
fn is_col_empty(data: &PixelData, x: usize, top: usize, bottom: usize) -> bool {
    let width = data.width as usize;
    let stride = width * 4;
    let start = top * stride + x * 4 + 3;
    let mut y = top;
    let mut i = start;
    while y < bottom {
        if data.data[i] != 0 {
            return false;
        }
        y += 1;
        i += stride;
    }
    true
}

/// Port of `trimData(data)`. Returns cropped bounds in data coordinates.
fn trim_data(data: &PixelData) -> ChannelBounds {
    let mut top = 0i32;
    let mut left = 0i32;
    let mut right = data.width as i32;
    let mut bottom = data.height as i32;

    while top < bottom && is_row_empty(data, top as usize, left as usize, right as usize) {
        top += 1;
    }
    while bottom > top && is_row_empty(data, (bottom - 1) as usize, left as usize, right as usize) {
        bottom -= 1;
    }
    while left < right && is_col_empty(data, left as usize, top as usize, bottom as usize) {
        left += 1;
    }
    while right > left && is_col_empty(data, (right - 1) as usize, top as usize, bottom as usize) {
        right -= 1;
    }

    ChannelBounds {
        top,
        left,
        right,
        bottom,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::psd::{Cmyk, Grayscale, Hsb, Lab, Rgb};

    #[test]
    fn scalars_big_endian() {
        let mut w = create_writer_default();
        write_uint8(&mut w, 0x12);
        write_uint16(&mut w, 0x1234);
        write_int16(&mut w, -2);
        write_uint32(&mut w, 0x12345678);
        write_int32(&mut w, -1);
        let buf = w.to_bytes();
        assert_eq!(
            buf,
            vec![
                0x12, // u8
                0x12, 0x34, // u16 BE
                0xff, 0xfe, // i16 BE (-2)
                0x12, 0x34, 0x56, 0x78, // u32 BE
                0xff, 0xff, 0xff, 0xff, // i32 BE (-1)
            ]
        );
    }

    #[test]
    fn le_variants() {
        let mut w = create_writer_default();
        write_uint16_le(&mut w, 0x1234);
        write_int32_le(&mut w, 0x12345678);
        assert_eq!(w.to_bytes(), vec![0x34, 0x12, 0x78, 0x56, 0x34, 0x12]);
    }

    #[test]
    fn floats_big_endian() {
        let mut w = create_writer_default();
        write_float32(&mut w, 1.0_f32);
        write_float64(&mut w, 1.0_f64);
        assert_eq!(
            w.to_bytes(),
            vec![
                0x3f, 0x80, 0x00, 0x00, // f32 1.0 BE
                0x3f, 0xf0, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, // f64 1.0 BE
            ]
        );
    }

    #[test]
    fn signature_and_zeros() {
        let mut w = create_writer_default();
        write_signature(&mut w, "8BPS").expect("signature");
        write_zeros(&mut w, 3);
        assert_eq!(w.to_bytes(), vec![b'8', b'B', b'P', b'S', 0, 0, 0]);
    }

    #[test]
    fn pascal_string_padding() {
        // "ab" -> [len=2, 'a', 'b'] then pad: length becomes 3, 3%4!=0 -> write 0 (4),
        // 4%4==0 stop. Total bytes: 1 + 2 + 1 = 4.
        let mut w = create_writer_default();
        write_pascal_string(&mut w, "ab", 4).expect("pascal string");
        assert_eq!(w.to_bytes(), vec![2, b'a', b'b', 0]);
    }

    #[test]
    fn pascal_string_empty_pad2() {
        // "" -> [0], length 0 -> ++length=1, 1%2!=0 -> write 0 (2), 2%2==0 stop.
        let mut w = create_writer_default();
        write_pascal_string(&mut w, "", 2).expect("pascal string");
        assert_eq!(w.to_bytes(), vec![0, 0]);
    }

    #[test]
    fn pascal_string_rejects_zero_padding() {
        let mut w = create_writer_default();
        assert_eq!(
            write_pascal_string(&mut w, "x", 0),
            Err(WriteError::Internal(
                "Pascal string padding must be non-zero".into()
            ))
        );
    }

    #[test]
    fn pascal_string_non_ascii_becomes_question() {
        let mut w = create_writer_default();
        write_pascal_string(&mut w, "é", 1).expect("pascal string"); // 1 char, code > 127 -> '?'
        // len=1, '?'; ++length=2, 2%1==0 stop.
        assert_eq!(w.to_bytes(), vec![1, b'?']);
    }

    #[test]
    fn unicode_string_layout() {
        let mut w = create_writer_default();
        write_unicode_string(&mut w, "AB");
        assert_eq!(
            w.to_bytes(),
            vec![
                0x00, 0x00, 0x00, 0x02, // length = 2 (u32 BE)
                0x00, b'A', 0x00, b'B', // UTF-16 BE
            ]
        );
    }

    #[test]
    fn unicode_string_with_padding_layout() {
        let mut w = create_writer_default();
        write_unicode_string_with_padding(&mut w, "A");
        assert_eq!(
            w.to_bytes(),
            vec![
                0x00, 0x00, 0x00, 0x02, // length+1 = 2
                0x00, b'A', // UTF-16 BE
                0x00, 0x00, // terminating 0
            ]
        );
    }

    #[test]
    fn section_backpatch_and_rounding() {
        // round=4, body = 3 bytes -> length 3, padded to 4. writeTotalLength=false
        // so the patched length is the un-padded value (3).
        let mut w = create_writer_default();
        write_section(
            &mut w,
            4,
            |w| {
                write_uint8(w, 0xaa);
                write_uint8(w, 0xbb);
                write_uint8(w, 0xcc);
                Ok(())
            },
            false,
            false,
        )
        .expect("section");
        assert_eq!(
            w.to_bytes(),
            vec![
                0x00, 0x00, 0x00, 0x03, // length = 3 (un-padded, writeTotalLength=false)
                0xaa, 0xbb, 0xcc, // body
                0x00, // padding to round=4
            ]
        );
    }

    #[test]
    fn section_total_length() {
        // writeTotalLength=true -> patched length includes padding (4).
        let mut w = create_writer_default();
        write_section(
            &mut w,
            4,
            |w| {
                write_uint8(w, 0xaa);
                write_uint8(w, 0xbb);
                write_uint8(w, 0xcc);
                Ok(())
            },
            true,
            false,
        )
        .expect("section");
        assert_eq!(
            w.to_bytes(),
            vec![0x00, 0x00, 0x00, 0x04, 0xaa, 0xbb, 0xcc, 0x00]
        );
    }

    #[test]
    fn section_large() {
        // large=true -> leading extra u32(0), then the length word. body=1 byte, round=2.
        let mut w = create_writer_default();
        write_section(
            &mut w,
            2,
            |w| {
                write_uint8(w, 0x7f);
                Ok(())
            },
            false,
            true,
        )
        .expect("section");
        assert_eq!(
            w.to_bytes(),
            vec![
                0x00, 0x00, 0x00, 0x00, // large leading u32
                0x00, 0x00, 0x00, 0x01, // length = 1 (un-padded)
                0x7f, // body
                0x00, // padding to round=2
            ]
        );
    }

    #[test]
    fn buffer_growth_doubling() {
        // Start at size 4, write 10 bytes -> 4 -> 8 -> 16.
        let mut w = create_writer(4);
        for i in 0..10u8 {
            write_uint8(&mut w, i);
        }
        assert_eq!(w.offset, 10);
        assert_eq!(w.buffer.len(), 16);
        assert_eq!(w.to_bytes(), vec![0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    }

    #[test]
    fn write_bytes_grows_and_appends() {
        let mut w = create_writer(2);
        write_bytes(&mut w, Some(&[1, 2, 3, 4, 5]));
        write_bytes(&mut w, None);
        assert_eq!(w.to_bytes(), vec![1, 2, 3, 4, 5]);
    }

    #[test]
    fn color_none_is_rgb_zeros() {
        let mut w = create_writer_default();
        write_color(&mut w, None);
        assert_eq!(
            w.to_bytes(),
            vec![0x00, 0x00, 0, 0, 0, 0, 0, 0, 0, 0] // ColorSpace::Rgb (0) + 8 zeros
        );
    }

    #[test]
    fn color_rgb() {
        let mut w = create_writer_default();
        let c = Color::Rgb(Rgb {
            r: 255.0,
            g: 0.0,
            b: 128.0,
        });
        write_color(&mut w, Some(&c));
        // 255*257 = 65535 = 0xffff, 0, 128*257 = 32896 = 0x8080, then 0
        assert_eq!(
            w.to_bytes(),
            vec![
                0x00, 0x00, // ColorSpace::Rgb
                0xff, 0xff, // r
                0x00, 0x00, // g
                0x80, 0x80, // b
                0x00, 0x00, // pad
            ]
        );
    }

    #[test]
    fn color_cmyk_lab_hsb_grayscale_color_space_codes() {
        let mut w = create_writer_default();
        write_color(
            &mut w,
            Some(&Color::Cmyk(Cmyk {
                c: 0.0,
                m: 0.0,
                y: 0.0,
                k: 0.0,
            })),
        );
        write_color(
            &mut w,
            Some(&Color::Lab(Lab {
                l: 0.0,
                a: 0.0,
                b: 0.0,
            })),
        );
        write_color(
            &mut w,
            Some(&Color::Hsb(Hsb {
                h: 0.0,
                s: 0.0,
                b: 0.0,
            })),
        );
        write_color(&mut w, Some(&Color::Grayscale(Grayscale { k: 0.0 })));
        let buf = w.to_bytes();
        // First u16 of each block is the ColorSpace code.
        assert_eq!(&buf[0..2], &[0x00, 0x02]); // Cmyk = 2
        assert_eq!(&buf[10..12], &[0x00, 0x07]); // Lab = 7
        assert_eq!(&buf[20..22], &[0x00, 0x01]); // Hsb = 1
        assert_eq!(&buf[30..32], &[0x00, 0x08]); // Grayscale = 8
    }

    // -----------------------------------------------------------------------
    // Round-trip tests: read a real fixture -> write_psd -> read again,
    // assert structural equality (the bar for this task).
    // -----------------------------------------------------------------------

    use crate::psd::{BlendMode, Layer, Psd, ReadOptions};
    use crate::reader::read_psd;

    fn read_fixture(rel: &str) -> Option<Psd> {
        // Read with use_image_data so layers carry `image_data` (byte planes)
        // for pixel comparison, instead of the (cloned) canvas.
        let path = crate::test_corpus::corpus_root()
            .join("read")
            .join(rel)
            .join("src.psd");
        if !path.is_file() {
            eprintln!("fixture missing (set PSDX_FIXTURES_DIR), skipping: {}", rel);
            return None;
        }
        let bytes =
            std::fs::read(&path).unwrap_or_else(|e| panic!("read {}: {}", path.display(), e));
        let opts = ReadOptions {
            use_image_data: Some(true),
            ..Default::default()
        };
        Some(read_psd(&bytes, &opts).unwrap_or_else(|e| panic!("read_psd {}: {:?}", rel, e)))
    }

    fn count_layers(layers: &[Layer]) -> usize {
        layers
            .iter()
            .map(|l| 1 + l.children.as_ref().map_or(0, |c| count_layers(c)))
            .sum()
    }

    /// Flatten the tree depth-first into (name, top, left, bottom, right,
    /// opacity, blend_mode) tuples for structural comparison. Folders are
    /// included; group structure is preserved via recursion order.
    fn flatten(layers: &[Layer], out: &mut Vec<(String, i64, i64, i64, i64, u8, BlendMode)>) {
        for l in layers {
            out.push((
                l.additional_info.name.clone().unwrap_or_default(),
                l.top.unwrap_or(0.0) as i64,
                l.left.unwrap_or(0.0) as i64,
                l.bottom.unwrap_or(0.0) as i64,
                l.right.unwrap_or(0.0) as i64,
                (l.opacity.unwrap_or(1.0) * 255.0).round() as u8,
                l.blend_mode.unwrap_or(BlendMode::Normal),
            ));
            if let Some(children) = &l.children {
                flatten(children, out);
            }
        }
    }

    fn round_trip(psd: &Psd) -> Psd {
        let bytes = write_psd(psd, &WriteOptions::default()).expect("write_psd");
        let opts = ReadOptions {
            use_image_data: Some(true),
            ..Default::default()
        };
        read_psd(&bytes, &opts).expect("re-read written psd")
    }

    fn assert_structural_eq(a: &Psd, b: &Psd) {
        assert_eq!(a.width, b.width, "width");
        assert_eq!(a.height, b.height, "height");
        assert_eq!(a.color_mode, b.color_mode, "color_mode");

        let ca = a.children.as_deref().unwrap_or(&[]);
        let cb = b.children.as_deref().unwrap_or(&[]);
        assert_eq!(ca.len(), cb.len(), "top-level children count");
        assert_eq!(count_layers(ca), count_layers(cb), "total layer count");

        let mut fa = Vec::new();
        let mut fb = Vec::new();
        flatten(ca, &mut fa);
        flatten(cb, &mut fb);
        assert_eq!(fa, fb, "per-layer name/bounds/opacity/blendMode");
    }

    /// Total bytes of layer image data across the tree (for survival check).
    fn total_pixel_bytes(layers: &[Layer]) -> usize {
        layers
            .iter()
            .map(|l| {
                let own = l.image_data.as_ref().map_or(0, |d| d.data.len());
                own + l.children.as_ref().map_or(0, |c| total_pixel_bytes(c))
            })
            .sum()
    }

    #[test]
    fn round_trip_layers_fixture() {
        let Some(orig) = read_fixture("layers") else {
            return;
        };
        let again = round_trip(&orig);
        assert_structural_eq(&orig, &again);

        // Layer pixel data must survive the round trip.
        let ca = orig.children.as_deref().unwrap_or(&[]);
        let cb = again.children.as_deref().unwrap_or(&[]);
        assert!(
            total_pixel_bytes(ca) > 0,
            "fixture should have layer pixels"
        );
        assert_eq!(
            total_pixel_bytes(ca),
            total_pixel_bytes(cb),
            "layer pixel byte totals survive round trip"
        );
    }

    #[test]
    fn round_trip_groups_fixture() {
        let Some(orig) = read_fixture("groups") else {
            return;
        };
        let again = round_trip(&orig);
        assert_structural_eq(&orig, &again);

        let ca = orig.children.as_deref().unwrap_or(&[]);
        let cb = again.children.as_deref().unwrap_or(&[]);
        assert_eq!(
            total_pixel_bytes(ca),
            total_pixel_bytes(cb),
            "layer pixel byte totals survive round trip"
        );
    }

    #[test]
    fn round_trip_synthetic_two_solid_layers() {
        // Build a small Psd: 4x4 document, 2 solid-color layers each 4x4.
        fn solid(w: u32, h: u32, rgba: [u8; 4]) -> PixelData {
            let mut data = vec![0u8; (w * h * 4) as usize];
            for px in data.chunks_mut(4) {
                px.copy_from_slice(&rgba);
            }
            PixelData::rgba8(w, h, data)
        }

        let mut red = Layer::default();
        red.additional_info.name = Some("red".to_string());
        red.top = Some(0.0);
        red.left = Some(0.0);
        red.bottom = Some(4.0);
        red.right = Some(4.0);
        red.opacity = Some(1.0);
        red.blend_mode = Some(BlendMode::Normal);
        red.image_data = Some(solid(4, 4, [255, 0, 0, 255]));

        let mut blue = Layer::default();
        blue.additional_info.name = Some("blue".to_string());
        blue.top = Some(0.0);
        blue.left = Some(0.0);
        blue.bottom = Some(4.0);
        blue.right = Some(4.0);
        blue.opacity = Some(0.5);
        blue.blend_mode = Some(BlendMode::Multiply);
        blue.image_data = Some(solid(4, 4, [0, 0, 255, 200]));

        let psd = Psd {
            width: 4.0,
            height: 4.0,
            color_mode: Some(ColorMode::Rgb),
            bits_per_channel: Some(8.0),
            children: Some(vec![red, blue]),
            ..Default::default()
        };

        let again = round_trip(&psd);

        assert_eq!(again.width, 4.0);
        assert_eq!(again.height, 4.0);
        assert_eq!(again.color_mode, Some(ColorMode::Rgb));

        let children = again.children.as_ref().expect("children");
        assert_eq!(children.len(), 2, "two layers survive");

        let red_back = &children[0];
        assert_eq!(red_back.additional_info.name.as_deref(), Some("red"));
        assert_eq!(red_back.blend_mode, Some(BlendMode::Normal));
        assert_eq!(
            red_back.opacity.map(|o| (o * 255.0).round() as u8),
            Some(255)
        );
        assert_eq!(red_back.bottom, Some(4.0));
        assert_eq!(red_back.right, Some(4.0));
        // first pixel should be red, fully opaque
        let rd = red_back.image_data.as_ref().expect("red image data");
        assert_eq!(&rd.data[0..4], &[255, 0, 0, 255]);

        let blue_back = &children[1];
        assert_eq!(blue_back.additional_info.name.as_deref(), Some("blue"));
        assert_eq!(blue_back.blend_mode, Some(BlendMode::Multiply));
        assert_eq!(
            blue_back.opacity.map(|o| (o * 255.0).round() as u8),
            Some(128)
        );
        let bd = blue_back.image_data.as_ref().expect("blue image data");
        assert_eq!(&bd.data[0..4], &[0, 0, 255, 200]);
    }
}
