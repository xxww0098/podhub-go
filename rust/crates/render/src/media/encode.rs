use crate::media::error::{MediaError, MediaErrorCode, storage_error};
use jpeg_encoder::{Encoder, ImageBuffer, JpegColorType, SamplingFactor, rgb_to_ycbcr};
use sha2::{Digest, Sha256};
use std::cell::RefCell;
use std::io::{self, Write};
use std::rc::Rc;

pub(super) trait RgbaRows {
    fn width(&self) -> u32;
    fn height(&self) -> u32;
    fn read_rgba_row(&self, y: u32, output: &mut Vec<u8>) -> Result<(), MediaError>;
}

/// An in-memory RGBA buffer as encoder rows. Only the encoder's own tests
/// feed it a whole frame; production rows come from the slab a band at a time.
#[cfg(test)]
pub(super) struct RgbaSliceRows<'a> {
    rgba: &'a [u8],
    width: u32,
    height: u32,
    row_bytes: usize,
}

#[cfg(test)]
impl<'a> RgbaSliceRows<'a> {
    pub(super) fn try_new(rgba: &'a [u8], width: u32, height: u32) -> Result<Self, MediaError> {
        let row_bytes = usize::try_from(u64::from(width).saturating_mul(4)).map_err(|_| {
            MediaError::new(
                MediaErrorCode::DimensionLimit,
                "jpeg-rows",
                "row width does not fit the current platform",
            )
        })?;
        let required = row_bytes.checked_mul(height as usize).ok_or_else(|| {
            MediaError::new(
                MediaErrorCode::DimensionLimit,
                "jpeg-rows",
                "RGBA dimensions overflow the current platform",
            )
        })?;
        if rgba.len() != required {
            return Err(MediaError::new(
                MediaErrorCode::RequestInvalid,
                "jpeg-rows",
                format!("RGBA byte length {} != required {required}", rgba.len()),
            ));
        }
        Ok(Self {
            rgba,
            width,
            height,
            row_bytes,
        })
    }
}

#[cfg(test)]
impl RgbaRows for RgbaSliceRows<'_> {
    fn width(&self) -> u32 {
        self.width
    }

    fn height(&self) -> u32 {
        self.height
    }

    fn read_rgba_row(&self, y: u32, output: &mut Vec<u8>) -> Result<(), MediaError> {
        if y >= self.height {
            return Err(MediaError::new(
                MediaErrorCode::RequestInvalid,
                "jpeg-rows",
                "row index exceeds source height",
            ));
        }
        let start = y as usize * self.row_bytes;
        output.clear();
        output.extend_from_slice(&self.rgba[start..start + self.row_bytes]);
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct EncodedJpeg {
    pub bytes_written: u64,
    pub content_hash: String,
}

pub(super) fn encode_jpeg_rows_to_writer(
    source: &dyn RgbaRows,
    writer: &mut dyn Write,
    quality: u8,
    max_encoded_bytes: u64,
) -> Result<EncodedJpeg, MediaError> {
    let width = u16::try_from(source.width()).map_err(|_| {
        MediaError::new(
            MediaErrorCode::DimensionLimit,
            "jpeg-encode",
            "JPEG width exceeds 65,535 px",
        )
    })?;
    let height = u16::try_from(source.height()).map_err(|_| {
        MediaError::new(
            MediaErrorCode::DimensionLimit,
            "jpeg-encode",
            "JPEG height exceeds 65,535 px",
        )
    })?;
    let failure = Rc::new(RefCell::new(None));
    let image = StreamingImage {
        source,
        width,
        height,
        row: RefCell::new(Vec::new()),
        failure: Rc::clone(&failure),
    };
    let mut counting = CountingWriter {
        inner: writer,
        written: 0,
        limit: max_encoded_bytes,
        hasher: Sha256::new(),
        failure: Rc::clone(&failure),
    };
    // Optimized Huffman is sequential, non-interleaved Y/Cb/Cr SOS. It only
    // retables entropy coding. zune-jpeg does not support this bitstream, so
    // tests decode with jpeg-decoder rather than `image`.
    // Quality >= 90 stays 4:4:4 (the encoder default). Below 90 the product
    // contract is explicit 4:2:0 — jpeg-encoder would subsample on its own,
    // and pinning it keeps a library default change from silently returning
    // to 4:4:4. Progressive scans stay off: the static-slice cache contract
    // is this sequential SOS, not an interleaved or progressive bitstream.
    let mut encoder = Encoder::new(&mut counting, quality);
    encoder.set_optimized_huffman_tables(true);
    if quality < 90 {
        encoder.set_sampling_factor(SamplingFactor::R_4_2_0);
    }
    let encoded = encoder.encode_image(image);
    if let Some(error) = failure.borrow_mut().take() {
        return Err(error);
    }
    encoded.map_err(|error| {
        MediaError::new(
            MediaErrorCode::UnsupportedCapability,
            "jpeg-encode",
            error.to_string(),
        )
    })?;
    counting
        .flush()
        .map_err(|error| storage_error("jpeg-flush", error))?;
    let bytes_written = counting.written;
    let content_hash = format!("sha256:{:x}", counting.hasher.finalize());
    Ok(EncodedJpeg {
        bytes_written,
        content_hash,
    })
}

struct StreamingImage<'a> {
    source: &'a dyn RgbaRows,
    width: u16,
    height: u16,
    row: RefCell<Vec<u8>>,
    failure: Rc<RefCell<Option<MediaError>>>,
}

