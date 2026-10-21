use super::*;

fn window(rect: Rect, width: u32, height: u32) -> WindowRgbaRows {
    let bytes = (0..17 * 7 * 4)
        .map(|i| ((i * 37 + i / 4 * 11) % 256) as u8)
        .collect();
    WindowRgbaRows {
        window: Arc::new(bytes),
        doc_width: 17,
        group_top: 2,
        group_bottom: 9,
        export_rect: rect,
        output_width: width,
        output_height: height,
        cancellation: None,
    }
}

// The pre-optimization copy-and-resample algorithm, deliberately independent
// of resample_output_row. Keep its arithmetic order and rounding as the oracle.
fn copied_reference(rows: &WindowRgbaRows, y: u32, out: &mut Vec<u8>) {
    let rect = rows.export_rect;
    let source = |y: i64| {
        let n = rows.doc_width as usize * 4;
        if y < rows.group_top || y >= rows.group_bottom {
            vec![0; n]
        } else {
            let start = (y - rows.group_top) as usize * n;
            rows.window[start..start + n].to_vec()
        }
    };
    out.clear();
    if rows.output_width == rect.width && rows.output_height == rect.height {
        let row = source(rect.top + i64::from(y));
        let start = rect.left as usize * 4;
        out.extend_from_slice(&row[start..start + rect.width as usize * 4]);
        return;
    }
    let sy = ((f64::from(y) + 0.5) * f64::from(rect.height) / f64::from(rows.output_height) - 0.5)
        .clamp(0.0, f64::from(rect.height.saturating_sub(1)));
    let y0 = sy.floor() as i64 + rect.top;
    let y1 = (y0 + 1).min(rect.top + i64::from(rect.height) - 1);
    let fy = sy - sy.floor();
    let a = source(y0);
    let b = if y1 == y0 { a.clone() } else { source(y1) };
    for x in 0..rows.output_width {
        let sx = ((f64::from(x) + 0.5) * f64::from(rect.width) / f64::from(rows.output_width)
            - 0.5)
            .clamp(0.0, f64::from(rect.width.saturating_sub(1)));
        let x0 = sx.floor() as i64 + rect.left;
        let x1 = (x0 + 1).min(rect.left + i64::from(rect.width) - 1);
        let fx = sx - sx.floor();
        for c in 0..4 {
            let sample = |row: &[u8], x: i64| {
                if x < 0 || x >= i64::from(rows.doc_width) {
                    0
                } else {
                    row[x as usize * 4 + c]
                }
            };
            let top = f64::from(sample(&a, x0)) * (1.0 - fx) + f64::from(sample(&a, x1)) * fx;
            let bottom = f64::from(sample(&b, x0)) * (1.0 - fx) + f64::from(sample(&b, x1)) * fx;
            out.push((top * (1.0 - fy) + bottom * fy + 0.5) as u8);
        }
    }
}

#[test]
fn window_source_rows_borrow_resident_pixels() {
    let rows = window(
        Rect {
            left: 0,
            top: 0,
            width: 17,
            height: 12,
        },
        17,
        12,
    );
    for y in rows.group_top..rows.group_bottom {
        let row = rows.source_row(y).expect("row");
        let offset = (y - rows.group_top) as usize * 17 * 4;
        assert_eq!(row.len(), 17 * 4);
        assert_eq!(
            row.as_ptr(),
            rows.window[offset..].as_ptr(),
            "row must alias the resident window"
        );
        assert_eq!(&row[..], &rows.window[offset..offset + 17 * 4]);
    }
}

