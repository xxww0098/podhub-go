/*
File: rust/crates/psd-x/src/additional_info/vector_keys.rs

Purpose:
Additional-info key group-module. Group: `Group::Vector`.
Vector masks/fills/strokes (vmsk, vsms, vscg, vstk, vogk, vowv, SoCo, GdFl,
PtFl, pths). Port of the matching `addHandler(...)` blocks from
ag-psd `src/additionalInfo.ts`.

CANONICAL HOME for vector-mask / bezier-curve parsing:
`read_vector_mask` / `read_bezier_knot` / `boolean_operations` live HERE
(used by the vmsk handler). A local copy also exists in `csh.rs`; it
should later be switched to call here.

DESCRIPTOR-BASED KEYS: SoCo / GdFl / PtFl / vscg / vstk / vogk use the
descriptor tree (`read_version_and_descriptor`). Vector content/color are built
with explicit `DescriptorValue` variants via the ported
`parse_color` / `serialize_color` (descriptor.rs) and
`parse_vector_content` / `serialize_vector_content` (vector_fill.rs).

GROUP-MODULE CONTRACT (see mod.rs):
- `pub fn read(key, reader, info, left, ctx) -> ReadResult<Option<()>>`
    Ok(Some(())) — key handled; Ok(None) — "not my key".
- `pub fn has(key, info) -> Option<bool>`
    Some(b) — this group-module owns the key; b = whether to write it;
    None — "not my key".
- `pub fn write(key, writer, info, ctx) -> Option<ReadResult<()>>`
    Some(Ok(())) / Some(Err(_)) / None — see GROUP-MODULE CONTRACT in mod.rs.
    `write_additional_info` returns WriteResult.
*/

use crate::additional_info::vector_fill::{
    parse_vector_content, parse_vector_stroke, serialize_vector_content, serialize_vector_stroke,
};
use crate::additional_info::{ReadCtx, WriteCtx};
use crate::descriptor::{
    Descriptor, DescriptorValue, parse_units, parse_units_or_number, read_version_and_descriptor,
    units_value, write_version_and_descriptor,
};
use crate::psd::{
    BezierKnot, BezierPath, BooleanOperation, FillRule, KeyDescriptorItem, LayerAdditionalInfo,
    LayerVectorMask, PointF, RRectRadii, UnitsBounds, VectorContent, VectorMaskClipboard,
    VectorOrigination,
};
use crate::reader::{
    PsdReader, ReadError, ReadResult, read_fixed_point_path32, read_int16, read_int32,
    read_signature, read_uint16, read_uint32, skip_bytes,
};
use crate::writer::{
    PsdWriter, write_fixed_point_path32, write_int16, write_int32, write_signature, write_uint16,
    write_uint32, write_zeros,
};

// ===========================================================================
// Shared vector-mask / bezier-path parsing (CANONICAL HOME)
// ===========================================================================

/// `booleanOperations: BooleanOperation[]` from additionalInfo.ts (index -> op).
fn boolean_operation(index: i16) -> Option<BooleanOperation> {
    match index {
        0 => Some(BooleanOperation::Exclude),
        1 => Some(BooleanOperation::Combine),
        2 => Some(BooleanOperation::Subtract),
        3 => Some(BooleanOperation::Intersect),
        _ => None,
    }
}

/// `booleanOperations.indexOf(op)`.
fn boolean_operation_index(op: BooleanOperation) -> i16 {
    match op {
        BooleanOperation::Exclude => 0,
        BooleanOperation::Combine => 1,
        BooleanOperation::Subtract => 2,
        BooleanOperation::Intersect => 3,
    }
}

/// Port of `readBezierKnot(reader, width, height)` — 8.24 fixed-point points,
/// order (y0,x0,y1,x1,y2,x2), returns `[x0,y0,x1,y1,x2,y2]`.
pub fn read_bezier_knot(reader: &mut PsdReader, width: f64, height: f64) -> ReadResult<Vec<f64>> {
    let y0 = read_fixed_point_path32(reader)? * height;
    let x0 = read_fixed_point_path32(reader)? * width;
    let y1 = read_fixed_point_path32(reader)? * height;
    let x1 = read_fixed_point_path32(reader)? * width;
    let y2 = read_fixed_point_path32(reader)? * height;
    let x2 = read_fixed_point_path32(reader)? * width;
    Ok(vec![x0, y0, x1, y1, x2, y2])
}