impl ImageBuffer for StreamingImage<'_> {
    fn get_jpeg_color_type(&self) -> JpegColorType {
        JpegColorType::Ycbcr
    }

    fn width(&self) -> u16 {
        self.width
    }

    fn height(&self) -> u16 {
        self.height
    }

    fn fill_buffers(&self, y: u16, buffers: &mut [Vec<u8>; 4]) {
        if self.failure.borrow().is_some() {
            return;
        }
        let mut row = self.row.borrow_mut();
        if let Err(error) = self.source.read_rgba_row(u32::from(y), &mut row) {
            *self.failure.borrow_mut() = Some(error);
            return;
        }
        for pixel in row.chunks_exact(4) {
            // Fully opaque pixels dominate photographic output; flattening is
            // exact passthrough there: (v * 255 + 127) / 255 == v for every
            // byte, so the general expression is skipped without changing one
            // output bit.
            let (luma, cb, cr) = if pixel[3] == 255 {
                rgb_to_ycbcr(pixel[0], pixel[1], pixel[2])
            } else {
                let alpha = u16::from(pixel[3]);
                let inverse = 255 - alpha;
                let flatten =
                    |value: u8| ((u16::from(value) * alpha + 255 * inverse + 127) / 255) as u8;
                rgb_to_ycbcr(flatten(pixel[0]), flatten(pixel[1]), flatten(pixel[2]))
            };
            buffers[0].push(luma);
            buffers[1].push(cb);
            buffers[2].push(cr);
        }
    }
}

struct CountingWriter<'a> {
    inner: &'a mut dyn Write,
    written: u64,
    limit: u64,
    hasher: Sha256,
    failure: Rc<RefCell<Option<MediaError>>>,
}

impl Write for CountingWriter<'_> {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        if self.failure.borrow().is_some() {
            return Err(io::Error::other("JPEG row source failed"));
        }
        let next = self
            .written
            .checked_add(bytes.len() as u64)
            .ok_or_else(|| {
                io::Error::new(io::ErrorKind::FileTooLarge, "encoded byte count overflow")
            })?;
        if next > self.limit {
            *self.failure.borrow_mut() = Some(MediaError::resource_limit(
                MediaErrorCode::EncodedLimit,
                "jpeg-write",
                u128::from(next),
                u128::from(self.limit),
                crate::psd::ProductResourcePolicy::default(),
            ));
            return Err(io::Error::new(
                io::ErrorKind::FileTooLarge,
                "encoded JPEG exceeds policy",
            ));
        }
        match self.inner.write(bytes) {
            Ok(0) if !bytes.is_empty() => {
                let error = io::Error::new(io::ErrorKind::WriteZero, "truncated JPEG write");
                *self.failure.borrow_mut() = Some(storage_error("jpeg-write", error));
                Err(io::Error::new(
                    io::ErrorKind::WriteZero,
                    "truncated JPEG write",
                ))
            }
            Ok(written) => {
                self.written += written as u64;
                self.hasher.update(&bytes[..written]);
                Ok(written)
            }
            Err(error) => {
                *self.failure.borrow_mut() = Some(storage_error(
                    "jpeg-write",
                    io::Error::new(error.kind(), error.to_string()),
                ));
                Err(error)
            }
        }
    }

    fn flush(&mut self) -> io::Result<()> {
        self.inner.flush()
    }
}

