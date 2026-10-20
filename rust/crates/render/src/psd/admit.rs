use crate::psd::error::{PsdError, PsdErrorCode};
use crate::psd::limits::Limits;

pub(super) type AdmitResult<T> = Result<T, PsdError>;

const RGB8_BITS_PER_CHANNEL: u16 = 8;
/// Photoshop header colour mode 3 (`psdx::psd::ColorMode::Rgb`).
const COLOR_MODE_RGB: u16 = 3;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) struct DocumentHeader {
    pub version: u16,
    pub channels: u16,
    pub width: u32,
    pub height: u32,
    pub bits_per_channel: u16,
    pub color_mode: u16,
}

pub(super) fn admit_bytes(bytes: &[u8], limits: Limits) -> AdmitResult<DocumentHeader> {
    admit_file_len(bytes.len() as u64, limits)?;
    if bytes.len() < 26 {
        return Err(PsdError::new(
            PsdErrorCode::CorruptDocument,
            "header-admission",
            format!("PSD header requires 26 bytes; received {}", bytes.len()),
        ));
    }
    admit_header(&bytes[..26], limits)
}

pub(super) fn admit_file_len(bytes: u64, limits: Limits) -> AdmitResult<()> {
    if bytes > limits.max_input_bytes {
        return Err(PsdError::resource_limit(
            PsdErrorCode::InputTooLarge,
            "file-size-admission",
            bytes,
            limits.max_input_bytes,
            limits.product_policy(),
        ));
    }
    Ok(())
}

fn admit_header(header: &[u8], limits: Limits) -> AdmitResult<DocumentHeader> {
    if &header[0..4] != b"8BPS" {
        return Err(PsdError::new(
            PsdErrorCode::CorruptDocument,
            "header-admission",
            "missing 8BPS signature",
        ));
    }

    let document = DocumentHeader {
        version: u16::from_be_bytes([header[4], header[5]]),
        channels: u16::from_be_bytes([header[12], header[13]]),
        height: u32::from_be_bytes([header[14], header[15], header[16], header[17]]),
        width: u32::from_be_bytes([header[18], header[19], header[20], header[21]]),
        bits_per_channel: u16::from_be_bytes([header[22], header[23]]),
        color_mode: u16::from_be_bytes([header[24], header[25]]),
    };

    if !matches!(document.version, 1 | 2) || document.channels == 0 || document.channels > 16 {
        return Err(PsdError::new(
            PsdErrorCode::UnsupportedDocument,
            "header-admission",
            format!(
                "version={}, channels={}",
                document.version, document.channels
            ),
        ));
    }
    // The compositor consumes RGBA8 only. A 1/16/32-bit document decodes
    // into native-endian multibyte samples that would be read as RGBA8.
    if document.bits_per_channel != RGB8_BITS_PER_CHANNEL {
        return Err(PsdError::new(
            PsdErrorCode::UnsupportedDepth,
            "header-admission",
            format!("bitsPerChannel={}", document.bits_per_channel),
        ));
    }
    // Product colour contract: RGB only. Gray/CMYK/Lab/… would otherwise be
    // projected through the RGB pipeline without conversion.
    if document.color_mode != COLOR_MODE_RGB {
        return Err(PsdError::new(
            PsdErrorCode::UnsupportedColorMode,
            "header-admission",
            format!("colorMode={}", document.color_mode),
        ));
    }

    let max_document_side = limits.document_side_limit(document.version);
    if document.width == 0
        || document.height == 0
        || document.width > max_document_side
        || document.height > max_document_side
    {
        return Err(PsdError::resource_limit(
            PsdErrorCode::DocumentDimensionsExceeded,
            "header-admission",
            document.width.max(document.height),
            max_document_side,
            limits.product_policy(),
        ));
    }

    let pixels = u64::from(document.width)
        .checked_mul(u64::from(document.height))
        .ok_or_else(|| {
            PsdError::new(
                PsdErrorCode::PixelCountExceeded,
                "header-admission",
                "pixel count overflowed",
            )
        })?;
    if pixels > limits.max_pixels {
        return Err(PsdError::resource_limit(
            PsdErrorCode::PixelCountExceeded,
            "header-admission",
            pixels,
            limits.max_pixels,
            limits.product_policy(),
        ));
    }

    Ok(document)
}