/// Port of `writeBezierKnot(writer, points, width, height)`.
fn write_bezier_knot(writer: &mut PsdWriter, points: &[f64], width: f64, height: f64) {
    let safe = |v: f64, d: f64| if d != 0.0 { v / d } else { 0.0 };
    write_fixed_point_path32(writer, safe(points[1], height)); // y0
    write_fixed_point_path32(writer, safe(points[0], width)); // x0
    write_fixed_point_path32(writer, safe(points[3], height)); // y1
    write_fixed_point_path32(writer, safe(points[2], width)); // x1
    write_fixed_point_path32(writer, safe(points[5], height)); // y2
    write_fixed_point_path32(writer, safe(points[4], width)); // x2
}

/// Port of `readVectorMask(reader, vectorMask, width, height, size)`.
///
/// CANONICAL HOME — `csh.rs` keeps a duplicate that should later call here.
pub fn read_vector_mask(
    reader: &mut PsdReader,
    vector_mask: &mut LayerVectorMask,
    width: f64,
    height: f64,
    size: usize,
) -> ReadResult<()> {
    let end = reader.offset + size;
    let mut current: Option<usize> = None;

    while end.saturating_sub(reader.offset) >= 26 {
        let selector = read_uint16(reader)?;

        match selector {
            // Closed (0) / Open (3) subpath length record
            0 | 3 => {
                let _count = read_uint16(reader)?;
                let bool_op = read_int16(reader)?;
                let flags = read_uint16(reader)?; // bit 1 always 1 ?
                skip_bytes(reader, 18);
                let mut path = BezierPath {
                    open: selector == 3,
                    operation: None,
                    knots: Vec::new(),
                    fill_rule: if flags == 2 {
                        FillRule::NonZero
                    } else {
                        FillRule::EvenOdd
                    },
                };
                if bool_op != -1 {
                    path.operation = boolean_operation(bool_op);
                }
                vector_mask.paths.push(path);
                current = Some(vector_mask.paths.len() - 1);
            }
            // Bezier knot: closed-linked(1)/closed-unlinked(2)/open-linked(4)/open-unlinked(5)
            1 | 2 | 4 | 5 => {
                let points = read_bezier_knot(reader, width, height)?;
                let idx = current.ok_or_else(|| {
                    ReadError::StrictViolation("Invalid vmsk section".to_string())
                })?;
                vector_mask.paths[idx].knots.push(BezierKnot {
                    linked: selector == 1 || selector == 4,
                    points,
                });
            }
            // Path fill rule record
            6 => {
                skip_bytes(reader, 24);
            }
            // Clipboard record
            7 => {
                let top = read_fixed_point_path32(reader)?;
                let left = read_fixed_point_path32(reader)?;
                let bottom = read_fixed_point_path32(reader)?;
                let right = read_fixed_point_path32(reader)?;
                let resolution = read_fixed_point_path32(reader)?;
                skip_bytes(reader, 4);
                vector_mask.clipboard = Some(VectorMaskClipboard {
                    top,
                    left,
                    bottom,
                    right,
                    resolution,
                });
            }
            // Initial fill rule record
            8 => {
                vector_mask.fill_starts_with_all_pixels = Some(read_uint16(reader)? != 0);
                skip_bytes(reader, 22);
            }
            _ => {
                return Err(ReadError::StrictViolation(
                    "Invalid vmsk section".to_string(),
                ));
            }
        }
    }

    Ok(())
}

