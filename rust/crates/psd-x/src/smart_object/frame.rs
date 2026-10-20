/*
File: rust/crates/psd-x/src/smart_object/frame.rs

Purpose:
Pure placement-frame geometry for smart-object replace.
No document model — table-driven unit tests cover enlarge / shrink / aspect change.

Source compatibility:
- psdx-owned; no upstream ag-psd counterpart.
*/

use crate::smart_object::errors::SmartObjectError;
use crate::smart_object::types::FramePolicy;

/// Four corners in document pixel space: `[x0,y0, x1,y1, x2,y2, x3,y3]`
/// (first / second / opposite / fourth corner — typically TL, TR, BR, BL).
pub type FrameQuad = [f64; 8];

/// Fallible conversion from the variable-length `PlacedLayer.transform` list.
///
/// Malformed files can yield a length other than 8; never panic on that.
pub fn frame_quad_from_slice(values: &[f64]) -> Result<FrameQuad, SmartObjectError> {
    if values.len() != 8 {
        return Err(SmartObjectError::InvalidFrame {
            length: values.len(),
        });
    }
    let mut out = [0.0; 8];
    out.copy_from_slice(values);
    Ok(out)
}

/// Apply a frame policy to an existing quad when pixel size changes.
///
/// Vectors `e_x` / `e_y` span the frame from the first corner (rotation/shear safe).
/// The result is always an affine parallelogram (`p2 = p0 + e_x + e_y`).
///
/// Same-size identity for [`FramePolicy::KeepScale`] is exact (byte-level no-op
/// when the stored list is left untouched by the caller).
pub fn apply_frame_policy(
    current: &FrameQuad,
    old_size: (u32, u32),
    new_size: (u32, u32),
    policy: &FramePolicy,
) -> Result<FramePolicyResult, SmartObjectError> {
    if old_size.0 == 0 || old_size.1 == 0 || new_size.0 == 0 || new_size.1 == 0 {
        return Err(SmartObjectError::SizeUnknown);
    }

    let (ex, ey) = basis_from_quad(current);
    let (ow, oh) = (old_size.0 as f64, old_size.1 as f64);
    let (nw, nh) = (new_size.0 as f64, new_size.1 as f64);

    let (new_ex, new_ey, content_stretched) = match policy {
        FramePolicy::KeepScale => {
            let sx = nw / ow;
            let sy = nh / oh;
            ((ex.0 * sx, ex.1 * sx), (ey.0 * sy, ey.1 * sy), false)
        }
        FramePolicy::KeepFrame => {
            let stretched = aspect_changed(old_size, new_size);
            (ex, ey, stretched)
        }
        FramePolicy::FitInFrame => {
            // Uniform content scale relative to the original mapping: shrink the
            // KeepScale frame so both axes stay inside the original parallelogram.
            let t = (ow / nw).min(oh / nh);
            let sx = t * (nw / ow);
            let sy = t * (nh / oh);
            ((ex.0 * sx, ex.1 * sx), (ey.0 * sy, ey.1 * sy), false)
        }
        FramePolicy::Exact(corners) => {
            return Ok(FramePolicyResult {
                transform: *corners,
                content_stretched: false,
            });
        }
    };

    Ok(FramePolicyResult {
        transform: quad_from_basis(current, new_ex, new_ey),
        content_stretched,
    })
}

/// Outcome of [`apply_frame_policy`].
#[derive(Debug, Clone, PartialEq)]
pub struct FramePolicyResult {
    pub transform: FrameQuad,
    pub content_stretched: bool,
}

fn basis_from_quad(q: &FrameQuad) -> ((f64, f64), (f64, f64)) {
    let p0 = (q[0], q[1]);
    let p1 = (q[2], q[3]);
    let p3 = (q[6], q[7]);
    ((p1.0 - p0.0, p1.1 - p0.1), (p3.0 - p0.0, p3.1 - p0.1))
}

fn quad_from_basis(current: &FrameQuad, ex: (f64, f64), ey: (f64, f64)) -> FrameQuad {
    let x0 = current[0];
    let y0 = current[1];
    [
        x0,
        y0,
        x0 + ex.0,
        y0 + ex.1,
        x0 + ex.0 + ey.0,
        y0 + ex.1 + ey.1,
        x0 + ey.0,
        y0 + ey.1,
    ]
}