#[cfg(test)]
pub(super) fn encode_jpeg_flatten_white(
    rgba: &[u8],
    width: u32,
    height: u32,
    quality: u8,
) -> Result<Vec<u8>, MediaError> {
    let source = RgbaSliceRows::try_new(rgba, width, height)?;
    let mut output = Vec::new();
    encode_jpeg_rows_to_writer(&source, &mut output, quality, u64::MAX)?;
    Ok(output)
}

fn sha256_hex(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    format!("sha256:{digest:x}")
}

pub(super) fn content_hash(bytes: &[u8]) -> String {
    sha256_hex(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn decode_product_jpeg_rgb(jpeg: &[u8]) -> (u32, u32, Vec<u8>) {
        let mut decoder = jpeg_decoder::Decoder::new(jpeg);
        let pixels = decoder.decode().expect("decode sequential Huffman JPEG");
        let info = decoder.info().expect("jpeg info after decode");
        assert_eq!(
            info.pixel_format,
            jpeg_decoder::PixelFormat::RGB24,
            "product JPEGs are 8-bit YCbCr"
        );
        (u32::from(info.width), u32::from(info.height), pixels)
    }

    #[test]
    fn encoded_jpeg_round_trips_through_the_product_decoder() {
        let mut rgba = Vec::new();
        for _ in 0..(16 * 16) {
            rgba.extend_from_slice(&[220, 20, 180, 255]);
        }
        let encoded = encode_jpeg_flatten_white(&rgba, 16, 16, 90).expect("encode");
        let (width, height, rgb) = decode_product_jpeg_rgb(&encoded);
        assert_eq!((width, height), (16, 16));
        let i = (8 * width + 8) as usize * 3;
        let pixel = [rgb[i], rgb[i + 1], rgb[i + 2]];
        assert!(pixel[0] > 150, "red channel was lost: {pixel:?}");
        assert!(pixel[1] < 80, "green channel was corrupted: {pixel:?}");
        assert!(pixel[2] > 120, "blue channel was lost: {pixel:?}");
    }

    #[test]
    fn encoded_limit_rejects_during_write() {
        let rgba = vec![255_u8; 16 * 16 * 4];
        let source = RgbaSliceRows::try_new(&rgba, 16, 16).expect("source");
        let mut output = Vec::new();
        let error = encode_jpeg_rows_to_writer(&source, &mut output, 90, 8).unwrap_err();
        assert_eq!(error.code, MediaErrorCode::EncodedLimit);
        assert!(output.len() <= 8);
    }

    struct WriteZero;

    impl Write for WriteZero {
        fn write(&mut self, _bytes: &[u8]) -> io::Result<usize> {
            Ok(0)
        }

        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }

    #[test]
    fn truncated_writer_is_distinct() {
        let rgba = vec![255_u8; 16 * 16 * 4];
        let source = RgbaSliceRows::try_new(&rgba, 16, 16).expect("source");
        let error = encode_jpeg_rows_to_writer(&source, &mut WriteZero, 90, 1024).unwrap_err();
        assert_eq!(error.code, MediaErrorCode::StorageTruncated);
    }

    #[test]
    fn output_pipeline_has_no_unbounded_scratch_escape_hatch() {
        let encode = include_str!("encode.rs");
        let delivery = include_str!("delivery.rs");
        let forbidden = [
            ["mem", "map"].concat(),
            ["m", "map("].concat(),
            ["set_", "len("].concat(),
            ["spa", "rse"].concat(),
            ["raw-", "raster"].concat(),
        ];
        for forbidden in forbidden {
            assert!(!encode.contains(&forbidden), "encode contains {forbidden}");
            assert!(
                !delivery.contains(&forbidden),
                "delivery contains {forbidden}"
            );
        }
        assert!(encode.contains("trait RgbaRows"));
        assert!(encode.contains("CountingWriter"));
        assert!(delivery.contains("write_streamed_slice"));
    }
}