/// Port of the `vmsk` writer-block body (path records). Exact mirror of upstream:
/// initial entry (selector 6 + 24 zeros), optional clipboard (7), initial fill
/// rule (8), then per path: subpath length record + knots.
fn write_vector_mask_paths(
    writer: &mut PsdWriter,
    mask: &LayerVectorMask,
    width: f64,
    height: f64,
) {
    // initial entry
    write_uint16(writer, 6);
    write_zeros(writer, 24);

    if let Some(clip) = &mask.clipboard {
        write_uint16(writer, 7);
        write_fixed_point_path32(writer, clip.top);
        write_fixed_point_path32(writer, clip.left);
        write_fixed_point_path32(writer, clip.bottom);
        write_fixed_point_path32(writer, clip.right);
        write_fixed_point_path32(writer, clip.resolution);
        write_zeros(writer, 4);
    }

    write_uint16(writer, 8);
    write_uint16(
        writer,
        if mask.fill_starts_with_all_pixels == Some(true) {
            1
        } else {
            0
        },
    );
    write_zeros(writer, 22);

    for path in &mask.paths {
        write_uint16(writer, if path.open { 3 } else { 0 });
        write_uint16(writer, path.knots.len() as u16); // count
        write_int16(
            writer,
            path.operation.map(boolean_operation_index).unwrap_or(-1),
        ); // -1 for undefined
        write_uint16(
            writer,
            match path.fill_rule {
                FillRule::NonZero => 2,
                FillRule::EvenOdd => 1,
            },
        );
        write_zeros(writer, 18); // TODO: these are sometimes non-zero

        let linked_knot: u16 = if path.open { 4 } else { 1 };
        let unlinked_knot: u16 = if path.open { 5 } else { 2 };

        for knot in &path.knots {
            write_uint16(
                writer,
                if knot.linked {
                    linked_knot
                } else {
                    unlinked_knot
                },
            );
            write_bezier_knot(writer, &knot.points, width, height);
        }
    }
}

fn dv_f64(v: &DescriptorValue) -> Option<f64> {
    match v {
        DescriptorValue::Double(x) => Some(*x),
        DescriptorValue::Integer(x) => Some(*x as f64),
        DescriptorValue::UnitDouble(u) => Some(u.value),
        _ => None,
    }
}

// ===========================================================================
// READ
// ===========================================================================

/// See GROUP-MODULE CONTRACT in mod.rs.
pub fn read(
    key: &str,
    reader: &mut PsdReader,
    info: &mut LayerAdditionalInfo,
    left: &dyn Fn(&PsdReader) -> usize,
    ctx: &mut ReadCtx,
) -> ReadResult<Option<()>> {
    match key {
        // -- vmsk / vsms: vector mask --------------------------------------
        "vmsk" | "vsms" => {
            if read_uint32(reader)? != 3 {
                return Err(ReadError::StrictViolation(
                    "Invalid vmsk version".to_string(),
                ));
            }

            let mut vector_mask = LayerVectorMask::default();
            let flags = read_uint32(reader)?;
            vector_mask.invert = Some((flags & 1) != 0);
            vector_mask.not_link = Some((flags & 2) != 0);
            vector_mask.disable = Some((flags & 4) != 0);

            let (width, height) = doc_size(ctx);
            read_vector_mask(reader, &mut vector_mask, width, height, left(reader))?;

            info.vector_mask = Some(vector_mask);
            skip_bytes(reader, left(reader));
            Ok(Some(()))
        }

        // -- vowv: something with vectors (always 2 ?) ---------------------
        "vowv" => {
            info.vowv = Some(read_uint32(reader)? as f64);
            Ok(Some(()))
        }

        // -- SoCo / PtFl: descriptor vector fill ---------------------------
        "SoCo" | "PtFl" => {
            let desc = read_version_and_descriptor(reader)?;
            info.vector_fill = Some(parse_vector_content(&desc)?);
            Ok(Some(()))
        }

        // -- GdFl: descriptor vector fill (has trailing bytes) -------------
        "GdFl" => {
            let desc = read_version_and_descriptor(reader)?;
            info.vector_fill = Some(parse_vector_content(&desc)?);
            skip_bytes(reader, left(reader));
            Ok(Some(()))
        }

        // -- vscg: vector stroke content -----------------------------------
        "vscg" => {
            let _key = read_signature(reader)?; // key (color class)
            let desc = read_version_and_descriptor(reader)?;
            info.vector_fill = Some(parse_vector_content(&desc)?);
            skip_bytes(reader, left(reader));
            Ok(Some(()))
        }

        // -- vstk: vector stroke data --------------------------------------
        "vstk" => {
            let desc = read_version_and_descriptor(reader)?;
            info.vector_stroke = Some(parse_vector_stroke(&desc)?);
            skip_bytes(reader, left(reader));
            Ok(Some(()))
        }

        // -- vogk: vector origination --------------------------------------
        "vogk" => {
            if read_int32(reader)? != 1 {
                return Err(ReadError::StrictViolation(
                    "Invalid vogk version".to_string(),
                ));
            }
            let desc = read_version_and_descriptor(reader)?;
            info.vector_origination = Some(parse_vogk(&desc)?);
            skip_bytes(reader, left(reader));
            Ok(Some(()))
        }

        // -- pths: paths ---------------------------------------------------
        "pths" => {
            let _desc = read_version_and_descriptor(reader)?;
            // TODO upstream: read paths. Upstream sets pathList = [] (no paths
            // read yet); mirror that.
            info.path_list = Some(Vec::new());
            skip_bytes(reader, left(reader));
            Ok(Some(()))
        }

        _ => Ok(None),
    }
}