#[test]
fn borrowed_window_rows_match_copied_reference() {
    let rects = [
        Rect {
            left: 0,
            top: 0,
            width: 17,
            height: 12,
        },
        Rect {
            left: 3,
            top: 3,
            width: 9,
            height: 4,
        },
        Rect {
            left: 16,
            top: 0,
            width: 1,
            height: 12,
        },
        Rect {
            left: 0,
            top: 8,
            width: 17,
            height: 1,
        },
    ];
    for rect in rects {
        for (w, h) in [(rect.width, rect.height), (9, 7), (29, 19), (1, 1)] {
            let rows = window(rect, w, h);
            let mut actual = vec![255; 200];
            let mut expected = Vec::new();
            // JPEG callers can repeat rows. Reverse reads must not depend on
            // a previous call's output or cache state either.
            for y in (0..h).chain((0..h).rev()).chain(0..h) {
                rows.read_rgba_row(y, &mut actual).expect("read");
                copied_reference(&rows, y, &mut expected);
                assert_eq!(actual, expected, "rect={rect:?}, output={w}x{h}, y={y}");
            }
        }
    }
}

#[test]
fn transparent_padding_reuses_output_and_retains_no_source_row() {
    let rows = window(
        Rect {
            left: 3,
            top: 0,
            width: 9,
            height: 12,
        },
        9,
        12,
    );
    let mut output = vec![255; 9 * 4];
    let ptr = output.as_ptr();
    for y in [0, 1, 9, 10, 11] {
        assert!(rows.source_row(y).expect("padding").is_empty());
        output.fill(255);
        rows.read_rgba_row(y as u32, &mut output)
            .expect("transparent row");
        assert_eq!(output, vec![0; 9 * 4]);
        assert_eq!(
            output.as_ptr(),
            ptr,
            "reuse the encoder's output allocation"
        );
    }
}

#[test]
fn borrowed_rows_keep_jpeg_bytes_identical() {
    struct Copied<'a>(&'a WindowRgbaRows);
    impl RgbaRows for Copied<'_> {
        fn width(&self) -> u32 {
            self.0.output_width
        }
        fn height(&self) -> u32 {
            self.0.output_height
        }
        fn read_rgba_row(&self, y: u32, out: &mut Vec<u8>) -> Result<(), MediaError> {
            copied_reference(self.0, y, out);
            Ok(())
        }
    }
    for (w, h) in [(17, 12), (9, 7), (29, 19), (1, 1)] {
        let rows = window(
            Rect {
                left: 0,
                top: 0,
                width: 17,
                height: 12,
            },
            w,
            h,
        );
        for quality in [1, 82, 100] {
            let mut actual = Vec::new();
            let mut expected = Vec::new();
            let a = crate::media::encode::encode_jpeg_rows_to_writer(
                &rows,
                &mut actual,
                quality,
                1 << 20,
            )
            .expect("encode");
            let b = crate::media::encode::encode_jpeg_rows_to_writer(
                &Copied(&rows),
                &mut expected,
                quality,
                1 << 20,
            )
            .expect("reference encode");
            assert_eq!(a, b);
            assert_eq!(actual, expected);
        }
    }
}

#[test]
#[ignore = "manual release-mode row microbenchmark; no timing assertions"]
fn window_row_benchmark() {
    use std::hint::black_box;
    use std::time::Instant;
    for (w, h) in [(4096, 2048), (2048, 1024)] {
        let rows = WindowRgbaRows {
            window: Arc::new(vec![127; 4096 * 2048 * 4]),
            doc_width: 4096,
            group_top: 0,
            group_bottom: 2048,
            export_rect: Rect {
                left: 0,
                top: 0,
                width: 4096,
                height: 2048,
            },
            output_width: w,
            output_height: h,
            cancellation: None,
        };
        let mut out = Vec::with_capacity(w as usize * 4);
        for y in 0..h {
            rows.read_rgba_row(y, &mut out).expect("warmup");
        }
        for sample in 0..5 {
            let start = Instant::now();
            for _ in 0..5 {
                for y in 0..h {
                    black_box(&rows).read_rgba_row(y, &mut out).expect("row");
                    black_box(&out);
                }
            }
            println!(
                "window-row {w}x{h} sample={sample} five_frames_us={}",
                start.elapsed().as_micros()
            );
        }
    }
}
