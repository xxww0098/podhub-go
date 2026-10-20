use crate::media::error::{MediaError, MediaErrorCode};
use crate::media::raster::PixelSource;
use crate::psd::{LayerNode, PlacedGeom};
use std::borrow::Cow;

pub(super) fn extract_geom(layer: &LayerNode) -> Option<PlacedGeom> {
    layer.placed.as_ref().map(|placed| placed.geom.clone())
}

pub(super) fn render_placed(
    source: &crate::psd::Bitmap,
    geom: &PlacedGeom,
    doc_w: u32,
    doc_h: u32,
    viewport_top: i64,
    viewport_bottom: i64,
) -> Result<Option<PixelSource<'static>>, MediaError> {
    psdx::placed::render_placed(source, geom, doc_w, doc_h, viewport_top, viewport_bottom)
        .map(|rendered| {
            rendered.map(|pixels| PixelSource {
                data: Cow::Owned(pixels.data),
                width: pixels.width,
                height: pixels.height,
                left: pixels.left,
                top: pixels.top,
            })
        })
        .map_err(map_error)
}

/// Bytes the rasterizer can allocate for this placed layer before it returns
/// its `PixelSource`. Used to reject an optional full-view cache before that
/// allocation happens.
pub(super) fn render_placed_peak_bytes(
    source: &crate::psd::Bitmap,
    geom: &PlacedGeom,
    doc_w: u32,
    doc_h: u32,
    viewport_top: i64,
    viewport_bottom: i64,
) -> Result<Option<u64>, MediaError> {
    psdx::placed::placed_render_footprint(source, geom, doc_w, doc_h, viewport_top, viewport_bottom)
        .map(|footprint| footprint.map(|footprint| footprint.peak_bytes))
        .map_err(map_error)
}

pub(crate) fn preflight_geometry(
    geom: &PlacedGeom,
    doc_w: u32,
    doc_h: u32,
) -> Result<(), MediaError> {
    psdx::placed::preflight_geometry(geom, doc_w, doc_h).map_err(map_error)
}

fn map_error(error: psdx::placed::PlacedRenderError) -> MediaError {
    let code = match error.kind {
        psdx::placed::PlacedRenderErrorKind::InvalidBitmap => MediaErrorCode::RequestInvalid,
        psdx::placed::PlacedRenderErrorKind::InvalidGeometry => {
            MediaErrorCode::UnsupportedCapability
        }
        psdx::placed::PlacedRenderErrorKind::ExtentLimit => MediaErrorCode::DimensionLimit,
    };
    MediaError::new(code, "warp", error.to_string())
}

pub(super) fn walk_placed_layers(
    layers: &[LayerNode],
    visit: &mut impl FnMut(&LayerNode) -> Result<(), MediaError>,
) -> Result<(), MediaError> {
    for layer in layers {
        if layer.placed.is_some() {
            visit(layer)?;
        }
        if !layer.children.is_empty() {
            walk_placed_layers(&layer.children, visit)?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    /// Placed-layer rasterization has exactly one implementation, and it is
    /// `psd-x`'s. A second mesh sampler here would drift from the parser's
    /// geometry silently, so both halves are asserted: this file calls only
    /// through the `psdx::placed` interface, and the manifest buys `placed`
    /// (geometry + warp) without `render` (which drags in a second compositor
    /// and a second set of codecs).
    #[test]
    fn placed_rasterization_stays_behind_the_psdx_interface() {
        let source = include_str!("warp.rs");
        assert!(source.contains("psdx::placed::render_placed"));
        assert!(source.contains("psdx::placed::placed_render_footprint"));
        assert!(source.contains("psdx::placed::preflight_geometry"));
        let psdx_dependency = include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/Cargo.toml"))
            .lines()
            .find(|line| line.starts_with("psdx = "))
            .expect("rust/crates/render/Cargo.toml declares psdx");
        assert!(psdx_dependency.contains("\"placed\""), "{psdx_dependency}");
        assert!(!psdx_dependency.contains("\"render\""), "{psdx_dependency}");
        assert!(!source.contains(&["struct Catmull", "RomSampler"].concat()));
        assert!(!source.contains(&["fn render_mesh", "_forward"].concat()));
        assert!(!source.contains(&["fn render_no", "_mesh"].concat()));
    }
}
