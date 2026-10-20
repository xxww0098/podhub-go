use crate::media::blend;
use crate::media::error::{MediaError, MediaErrorCode};
use crate::media::model::RenderDocument;
use crate::psd::LayerNode;

/// Fail closed before compositing when the document uses an unsupported feature.
///
/// Silent degradation (for example mapping an unknown blend mode to normal) is a
/// Gate 8 test failure. Supported blend modes match the separable set below;
/// mesh warp is supported when geometry is well-formed.
pub(super) fn admit_render_capabilities(document: &RenderDocument) -> Result<(), MediaError> {
    preflight_render_capabilities(document).map(|_| ())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) struct CapabilityPlan {
    pub max_halo_rows: u32,
    pub accepted_layers: u32,
}

pub(super) fn preflight_render_capabilities(
    document: &RenderDocument,
) -> Result<CapabilityPlan, MediaError> {
    if document.width == 0 || document.height == 0 {
        return Err(MediaError::new(
            MediaErrorCode::UnsupportedCapability,
            "capability-check",
            "empty document",
        ));
    }
    let mut plan = CapabilityPlan {
        max_halo_rows: 0,
        accepted_layers: 0,
    };
    walk_layers(&document.children, &mut |layer| {
        let halo = admit_layer(layer, document.width, document.height)?;
        plan.max_halo_rows = plan.max_halo_rows.max(halo);
        plan.accepted_layers = plan.accepted_layers.checked_add(1).ok_or_else(|| {
            MediaError::new(
                MediaErrorCode::UnsupportedCapability,
                "capability-check",
                "capability node count overflow",
            )
        })?;
        Ok(())
    })?;
    Ok(plan)
}

fn admit_layer(
    layer: &LayerNode,
    document_width: u32,
    document_height: u32,
) -> Result<u32, MediaError> {
    let mode = normalize_blend_mode(&layer.blend_mode);
    if !blend::is_supported(mode) {
        return Err(MediaError::new(
            MediaErrorCode::UnsupportedCapability,
            "capability-check",
            format!("unsupported blend mode \"{}\"", layer.blend_mode),
        ));
    }
    if let Some(placed) = &layer.placed {
        crate::media::warp::preflight_geometry(&placed.geom, document_width, document_height)?;
    }
    // Every currently accepted primitive is local to the sampled output row.
    // The slab resampler itself declares its one-row halo separately.
    Ok(0)
}

fn normalize_blend_mode(mode: &str) -> &str {
    if mode == "pass through" {
        "normal"
    } else {
        mode
    }
}

fn walk_layers(
    layers: &[LayerNode],
    visit: &mut impl FnMut(&LayerNode) -> Result<(), MediaError>,
) -> Result<(), MediaError> {
    for layer in layers {
        visit(layer)?;
        walk_layers(&layer.children, visit)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::psd::render::PlacedLayerInfo;
    use crate::psd::{LayerNode, PlacedGeom, RenderDocument};
    use psdx::placed::MeshGrid;

    fn base_layer(name: &str, blend_mode: &str) -> LayerNode {
        LayerNode {
            name: name.to_owned(),
            left: 0,
            top: 0,
            right: 8,
            bottom: 8,
            blend_mode: blend_mode.to_owned(),
            opacity: 1.0,
            fill_opacity: 1.0,
            hidden: false,
            clipping: false,
            mask: None,
            placed: None,
            image_data: None,
            children: Vec::new(),
        }
    }

    #[test]
    fn unsupported_blend_fails_closed() {
        let document = RenderDocument {
            width: 8,
            height: 8,
            children: vec![base_layer("layer", "color dodge")],
            linked_files: Vec::new(),
        };
        let error = admit_render_capabilities(&document).unwrap_err();
        assert_eq!(error.code, MediaErrorCode::UnsupportedCapability);
        assert!(error.detail.contains("color dodge"));
    }

    #[test]
    fn malformed_mesh_fails_closed() {
        let mut layer = base_layer("warped", "normal");
        layer.placed = Some(PlacedLayerInfo {
            id: "slot".to_owned(),
            width: 8.0,
            height: 8.0,
            geom: PlacedGeom {
                src_w: 8.0,
                src_h: 8.0,
                quad: vec![0.0, 0.0, 8.0, 0.0, 8.0, 8.0, 0.0, 8.0],
                mesh: Some(MeshGrid {
                    cols: 2,
                    rows: 2,
                    xs: vec![0.0, 8.0, 0.0, 8.0],
                    ys: vec![0.0, 0.0, 8.0, 8.0],
                    slices_x: vec![0.0, 8.0],
                    slices_y: vec![0.0, 8.0],
                }),
            },
        });
        let document = RenderDocument {
            width: 16,
            height: 16,
            children: vec![layer],
            linked_files: Vec::new(),
        };
        let error = admit_render_capabilities(&document).unwrap_err();
        assert_eq!(error.code, MediaErrorCode::UnsupportedCapability);
    }
}