/// Upstream `vogk` read: map descriptor `keyDescriptorList` → typed items.
fn parse_vogk(desc: &Descriptor) -> ReadResult<VectorOrigination> {
    let mut list = Vec::new();
    let items = match desc.get("keyDescriptorList") {
        Some(DescriptorValue::List(items)) => items,
        _ => {
            return Ok(VectorOrigination {
                key_descriptor_list: list,
            });
        }
    };
    for item_v in items {
        let d = match item_v {
            DescriptorValue::Descriptor(d) => d,
            _ => continue,
        };
        let mut item = KeyDescriptorItem::default();
        if let Some(DescriptorValue::Boolean(b)) = d.get("keyShapeInvalidated") {
            item.key_shape_invalidated = Some(*b);
        }
        if let Some(v) = d.get("keyOriginType").and_then(dv_f64) {
            item.key_origin_type = Some(v);
        }
        if let Some(v) = d.get("keyOriginResolution").and_then(dv_f64) {
            item.key_origin_resolution = Some(v);
        }
        if let Some(DescriptorValue::Descriptor(bbox)) = d.get("keyOriginShapeBBox") {
            if let (Some(top), Some(left), Some(bottom), Some(right)) = (
                bbox.get("Top ").map(parse_units_or_number).transpose()?,
                bbox.get("Left").map(parse_units_or_number).transpose()?,
                bbox.get("Btom").map(parse_units_or_number).transpose()?,
                bbox.get("Rght").map(parse_units_or_number).transpose()?,
            ) {
                item.key_origin_shape_bounding_box = Some(UnitsBounds {
                    top,
                    left,
                    bottom,
                    right,
                });
            }
        }
        if let Some(DescriptorValue::Descriptor(radii)) = d.get("keyOriginRRectRadii") {
            if let (Some(top_right), Some(top_left), Some(bottom_left), Some(bottom_right)) = (
                radii.get("topRight").map(parse_units).transpose()?,
                radii.get("topLeft").map(parse_units).transpose()?,
                radii.get("bottomLeft").map(parse_units).transpose()?,
                radii.get("bottomRight").map(parse_units).transpose()?,
            ) {
                item.key_origin_r_rect_radii = Some(RRectRadii {
                    top_right,
                    top_left,
                    bottom_left,
                    bottom_right,
                });
            }
        }
        if let Some(DescriptorValue::Descriptor(corners)) = d.get("keyOriginBoxCorners") {
            let corner = |name: &str| -> Option<PointF> {
                let DescriptorValue::Descriptor(c) = corners.get(name)? else {
                    return None;
                };
                Some(PointF {
                    x: c.get("Hrzn").and_then(dv_f64).unwrap_or(0.0),
                    y: c.get("Vrtc").and_then(dv_f64).unwrap_or(0.0),
                })
            };
            if let (Some(a), Some(b), Some(c), Some(d)) = (
                corner("rectangleCornerA"),
                corner("rectangleCornerB"),
                corner("rectangleCornerC"),
                corner("rectangleCornerD"),
            ) {
                item.key_origin_box_corners = Some(vec![a, b, c, d]);
            }
        }
        if let Some(DescriptorValue::Descriptor(trnf)) = d.get("Trnf") {
            let get = |k: &str| trnf.get(k).and_then(dv_f64).unwrap_or(0.0);
            item.transform = Some(vec![
                get("xx"),
                get("xy"),
                get("yx"),
                get("yy"),
                get("tx"),
                get("ty"),
            ]);
        }
        list.push(item);
    }
    Ok(VectorOrigination {
        key_descriptor_list: list,
    })
}

