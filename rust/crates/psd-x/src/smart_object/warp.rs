/*
File: rust/crates/psd-x/src/smart_object/warp.rs

Purpose:
Warp mesh identity detection and replace-time mutability checks.
Identity is mesh geometry vs a regular grid — never `Warp.style`.

Source compatibility:
- psdx-owned; no upstream ag-psd counterpart.
*/

use crate::psd::{PointF, Warp};
use crate::smart_object::errors::SmartObjectError;

/// Absolute tolerance when comparing mesh control points to the reference grid.
const MESH_EPS: f64 = 1e-4;

/// Modern Photoshop warp-bounds descriptor class (document-space capable).
pub const BOUNDS_CLASS_FLOAT_RECT: &str = "classFloatRect";

/// Whether `warp`'s custom envelope is an identity mesh for a linked image of
/// `width` × `height` pixels.
///
/// - Standard 4×4 envelopes: control points must match the regular third-grid
///   (`0, w/3, 2w/3, w` × `0, h/3, 2h/3, h`), matching the writer synthesis in
///   `get_warp_from_placed_layer`.
/// - Quilt envelopes (`deform_num_rows` / `deform_num_cols`): points must match
///   the regular `(cols)×(rows)` grid over the same rectangle.
///
/// **Does not read [`Warp::style`]** — corpus custom-styled warps are often
/// identity meshes; style is not a reliable signal.
///
/// Missing / empty mesh → not identity (preset warps such as cylinder carry no
/// envelope; they are treated as real deformations for replace policy).
pub fn is_identity_warp_mesh(warp: &Warp, width: f64, height: f64) -> bool {
    if !(width > 0.0 && height > 0.0) {
        return false;
    }
    let Some(cew) = warp.custom_envelope_warp.as_ref() else {
        return false;
    };
    let pts = &cew.mesh_points;
    if pts.is_empty() {
        return false;
    }

    match (
        warp.deform_num_rows.map(|v| v.round() as usize),
        warp.deform_num_cols.map(|v| v.round() as usize),
    ) {
        (Some(rows), Some(cols)) if rows >= 2 && cols >= 2 => {
            if pts.len() != rows * cols {
                return false;
            }
            points_match_regular_grid(pts, cols, rows, width, height)
        }
        _ => {
            if pts.len() != 16 {
                return false;
            }
            // 4×4 third-grid (uOrder/vOrder = 4 in corpus identity samples).
            points_match_regular_grid(pts, 4, 4, width, height)
        }
    }
}

/// Reference control points for an identity 4×4 third-grid mesh.
pub fn identity_third_grid_points(width: f64, height: f64) -> Vec<PointF> {
    regular_grid_points(4, 4, width, height)
}

fn regular_grid_points(cols: usize, rows: usize, width: f64, height: f64) -> Vec<PointF> {
    let mut out = Vec::with_capacity(cols * rows);
    for r in 0..rows {
        let y = height * (r as f64) / ((rows - 1) as f64);
        for c in 0..cols {
            let x = width * (c as f64) / ((cols - 1) as f64);
            out.push(PointF { x, y });
        }
    }
    out
}

fn points_match_regular_grid(
    pts: &[PointF],
    cols: usize,
    rows: usize,
    width: f64,
    height: f64,
) -> bool {
    let expect = regular_grid_points(cols, rows, width, height);
    pts.iter()
        .zip(expect.iter())
        .all(|(a, b)| (a.x - b.x).abs() <= MESH_EPS && (a.y - b.y).abs() <= MESH_EPS)
}

/// `true` when warp bounds were encoded with modern `classFloatRect`.
pub fn warp_bounds_is_float_rect(warp: &Warp) -> bool {
    warp.bounds_class_id.as_deref() == Some(BOUNDS_CLASS_FLOAT_RECT)
}