fn aspect_changed(old: (u32, u32), new: (u32, u32)) -> bool {
    (old.0 as u64) * (new.1 as u64) != (new.0 as u64) * (old.1 as u64)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::smart_object::types::FramePolicy;

    fn axis_aligned(w: f64, h: f64) -> FrameQuad {
        [0.0, 0.0, w, 0.0, w, h, 0.0, h]
    }

    fn approx_eq(a: &FrameQuad, b: &FrameQuad) {
        for (i, (x, y)) in a.iter().zip(b.iter()).enumerate() {
            assert!(
                (x - y).abs() < 1e-9,
                "index {i}: {x} != {y} (a={a:?} b={b:?})"
            );
        }
    }

    /// Table: (name, old, new, start, policy, expected_transform, stretched)
    fn cases() -> Vec<(
        &'static str,
        (u32, u32),
        (u32, u32),
        FrameQuad,
        FramePolicy,
        FrameQuad,
        bool,
    )> {
        let start = axis_aligned(100.0, 50.0);
        vec![
            // KeepScale — enlarge
            (
                "keep_scale_enlarge",
                (100, 50),
                (200, 100),
                start,
                FramePolicy::KeepScale,
                axis_aligned(200.0, 100.0),
                false,
            ),
            // KeepScale — shrink
            (
                "keep_scale_shrink",
                (100, 50),
                (50, 25),
                start,
                FramePolicy::KeepScale,
                axis_aligned(50.0, 25.0),
                false,
            ),
            // KeepScale — aspect change (independent axis scales)
            (
                "keep_scale_aspect",
                (100, 50),
                (200, 50),
                start,
                FramePolicy::KeepScale,
                axis_aligned(200.0, 50.0),
                false,
            ),
            // KeepFrame — enlarge (frame fixed; aspect same → no stretch warn)
            (
                "keep_frame_enlarge_same_aspect",
                (100, 50),
                (200, 100),
                start,
                FramePolicy::KeepFrame,
                start,
                false,
            ),
            // KeepFrame — shrink
            (
                "keep_frame_shrink_same_aspect",
                (100, 50),
                (50, 25),
                start,
                FramePolicy::KeepFrame,
                start,
                false,
            ),
            // KeepFrame — aspect change → stretched
            (
                "keep_frame_aspect_stretch",
                (100, 50),
                (100, 100),
                start,
                FramePolicy::KeepFrame,
                start,
                true,
            ),
            // FitInFrame — enlarge same aspect → fills original frame
            (
                "fit_enlarge_same_aspect",
                (100, 50),
                (200, 100),
                start,
                FramePolicy::FitInFrame,
                start,
                false,
            ),
            // FitInFrame — shrink same aspect → fills original frame
            (
                "fit_shrink_same_aspect",
                (100, 50),
                (50, 25),
                start,
                FramePolicy::FitInFrame,
                start,
                false,
            ),
            // FitInFrame — wider content → letterbox on height
            (
                "fit_wider_aspect",
                (100, 50),
                (200, 50),
                start,
                FramePolicy::FitInFrame,
                axis_aligned(100.0, 25.0),
                false,
            ),
            // FitInFrame — taller content → pillarbox on width
            (
                "fit_taller_aspect",
                (100, 50),
                (100, 100),
                start,
                FramePolicy::FitInFrame,
                axis_aligned(50.0, 50.0),
                false,
            ),
            // Exact — enlarge / shrink / aspect all just install corners
            (
                "exact_enlarge",
                (100, 50),
                (200, 100),
                start,
                FramePolicy::Exact([1.0, 2.0, 11.0, 2.0, 11.0, 12.0, 1.0, 12.0]),
                [1.0, 2.0, 11.0, 2.0, 11.0, 12.0, 1.0, 12.0],
                false,
            ),
            (
                "exact_shrink",
                (100, 50),
                (10, 5),
                start,
                FramePolicy::Exact([0.0, 0.0, 3.0, 0.0, 3.0, 4.0, 0.0, 4.0]),
                [0.0, 0.0, 3.0, 0.0, 3.0, 4.0, 0.0, 4.0],
                false,
            ),
            (
                "exact_aspect",
                (100, 50),
                (80, 20),
                start,
                FramePolicy::Exact([5.0, 5.0, 15.0, 5.0, 15.0, 25.0, 5.0, 25.0]),
                [5.0, 5.0, 15.0, 5.0, 15.0, 25.0, 5.0, 25.0],
                false,
            ),
        ]
    }

    #[test]
    fn table_driven_frame_policies() {
        for (name, old, new, start, policy, expected, stretched) in cases() {
            let got = apply_frame_policy(&start, old, new, &policy)
                .unwrap_or_else(|e| panic!("{name}: {e}"));
            approx_eq(&got.transform, &expected);
            assert_eq!(got.content_stretched, stretched, "{name} stretch flag");
        }
    }

    #[test]
    fn keep_scale_same_size_is_identity() {
        let q = axis_aligned(64.0, 32.0);
        let got = apply_frame_policy(&q, (64, 32), (64, 32), &FramePolicy::KeepScale).unwrap();
        assert_eq!(got.transform, q);
        assert!(!got.content_stretched);
    }

    #[test]
    fn keep_scale_preserves_rotation_basis() {
        // 90° CCW unit square mapped from 10×10 content: e_x=(0,10), e_y=(-10,0)
        let q: FrameQuad = [0.0, 0.0, 0.0, 10.0, -10.0, 10.0, -10.0, 0.0];
        let got = apply_frame_policy(&q, (10, 10), (20, 10), &FramePolicy::KeepScale).unwrap();
        // e_x *= 2, e_y *= 1
        approx_eq(
            &got.transform,
            &[0.0, 0.0, 0.0, 20.0, -10.0, 20.0, -10.0, 0.0],
        );
    }

    #[test]
    fn invalid_length_rejected() {
        assert!(matches!(
            frame_quad_from_slice(&[0.0; 7]),
            Err(SmartObjectError::InvalidFrame { length: 7 })
        ));
        assert!(matches!(
            frame_quad_from_slice(&[0.0; 9]),
            Err(SmartObjectError::InvalidFrame { length: 9 })
        ));
        assert!(frame_quad_from_slice(&[0.0; 8]).is_ok());
    }
}