/// Document pixel size for bezier denormalization (upstream vmsk 4th arg).
fn doc_size(ctx: &ReadCtx) -> (f64, f64) {
    let w = if ctx.doc_width > 0.0 {
        ctx.doc_width
    } else {
        1.0
    };
    let h = if ctx.doc_height > 0.0 {
        ctx.doc_height
    } else {
        1.0
    };
    (w, h)
}

// ===========================================================================
// HAS
// ===========================================================================

/// See GROUP-MODULE CONTRACT in mod.rs. Mirror of upstream handler predicates.
pub fn has(key: &str, info: &LayerAdditionalInfo) -> Option<bool> {
    match key {
        "vmsk" | "vsms" => Some(info.vector_mask.is_some()),
        "vowv" => Some(info.vowv.is_some()),
        "vogk" => Some(info.vector_origination.is_some()),
        "vstk" => Some(info.vector_stroke.is_some()),
        "pths" => Some(info.path_list.is_some()),
        // SoCo: color fill, no stroke
        "SoCo" => Some(
            info.vector_stroke.is_none()
                && matches!(info.vector_fill, Some(VectorContent::Color(_))),
        ),
        // GdFl: solid/noise gradient fill, no stroke
        "GdFl" => Some(
            info.vector_stroke.is_none()
                && matches!(
                    info.vector_fill,
                    Some(VectorContent::SolidGradient { .. })
                        | Some(VectorContent::NoiseGradient { .. })
                ),
        ),
        // PtFl: pattern fill, no stroke
        "PtFl" => Some(
            info.vector_stroke.is_none()
                && matches!(info.vector_fill, Some(VectorContent::Pattern { .. })),
        ),
        // vscg: stroke content (fill + stroke both present)
        "vscg" => Some(info.vector_fill.is_some() && info.vector_stroke.is_some()),
        _ => None,
    }
}

// ===========================================================================
// WRITE
// ===========================================================================

/// See GROUP-MODULE CONTRACT in mod.rs. Called only if has==Some(true).
pub fn write(
    key: &str,
    writer: &mut PsdWriter,
    info: &LayerAdditionalInfo,
    ctx: &mut WriteCtx,
) -> Option<ReadResult<()>> {
    match key {
        "vmsk" | "vsms" => {
            let mask = info.vector_mask.as_ref()?;
            let flags = (if mask.invert == Some(true) { 1 } else { 0 })
                | (if mask.not_link == Some(true) { 2 } else { 0 })
                | (if mask.disable == Some(true) { 4 } else { 0 });

            write_uint32(writer, 3); // version
            write_uint32(writer, flags);

            let (width, height) = write_doc_size(ctx);
            write_vector_mask_paths(writer, mask, width, height);
            Some(Ok(()))
        }

        "vowv" => {
            write_uint32(writer, info.vowv.unwrap_or(0.0) as u32);
            Some(Ok(()))
        }

        "SoCo" | "GdFl" | "PtFl" => {
            let fill = info.vector_fill.as_ref()?;
            Some(match serialize_vector_content(fill) {
                Ok((desc, _key)) => {
                    write_version_and_descriptor(writer, &desc);
                    Ok(())
                }
                Err(e) => Err(e),
            })
        }

        "vscg" => {
            let fill = info.vector_fill.as_ref()?;
            Some(match serialize_vector_content(fill) {
                Ok((desc, content_key)) => {
                    write_signature(writer, content_key).expect("signature");
                    write_version_and_descriptor(writer, &desc);
                    Ok(())
                }
                Err(e) => Err(e),
            })
        }

        "vstk" => Some(write_vector_stroke(writer, info)),

        "vogk" => {
            let orig = info.vector_origination.as_ref()?;
            write_int32(writer, 1); // version
            write_version_and_descriptor(writer, &serialize_vogk(orig));
            Some(Ok(()))
        }

        "pths" => {
            let mut desc = Descriptor::new("", "pathsDataClass");
            desc.set("pathList", DescriptorValue::List(Vec::new()));
            write_version_and_descriptor(writer, &desc);
            Some(Ok(()))
        }

        _ => None,
    }
}

