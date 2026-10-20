use super::*;
use crate::psd::{CustomEnvelopeWarp, PointF};

#[test]
fn placed_geometry_normalizes_absolute_mesh_domain_to_source_pixels() {
    let mut mesh_points = Vec::new();
    for row in 0..4 {
        for column in 0..4 {
            mesh_points.push(PointF {
                x: column as f64 * 1086.0 / 3.0,
                y: 5068.0 + row as f64 * 1448.0 / 3.0,
            });
        }
    }
    let placed = PlacedLayer {
        width: Some(1086.0),
        height: Some(1448.0),
        transform: vec![0.0, 0.0, 1086.0, 0.0, 1086.0, 1448.0, 0.0, 1448.0],
        warp: Some(Warp {
            custom_envelope_warp: Some(CustomEnvelopeWarp {
                quilt_slice_x: Some(vec![0.0, 1086.0]),
                quilt_slice_y: Some(vec![0.0, 6516.0]),
                mesh_points,
            }),
            ..Warp::default()
        }),
        ..PlacedLayer::default()
    };

    let geometry = PlacedGeom::from_placed(&placed);
    let mesh = geometry.mesh.expect("projected mesh");
    assert_eq!(mesh.slices_x, vec![0.0, 1086.0]);
    assert_eq!(mesh.slices_y, vec![0.0, 1448.0]);
}

#[test]
fn normalized_mesh_uses_the_full_replacement_height() {
    let mut mesh_points = Vec::new();
    for row in 0..4 {
        for column in 0..4 {
            mesh_points.push(PointF {
                x: column as f64 * 30.0 / 3.0,
                y: 100.0 + row as f64 * 40.0 / 3.0,
            });
        }
    }
    let placed = PlacedLayer {
        width: Some(30.0),
        height: Some(40.0),
        transform: vec![0.0, 0.0, 30.0, 0.0, 30.0, 40.0, 0.0, 40.0],
        warp: Some(Warp {
            custom_envelope_warp: Some(CustomEnvelopeWarp {
                quilt_slice_x: Some(vec![0.0, 30.0]),
                quilt_slice_y: Some(vec![0.0, 140.0]),
                mesh_points,
            }),
            ..Warp::default()
        }),
        ..PlacedLayer::default()
    };
    let mut data = Vec::with_capacity(30 * 40 * 4);
    for y in 0..40_u8 {
        for _ in 0..30 {
            data.extend_from_slice(&[y.saturating_mul(6), 0, 0, 255]);
        }
    }
    let rendered = render_placed(
        &Bitmap {
            data,
            width: 30,
            height: 40,
        },
        &PlacedGeom::from_placed(&placed),
        30,
        40,
        0,
        40,
    )
    .expect("render normalized identity mesh")
    .expect("identity mesh intersects canvas");
    let center_red = |y: u32| rendered.data[((y * rendered.width + 15) * 4) as usize];
    assert!(center_red(10) < center_red(20));
    assert!(center_red(20) < center_red(30));
    assert!(center_red(30) < center_red(39));
}

fn mesh_with_domain_larger_than_source() -> PlacedGeom {
    let mut xs = Vec::new();
    let mut ys = Vec::new();
    for row in 0..4 {
        for column in 0..4 {
            xs.push(column as f64 * 10.0 / 3.0);
            ys.push(row as f64 * 10.0 / 3.0);
        }
    }
    PlacedGeom {
        src_w: 1.0,
        src_h: 1.0,
        quad: vec![0.0, 0.0, 2.0, 0.0, 2.0, 2.0, 0.0, 2.0],
        mesh: Some(MeshGrid {
            cols: 4,
            rows: 4,
            xs,
            ys,
            slices_x: vec![0.0, 10.0],
            slices_y: vec![0.0, 10.0],
        }),
    }
}

#[test]
fn mesh_sampling_skips_coordinates_beyond_the_replacement_buffer() {
    let source = Bitmap {
        data: vec![255; 2 * 2 * 4],
        width: 2,
        height: 2,
    };
    let rendered = render_placed(&source, &mesh_with_domain_larger_than_source(), 2, 2, 0, 2)
        .expect("oversized mesh domain must not index beyond source pixels");
    assert!(rendered.is_some());
}

#[test]
fn malformed_replacement_bitmap_fails_instead_of_panicking() {
    let source = Bitmap {
        data: vec![255; 3],
        width: 2,
        height: 2,
    };
    let error = render_placed(&source, &mesh_with_domain_larger_than_source(), 2, 2, 0, 2)
        .expect_err("invalid RGBA buffer");
    assert_eq!(error.kind, PlacedRenderErrorKind::InvalidBitmap);
}

#[test]
fn transformed_intermediate_is_clipped_to_the_active_slab() {
    let source = Bitmap {
        data: vec![255; 8 * 8 * 4],
        width: 8,
        height: 8,
    };
    let mut geom = mesh_with_domain_larger_than_source();
    geom.src_w = 8.0;
    geom.src_h = 8.0;
    geom.quad = vec![0.0, 0.0, 16.0, 0.0, 16.0, 32.0, 0.0, 32.0];
    let rendered = render_placed(&source, &geom, 16, 32, 10, 13)
        .expect("bounded warp")
        .expect("pixels");
    assert_eq!(rendered.top, 10);
    assert_eq!(rendered.height, 3);
    assert_eq!(rendered.data.len(), 16 * 3 * 4);
}

#[test]
fn off_canvas_placed_layer_has_no_raster_footprint() {
    let source = Bitmap {
        data: vec![255; 4],
        width: 1,
        height: 1,
    };
    let geom = PlacedGeom {
        src_w: 1.0,
        src_h: 1.0,
        quad: vec![0.0, 20.0, 1.0, 20.0, 1.0, 21.0, 0.0, 21.0],
        mesh: None,
    };

    assert!(
        placed_render_footprint(&source, &geom, 16, 16, 0, 16)
            .expect("bounded footprint")
            .is_none()
    );
    assert!(
        render_placed(&source, &geom, 16, 16, 0, 16)
            .expect("bounded raster")
            .is_none()
    );
}

#[test]
fn non_finite_and_unbounded_transforms_fail_preflight() {
    let mut geom = mesh_with_domain_larger_than_source();
    geom.quad[0] = f64::NAN;
    assert_eq!(
        preflight_geometry(&geom, 16, 16).unwrap_err().kind,
        PlacedRenderErrorKind::InvalidGeometry
    );
    geom.quad = vec![0.0, 0.0, 1_000_000.0, 0.0, 1_000_000.0, 8.0, 0.0, 8.0];
    assert_eq!(
        preflight_geometry(&geom, 16, 16).unwrap_err().kind,
        PlacedRenderErrorKind::ExtentLimit
    );
}

#[test]
fn non_monotonic_mesh_slices_fail_preflight() {
    let mut geom = mesh_with_domain_larger_than_source();
    geom.mesh.as_mut().unwrap().slices_x = vec![10.0, 0.0];
    assert_eq!(
        preflight_geometry(&geom, 16, 16).unwrap_err().kind,
        PlacedRenderErrorKind::InvalidGeometry
    );
}
