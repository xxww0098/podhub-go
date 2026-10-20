//! Thumbnail image resource (id 1036).

use crate::helpers::create_canvas_from_data;
use crate::psd::{ImageResources, ThumbnailRaw};
use crate::reader::{PsdReader, ReadResult, read_bytes, read_uint16, read_uint32, skip_bytes};
use crate::thumbnail::encode_thumbnail_jpeg;
use crate::writer::{PsdWriter, write_bytes, write_uint16, write_uint32};

pub(crate) fn read_thumbnail(
    reader: &mut PsdReader,
    target: &mut ImageResources,
    left: usize,
) -> ReadResult<()> {
    let start = reader.offset;
    let format = read_uint32(reader)?; // 1 = kJpegRGB, 0 = kRawRGB
    let width = read_uint32(reader)? as f64;
    let height = read_uint32(reader)? as f64;
    let _width_bytes = read_uint32(reader)?;
    let _total_size = read_uint32(reader)?;
    let _size_after_compression = read_uint32(reader)?;
    let bits_per_pixel = read_uint16(reader)?; // 24
    let planes = read_uint16(reader)?; // 1

    let consumed = reader.offset - start;
    let remaining = left.saturating_sub(consumed);

    if format != 1 || bits_per_pixel != 24 || planes != 1 {
        skip_bytes(reader, remaining);
        return Ok(());
    }

    let data = read_bytes(reader, remaining)?;

    // Hard constraint: without `thumbnail` feature, always raw passthrough.
    let use_raw = reader.options.use_raw_thumbnail == Some(true) || !cfg!(feature = "thumbnail");

    if use_raw {
        target.thumbnail_raw = Some(ThumbnailRaw {
            width,
            height,
            data,
        });
    } else if !data.is_empty() {
        target.thumbnail = Some(create_canvas_from_data(&data));
    }
    Ok(())
}

pub(crate) fn write_thumbnail(writer: &mut PsdWriter, target: &ImageResources) {
    let mut width = 0.0;
    let mut height = 0.0;
    let mut data: Vec<u8> = Vec::new();

    if let Some(raw) = &target.thumbnail_raw {
        width = raw.width;
        height = raw.height;
        data = raw.data.clone();
    } else if let Some(pixels) = &target.thumbnail {
        if let Some(encoded) = encode_thumbnail_jpeg(pixels) {
            data = encoded;
            width = pixels.width as f64;
            height = pixels.height as f64;
        }
    }

    let bits_per_pixel = 24.0_f64;
    let width_bytes = ((width * bits_per_pixel + 31.0) / 32.0).floor() * 4.0;
    let planes = 1.0_f64;
    let total_size = width_bytes * height * planes;
    let size_after_compression = data.len() as f64;

    write_uint32(writer, 1); // 1 = kJpegRGB
    write_uint32(writer, width as u32);
    write_uint32(writer, height as u32);
    write_uint32(writer, width_bytes as u32);
    write_uint32(writer, total_size as u32);
    write_uint32(writer, size_after_compression as u32);
    write_uint16(writer, bits_per_pixel as u16);
    write_uint16(writer, planes as u16);
    write_bytes(writer, Some(&data));
}

// ===========================================================================