fn write_doc_size(ctx: &WriteCtx) -> (f64, f64) {
    let w = if ctx.doc_width > 0.0 {
        ctx.doc_width
    } else {
        1.0
    };
    let h = if ctx.doc_height > 0.0 {
        ctx.doc_height
    } else {
        1.0
    };
    (w, h)
}

fn write_vector_stroke(writer: &mut PsdWriter, info: &LayerAdditionalInfo) -> ReadResult<()> {
    let stroke = match info.vector_stroke.as_ref() {
        Some(s) => s,
        None => return Ok(()),
    };
    let desc = serialize_vector_stroke(stroke)?;
    write_version_and_descriptor(writer, &desc);
    Ok(())
}

/// Upstream `vogk` write: typed items → `keyDescriptorList` descriptors.
fn serialize_vogk(orig: &VectorOrigination) -> Descriptor {
    let mut list = Vec::with_capacity(orig.key_descriptor_list.len());
    for (i, item) in orig.key_descriptor_list.iter().enumerate() {
        let mut out = Descriptor::new("", "null");
        if let Some(v) = item.key_origin_type {
            out.set("keyOriginType", DescriptorValue::Integer(v.round() as i32));
        }
        if let Some(v) = item.key_origin_resolution {
            out.set("keyOriginResolution", DescriptorValue::Double(v));
        }
        if let Some(radii) = &item.key_origin_r_rect_radii {
            let mut r = Descriptor::new("", "radii");
            r.set("unitValueQuadVersion", DescriptorValue::Integer(1));
            r.set("topRight", units_value(Some(&radii.top_right)));
            r.set("topLeft", units_value(Some(&radii.top_left)));
            r.set("bottomLeft", units_value(Some(&radii.bottom_left)));
            r.set("bottomRight", units_value(Some(&radii.bottom_right)));
            out.set("keyOriginRRectRadii", DescriptorValue::Descriptor(r));
        }
        if let Some(box_) = &item.key_origin_shape_bounding_box {
            let mut b = Descriptor::new("", "unitRect");
            b.set("unitValueQuadVersion", DescriptorValue::Integer(1));
            b.set("Top ", units_value(Some(&box_.top)));
            b.set("Left", units_value(Some(&box_.left)));
            b.set("Btom", units_value(Some(&box_.bottom)));
            b.set("Rght", units_value(Some(&box_.right)));
            out.set("keyOriginShapeBBox", DescriptorValue::Descriptor(b));
        }
        if let Some(corners) = &item.key_origin_box_corners {
            if corners.len() == 4 {
                let corner = |p: &PointF| {
                    let mut c = Descriptor::new("", "Pnt ");
                    c.set("Hrzn", DescriptorValue::Double(p.x));
                    c.set("Vrtc", DescriptorValue::Double(p.y));
                    DescriptorValue::Descriptor(c)
                };
                let mut corners_d = Descriptor::new("", "null");
                corners_d.set("rectangleCornerA", corner(&corners[0]));
                corners_d.set("rectangleCornerB", corner(&corners[1]));
                corners_d.set("rectangleCornerC", corner(&corners[2]));
                corners_d.set("rectangleCornerD", corner(&corners[3]));
                out.set(
                    "keyOriginBoxCorners",
                    DescriptorValue::Descriptor(corners_d),
                );
            }
        }
        if let Some(tr) = &item.transform {
            if tr.len() == 6 {
                // fieldToExtType Trnf → name "Transform", classID "Trnf"
                let mut t = Descriptor::new("Transform", "Trnf");
                t.set("xx", DescriptorValue::Double(tr[0]));
                t.set("xy", DescriptorValue::Double(tr[1]));
                t.set("yx", DescriptorValue::Double(tr[2]));
                t.set("yy", DescriptorValue::Double(tr[3]));
                t.set("tx", DescriptorValue::Double(tr[4]));
                t.set("ty", DescriptorValue::Double(tr[5]));
                out.set("Trnf", DescriptorValue::Descriptor(t));
            }
        }
        if let Some(v) = item.key_shape_invalidated {
            out.set("keyShapeInvalidated", DescriptorValue::Boolean(v));
        }
        out.set("keyOriginIndex", DescriptorValue::Integer(i as i32));
        list.push(DescriptorValue::Descriptor(out));
    }
    let mut desc = Descriptor::new("", "null");
    desc.set("keyDescriptorList", DescriptorValue::List(list));
    desc
}

