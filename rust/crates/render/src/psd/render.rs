use crate::psd::error::{PsdError, PsdErrorCode};
use crate::psd::limits::Limits;
use psdx::psd::{BlendMode, Layer, LayerMaskData, LinkedFile, Psd, ReadOptions};

pub(crate) use model::*;

mod model {
    pub(crate) use psdx::placed::{Bitmap, PlacedGeom};

    /// A decoded replacement or linked raster has the same owned RGBA shape
    /// as a placed bitmap. Keeping one type lets group compositing borrow those
    /// bytes all the way into `psd-x` instead of cloning each smart object.
    pub(crate) type SourceContent = Bitmap;

    #[derive(Debug, Clone)]
    pub(crate) struct LayerMask {
        pub left: i64,
        pub top: i64,
        pub right: i64,
        pub bottom: i64,
        pub default_color: u8,
        pub disabled: bool,
        pub image_data: Option<Bitmap>,
    }

    #[derive(Debug, Clone)]
    pub(crate) struct PlacedLayerInfo {
        pub id: String,
        pub width: f64,
        pub height: f64,
        pub geom: PlacedGeom,
    }

    #[derive(Debug, Clone)]
    pub(crate) struct LayerNode {
        pub name: String,
        pub left: i64,
        pub top: i64,
        pub right: i64,
        pub bottom: i64,
        pub blend_mode: String,
        pub opacity: f64,
        pub fill_opacity: f64,
        pub hidden: bool,
        pub clipping: bool,
        pub mask: Option<LayerMask>,
        pub placed: Option<PlacedLayerInfo>,
        pub image_data: Option<Bitmap>,
        pub children: Vec<LayerNode>,
    }

    impl LayerNode {
        pub(crate) fn is_group(&self) -> bool {
            !self.children.is_empty()
        }
    }

    #[derive(Debug, Clone)]
    pub(crate) struct LinkedFileData {
        pub id: String,
        pub name: String,
        pub bytes: Vec<u8>,
    }

    #[derive(Debug, Clone)]
    pub(crate) struct RenderDocument {
        pub width: u32,
        pub height: u32,
        pub children: Vec<LayerNode>,
        pub linked_files: Vec<LinkedFileData>,
    }
}

pub(crate) fn load_render_document(
    bytes: &[u8],
    limits: Limits,
) -> Result<RenderDocument, PsdError> {
    crate::psd::admit::admit_bytes(bytes, limits)?;
    let options = render_read_options(limits);
    // A panic inside a `wasm32-unknown-unknown` module traps; the worker
    // re-instantiates the module instead (rust/crates/render-wasm/src/lib.rs).
    let parsed = psdx::read_psd(bytes, &options);
    let document = parsed.map_err(crate::psd::map_read_error)?;
    admit_layer_tree(&document)?;
    convert_document(document)
}

/// Every layer section has parsed; a document without a single layer carries
/// only its merged image. That image is skipped here by design (it is not an
/// editable template), so rendering would silently produce a transparent
/// canvas — reject instead.
fn admit_layer_tree(document: &Psd) -> Result<(), PsdError> {
    if document
        .children
        .as_ref()
        .is_none_or(|children| children.is_empty())
    {
        return Err(PsdError::new(
            PsdErrorCode::CompositeOnly,
            "layer-admission",
            "document has no layer records; only the merged image is present",
        ));
    }
    Ok(())
}

fn render_read_options(limits: Limits) -> ReadOptions {
    ReadOptions {
        skip_layer_image_data: Some(false),
        skip_composite_image_data: Some(true),
        skip_thumbnail: Some(true),
        skip_linked_files_data: Some(false),
        // Match structural inspection: optional Photoshop metadata which is
        // not consumed by the compositor is skipped, while all resource and
        // document admission limits remain enforced.
        throw_for_missing_features: Some(false),
        use_image_data: Some(true),
        strict: Some(false),
        // Layer channels are consumed by the compositor, so an undecodable ZIP
        // plane must fail the document instead of rendering an opaque black
        // layer that looks like a valid template.
        corrupt_channel_is_fatal: Some(true),
        total_memory_limit: Some(limits.max_decode_memory_bytes),
        max_metadata_bytes: Some(limits.max_metadata_bytes),
        max_psd_side: Some(limits.max_psd_side),
        max_psb_side: Some(limits.max_psb_side),
        max_canvas_pixels: Some(limits.max_pixels),
        max_layer_records: Some(limits.max_layer_records),
        max_layer_depth: Some(limits.max_recursion_depth),
        max_recursion_depth: Some(limits.max_recursion_depth),
        max_embedded_document_depth: Some(limits.max_embedded_document_depth),
        ..ReadOptions::default()
    }
}