/// Refuse mutating a warp that v1 must treat as read-only.
///
/// - `classFloatRect` bounds → always refuse (coordinate space not modelled).
/// - Unknown bounds class + non-identity mesh → refuse (cannot prove the warp
///   is safe to clear / that bounds are linked-image space).
///
/// Identity meshes with unknown class are allowed (clearing them only loses a
/// no-op envelope). Encode still selects bounds class via quilt vs `Rctn` and
/// does not round-trip `bounds_class_id` (existing degradation).
pub fn ensure_warp_mutable(warp: &Warp, width: f64, height: f64) -> Result<(), SmartObjectError> {
    if warp_bounds_is_float_rect(warp) {
        return Err(SmartObjectError::WarpFloatRectReadOnly);
    }
    if warp.bounds_class_id.is_none() && !is_identity_warp_mesh(warp, width, height) {
        return Err(SmartObjectError::WarpBoundsClassUnknown);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::psd::{CustomEnvelopeWarp, WarpStyle};

    fn warp_with_mesh(pts: Vec<PointF>) -> Warp {
        Warp {
            // Deliberately set a misleading style — predicate must ignore it.
            style: Some(WarpStyle::Custom),
            custom_envelope_warp: Some(CustomEnvelopeWarp {
                mesh_points: pts,
                quilt_slice_x: None,
                quilt_slice_y: None,
            }),
            u_order: Some(4.0),
            v_order: Some(4.0),
            ..Warp::default()
        }
    }

    #[test]
    fn identity_third_grid_matches_corpus_smart_and_shapes() {
        // smart[0]: 500×511; shapes[5]: 480×360 — both custom-styled identity.
        for (w, h) in [
            (500.0, 511.0),
            (480.0, 360.0),
            (100.0, 111.0),
            (525.0, 613.0),
        ] {
            let warp = warp_with_mesh(identity_third_grid_points(w, h));
            assert!(
                is_identity_warp_mesh(&warp, w, h),
                "expected identity for {w}x{h}"
            );
        }
    }

    #[test]
    fn identity_predicate_ignores_style_field() {
        let w = 90.0;
        let h = 60.0;
        let mut warp = warp_with_mesh(identity_third_grid_points(w, h));
        warp.style = Some(WarpStyle::Arc); // must not matter
        assert!(is_identity_warp_mesh(&warp, w, h));
        warp.style = Some(WarpStyle::None);
        assert!(is_identity_warp_mesh(&warp, w, h));
    }

    #[test]
    fn deformed_4x4_is_not_identity() {
        let w = 300.0;
        let h = 300.0;
        let mut pts = identity_third_grid_points(w, h);
        pts[5].x += 12.0; // interior control point
        let warp = warp_with_mesh(pts);
        assert!(!is_identity_warp_mesh(&warp, w, h));
    }

    #[test]
    fn werps_style_quilt_deformed_is_not_identity() {
        // Corpus werps[1]: 13×13 quilt, custom style, first rows pulled off-grid.
        let w = 999.0;
        let h = 999.0;
        let mut pts = regular_grid_points(13, 13, w, h);
        pts[2] = PointF {
            x: 178.523582,
            y: -167.617382,
        };
        let warp = Warp {
            style: Some(WarpStyle::Custom),
            deform_num_rows: Some(13.0),
            deform_num_cols: Some(13.0),
            custom_envelope_warp: Some(CustomEnvelopeWarp {
                mesh_points: pts,
                quilt_slice_x: None,
                quilt_slice_y: None,
            }),
            u_order: Some(4.0),
            v_order: Some(4.0),
            ..Warp::default()
        };
        assert!(!is_identity_warp_mesh(&warp, w, h));
    }

    #[test]
    fn quilt_regular_grid_is_identity_without_reading_style() {
        let w = 999.0;
        let h = 999.0;
        let warp = Warp {
            style: Some(WarpStyle::Custom),
            deform_num_rows: Some(13.0),
            deform_num_cols: Some(13.0),
            custom_envelope_warp: Some(CustomEnvelopeWarp {
                mesh_points: regular_grid_points(13, 13, w, h),
                quilt_slice_x: None,
                quilt_slice_y: None,
            }),
            ..Warp::default()
        };
        assert!(is_identity_warp_mesh(&warp, w, h));
    }

    #[test]
    fn missing_mesh_is_not_identity() {
        let warp = Warp {
            style: Some(WarpStyle::Cylinder),
            ..Warp::default()
        };
        assert!(!is_identity_warp_mesh(&warp, 272.0, 420.0));
    }

    #[test]
    fn float_rect_and_unknown_class_gates() {
        let w = 100.0;
        let h = 100.0;
        let mut identity = warp_with_mesh(identity_third_grid_points(w, h));
        identity.bounds_class_id = Some(BOUNDS_CLASS_FLOAT_RECT.into());
        assert!(matches!(
            ensure_warp_mutable(&identity, w, h),
            Err(SmartObjectError::WarpFloatRectReadOnly)
        ));

        let mut deformed = warp_with_mesh(identity_third_grid_points(w, h));
        deformed.custom_envelope_warp.as_mut().unwrap().mesh_points[1].y += 5.0;
        deformed.bounds_class_id = None;
        assert!(matches!(
            ensure_warp_mutable(&deformed, w, h),
            Err(SmartObjectError::WarpBoundsClassUnknown)
        ));

        let mut ok = warp_with_mesh(identity_third_grid_points(w, h));
        ok.bounds_class_id = Some("Rctn".into());
        assert!(ensure_warp_mutable(&ok, w, h).is_ok());
    }
}