// ===========================================================================
// Tests
// ===========================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use crate::psd::{Color, ReadOptions, Rgb, WriteOptions};
    use crate::reader::PsdReader;
    use crate::writer::create_writer;

    fn approx_eq(a: f64, b: f64) -> bool {
        (a - b).abs() < 1e-2
    }

    fn read_ctx(opts: &ReadOptions) -> ReadCtx<'_> {
        ReadCtx::new(opts, false)
    }

    #[test]
    fn vmsk_round_trip() {
        let mut mask = LayerVectorMask::default();
        mask.invert = Some(true);
        mask.disable = Some(false);
        mask.fill_starts_with_all_pixels = Some(true);
        mask.paths.push(BezierPath {
            open: false,
            operation: Some(BooleanOperation::Combine),
            knots: vec![
                BezierKnot {
                    linked: true,
                    points: vec![10.0, 20.0, 11.0, 21.0, 12.0, 22.0],
                },
                BezierKnot {
                    linked: false,
                    points: vec![30.0, 40.0, 31.0, 41.0, 32.0, 42.0],
                },
            ],
            fill_rule: FillRule::NonZero,
        });

        let mut info = LayerAdditionalInfo::default();
        info.vector_mask = Some(mask);

        // write
        let w_opts = WriteOptions::default();
        let mut ctx = WriteCtx::new(&w_opts, false);
        let mut writer = create_writer(256);
        let res = write("vmsk", &mut writer, &info, &mut ctx).expect("vmsk write");
        res.expect("vmsk write ok");
        let bytes = writer.to_bytes();

        // read
        let r_opts = ReadOptions::default();
        let len = bytes.len();
        let mut reader = PsdReader::new(&bytes, None, None);
        let mut out = LayerAdditionalInfo::default();
        let mut rctx = read_ctx(&r_opts);
        let left = move |r: &PsdReader| len.saturating_sub(r.offset);
        read("vmsk", &mut reader, &mut out, &left, &mut rctx)
            .expect("vmsk read")
            .expect("vmsk handled");

        let m = out.vector_mask.expect("mask present");
        assert_eq!(m.invert, Some(true));
        assert_eq!(m.disable, Some(false));
        assert_eq!(m.fill_starts_with_all_pixels, Some(true));
        assert_eq!(m.paths.len(), 1);
        let p = &m.paths[0];
        assert!(!p.open);
        assert_eq!(p.operation, Some(BooleanOperation::Combine));
        assert_eq!(p.fill_rule, FillRule::NonZero);
        assert_eq!(p.knots.len(), 2);
        assert!(p.knots[0].linked);
        assert!(!p.knots[1].linked);
        for i in 0..6 {
            assert!(
                approx_eq(
                    p.knots[0].points[i],
                    [10.0, 20.0, 11.0, 21.0, 12.0, 22.0][i]
                ),
                "knot point {i}"
            );
        }
    }

    #[test]
    fn soco_round_trip() {
        let mut info = LayerAdditionalInfo::default();
        info.vector_fill = Some(VectorContent::Color(Color::Rgb(Rgb {
            r: 12.0,
            g: 34.0,
            b: 56.0,
        })));

        assert_eq!(has("SoCo", &info), Some(true));

        let w_opts = WriteOptions::default();
        let mut ctx = WriteCtx::new(&w_opts, false);
        let mut writer = create_writer(256);
        write("SoCo", &mut writer, &info, &mut ctx)
            .expect("SoCo write")
            .expect("SoCo write ok");
        let bytes = writer.to_bytes();

        let r_opts = ReadOptions::default();
        let len = bytes.len();
        let mut reader = PsdReader::new(&bytes, None, None);
        let mut out = LayerAdditionalInfo::default();
        let mut rctx = read_ctx(&r_opts);
        let left = move |r: &PsdReader| len.saturating_sub(r.offset);
        read("SoCo", &mut reader, &mut out, &left, &mut rctx)
            .expect("SoCo read")
            .expect("SoCo handled");

        match out.vector_fill {
            Some(VectorContent::Color(Color::Rgb(c))) => {
                assert!(approx_eq(c.r, 12.0));
                assert!(approx_eq(c.g, 34.0));
                assert!(approx_eq(c.b, 56.0));
            }
            other => panic!("expected rgb color fill, got {other:?}"),
        }
    }

    #[test]
    fn gdfl_and_vstk_round_trip() {
        use crate::psd::{
            EffectSolidGradient, ExtraGradientInfo, GradientStyle, LineAlignment, LineCapType,
            LineJoinType, Units, UnitsValue, VectorStroke,
        };

        let mut info = LayerAdditionalInfo::default();
        info.vector_fill = Some(VectorContent::SolidGradient {
            gradient: EffectSolidGradient {
                name: "Foreground to Transparent".into(),
                smoothness: Some(1.0),
                color_stops: Vec::new(),
                opacity_stops: Vec::new(),
            },
            extra: ExtraGradientInfo {
                style: Some(GradientStyle::Linear),
                scale: Some(1.0),
                angle: Some(90.0),
                align: Some(true),
                ..ExtraGradientInfo::default()
            },
        });
        info.vector_stroke = Some(VectorStroke {
            stroke_enabled: Some(true),
            fill_enabled: Some(true),
            line_width: Some(UnitsValue {
                units: Units::Pixels,
                value: 2.0,
            }),
            line_cap_type: Some(LineCapType::Round),
            line_join_type: Some(LineJoinType::Round),
            line_alignment: Some(LineAlignment::Center),
            opacity: Some(0.75),
            content: Some(VectorContent::Color(Color::Rgb(Rgb {
                r: 1.0,
                g: 2.0,
                b: 3.0,
            }))),
            resolution: Some(72.0),
            miter_limit: Some(100.0),
            ..VectorStroke::default()
        });

        assert_eq!(has("vscg", &info), Some(true));
        assert_eq!(has("vstk", &info), Some(true));
        assert_eq!(has("GdFl", &info), Some(false)); // stroke present → GdFl off

        let w_opts = WriteOptions::default();
        let mut ctx = WriteCtx::new(&w_opts, false);
        let mut writer = create_writer(512);
        write("vstk", &mut writer, &info, &mut ctx)
            .expect("vstk write")
            .expect("vstk write ok");
        let bytes = writer.to_bytes();

        let r_opts = ReadOptions::default();
        let len = bytes.len();
        let mut reader = PsdReader::new(&bytes, None, None);
        let mut out = LayerAdditionalInfo::default();
        let mut rctx = read_ctx(&r_opts);
        let left = move |r: &PsdReader| len.saturating_sub(r.offset);
        read("vstk", &mut reader, &mut out, &left, &mut rctx)
            .expect("vstk read")
            .expect("vstk handled");

        let s = out.vector_stroke.expect("stroke");
        assert_eq!(s.stroke_enabled, Some(true));
        assert_eq!(s.line_cap_type, Some(LineCapType::Round));
        assert_eq!(s.line_alignment, Some(LineAlignment::Center));
        assert!(approx_eq(s.opacity.unwrap_or(0.0), 0.75));
        assert!(approx_eq(s.line_width.unwrap().value, 2.0));
    }
}