/// Projects the parser's model onto the renderer's, **consuming** it.
///
/// Every decoded pixel buffer is moved, not copied. Taking `&Psd` here made
/// both models hold a full set of decoded pixels for the duration of the
/// conversion — a doubling that ran *before* slab admission and so was priced
/// by nothing: the parser ledger only saw its own copy, `document_resident_bytes`
/// only ever saw the other. Consuming the source keeps the peak at one copy.
fn convert_document(mut document: Psd) -> Result<RenderDocument, PsdError> {
    let width = document.width.round() as u32;
    let height = document.height.round() as u32;
    if width == 0 || height == 0 {
        return Err(PsdError::new(
            PsdErrorCode::UnsupportedDocument,
            "document-conversion",
            "document dimensions are invalid",
        ));
    }
    Ok(RenderDocument {
        width,
        height,
        children: document
            .children
            .take()
            .unwrap_or_default()
            .into_iter()
            .map(convert_layer)
            .collect::<Result<_, _>>()?,
        linked_files: document
            .linked_files
            .take()
            .unwrap_or_default()
            .into_iter()
            .map(convert_linked_file)
            .collect(),
    })
}

fn convert_linked_file(file: LinkedFile) -> LinkedFileData {
    LinkedFileData {
        id: file.id,
        name: file.name,
        bytes: file.data.unwrap_or_default(),
    }
}

fn convert_layer(mut layer: Layer) -> Result<LayerNode, PsdError> {
    let unsupported = if layer.additional_info.adjustment.is_some() {
        Some("unsupported adjustment layer")
    } else if layer.additional_info.filter_mask.is_some()
        || layer
            .additional_info
            .filter_effects_masks
            .as_ref()
            .is_some_and(|filters| !filters.is_empty())
    {
        Some("unsupported global filter operation")
    } else {
        None
    };
    Ok(LayerNode {
        name: layer.additional_info.name.take().unwrap_or_default(),
        left: layer.left.map(round_i64).unwrap_or_default(),
        top: layer.top.map(round_i64).unwrap_or_default(),
        right: layer.right.map(round_i64).unwrap_or_default(),
        bottom: layer.bottom.map(round_i64).unwrap_or_default(),
        blend_mode: unsupported.map(str::to_owned).unwrap_or_else(|| {
            layer
                .blend_mode
                .map(blend_mode_name)
                .unwrap_or_else(|| "normal".to_owned())
        }),
        opacity: layer.opacity.unwrap_or(1.0),
        fill_opacity: layer.additional_info.fill_opacity.unwrap_or(1.0),
        hidden: layer.hidden.unwrap_or(false),
        clipping: layer.clipping.unwrap_or(false),
        mask: layer
            .additional_info
            .mask
            .take()
            .map(convert_mask)
            .transpose()?,
        placed: layer
            .additional_info
            .placed_layer
            .as_ref()
            .map(convert_placed),
        image_data: layer
            .image_data
            .take()
            .map(convert_pixel_data)
            .transpose()?,
        children: layer
            .children
            .take()
            .unwrap_or_default()
            .into_iter()
            .map(convert_layer)
            .collect::<Result<_, _>>()?,
    })
}

fn convert_mask(mut mask: LayerMaskData) -> Result<LayerMask, PsdError> {
    Ok(LayerMask {
        left: mask.left.map(round_i64).unwrap_or_default(),
        top: mask.top.map(round_i64).unwrap_or_default(),
        right: mask.right.map(round_i64).unwrap_or_default(),
        bottom: mask.bottom.map(round_i64).unwrap_or_default(),
        default_color: mask.default_color.unwrap_or(0.0).round() as u8,
        disabled: mask.disabled.unwrap_or(false),
        image_data: mask.image_data.take().map(convert_pixel_data).transpose()?,
    })
}

/// Admitted documents are RGBA8, so every projected buffer must be exactly
/// `width * height * 4` bytes. Anything else is never reinterpreted: the
/// compositor indexes these buffers directly.
fn convert_pixel_data(pixel: psdx::psd::PixelData) -> Result<Bitmap, PsdError> {
    let expected = u64::from(pixel.width)
        .checked_mul(u64::from(pixel.height))
        .and_then(|pixels| pixels.checked_mul(4));
    if expected != Some(pixel.data.len() as u64) {
        return Err(PsdError::new(
            PsdErrorCode::CorruptDocument,
            "pixel-projection",
            format!(
                "{}x{} pixel buffer holds {} bytes; RGBA8 requires {}",
                pixel.width,
                pixel.height,
                pixel.data.len(),
                expected.map_or_else(|| "an overflowing size".to_owned(), |n| n.to_string()),
            ),
        ));
    }
    Ok(Bitmap {
        width: pixel.width,
        height: pixel.height,
        data: pixel.data,
    })
}

fn convert_placed(placed: &psdx::psd::PlacedLayer) -> PlacedLayerInfo {
    let src_w = placed.width.unwrap_or_default();
    let src_h = placed.height.unwrap_or_default();
    PlacedLayerInfo {
        id: placed.id.clone(),
        width: src_w,
        height: src_h,
        geom: PlacedGeom::from_placed(placed),
    }
}

fn blend_mode_name(mode: BlendMode) -> String {
    mode.as_json_str().to_owned()
}

fn round_i64(value: f64) -> i64 {
    value.round() as i64
}
