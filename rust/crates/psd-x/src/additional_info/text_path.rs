//! Restore `layer.text.textPath` from document-level `Txt2` EngineData2.
//!
//! Mirrors upstream `additionalInfo.ts` Txt2 handler: parse → decodeEngineData2 →
//! `ResourceDict.TextFrameSet[i].path` → layer with `text.index == i`.

use crate::engine_data::{EngineValue, parse_engine_data_with_limit};
use crate::engine_data2::decode_engine_data2_with_limit;
use crate::psd::{
    Layer, Psd, TextPath, TextPathAtom, TextPathBaselineAlignment, TextPathBezierCurve,
    TextPathData, TextPathPathData,
};
use crate::reader::{ReadError, ReadResult};

/// Upstream `getTextLayersSortedByIndex` + TextFrameSet → `textPath` assignment.
pub(crate) fn apply_text_paths_from_engine_data2(
    psd: &mut Psd,
    data: &[u8],
    max_depth: u32,
) -> ReadResult<()> {
    let engine_data = match parse_engine_data_with_limit(data, max_depth) {
        Ok(v) => v,
        Err(error) if error.0.contains("recursion depth") => {
            return Err(ReadError::RecursionLimitExceeded {
                observed: max_depth.saturating_add(1),
                limit: max_depth,
            });
        }
        Err(_) => return Ok(()), // keep raw base64; path restore is best-effort
    };
    let engine_data2 = match decode_engine_data2_with_limit(&engine_data, max_depth) {
        Ok(v) => v,
        Err(error) if error.0.contains("recursion depth") => {
            return Err(ReadError::RecursionLimitExceeded {
                observed: max_depth.saturating_add(1),
                limit: max_depth,
            });
        }
        Err(_) => return Ok(()),
    };
    let Some(resource) = engine_dict_get(&engine_data2, "ResourceDict") else {
        return Ok(());
    };
    let Some(EngineValue::Array(frames)) = engine_dict_get(resource, "TextFrameSet") else {
        return Ok(());
    };

    let mut by_index: Vec<Option<TextPath>> = Vec::with_capacity(frames.len());
    for frame in frames {
        let path = engine_dict_get(frame, "path").and_then(engine_value_to_text_path);
        by_index.push(path);
    }

    if let Some(children) = psd.children.as_mut() {
        assign_text_paths(children, &by_index);
    }
    Ok(())
}

fn assign_text_paths(layers: &mut [Layer], by_index: &[Option<TextPath>]) {
    for layer in layers {
        if let Some(text) = layer.additional_info.text.as_mut() {
            if let Some(idx) = text.index {
                if idx >= 0.0 && idx.is_finite() {
                    let i = idx as usize;
                    if let Some(Some(path)) = by_index.get(i) {
                        text.text_path = Some(path.clone());
                    }
                }
            }
        }
        if let Some(children) = layer.children.as_mut() {
            assign_text_paths(children, by_index);
        }
    }
}

fn engine_dict_get<'a>(v: &'a EngineValue, key: &str) -> Option<&'a EngineValue> {
    match v {
        EngineValue::Dict(m) => m.iter().find(|(k, _)| k == key).map(|(_, v)| v),
        _ => None,
    }
}

fn engine_numbers(v: &EngineValue) -> Vec<f64> {
    match v {
        EngineValue::Array(arr) => arr
            .iter()
            .filter_map(|x| match x {
                EngineValue::Number(n) => Some(*n),
                _ => None,
            })
            .collect(),
        EngineValue::Number(n) => vec![*n],
        _ => Vec::new(),
    }
}

fn engine_value_to_atom(v: &EngineValue) -> Option<TextPathAtom> {
    match v {
        EngineValue::Bool(b) => Some(TextPathAtom::Bool(*b)),
        EngineValue::Number(n) => Some(TextPathAtom::Number(*n)),
        EngineValue::Str(s) => Some(TextPathAtom::Str(s.clone())),
        EngineValue::Array(arr) if arr.iter().all(|x| matches!(x, EngineValue::Number(_))) => {
            Some(TextPathAtom::Numbers(engine_numbers(v)))
        }
        _ => None,
    }
}

fn engine_value_to_text_path(path: &EngineValue) -> Option<TextPath> {
    let EngineValue::Dict(_) = path else {
        return None;
    };

    let mut tp = TextPath::default();

    if let Some(name_v) = engine_dict_get(path, "name") {
        let nums = engine_numbers(name_v);
        if !nums.is_empty() {
            tp.name = Some(nums);
        }
    }

    if let Some(bc) = engine_dict_get(path, "bezierCurve") {
        if let Some(cp) = engine_dict_get(bc, "controlPoints") {
            let control_points = engine_numbers(cp);
            if !control_points.is_empty() {
                tp.bezier_curve = Some(TextPathBezierCurve { control_points });
            }
        }
    }

    if let Some(uuid) = engine_dict_get(path, "uuid") {
        if let EngineValue::Str(s) = uuid {
            tp.uuid = Some(s.clone());
        }
    }

    if let Some(data_v) = engine_dict_get(path, "data") {
        tp.data = engine_value_to_text_path_data(data_v);
    }

    Some(tp)
}

fn engine_value_to_text_path_data(data: &EngineValue) -> TextPathData {
    let mut out = TextPathData::default();
    let EngineValue::Dict(_) = data else {
        return out;
    };

    if let Some(EngineValue::Number(n)) = engine_dict_get(data, "type") {
        out.path_type = Some(*n);
    }
    if let Some(EngineValue::Number(n)) = engine_dict_get(data, "orientation") {
        out.orientation = Some(*n);
    }
    if let Some(v) = engine_dict_get(data, "frameMatrix") {
        out.frame_matrix = engine_numbers(v);
    }
    if let Some(v) = engine_dict_get(data, "textRange") {
        out.text_range = engine_numbers(v);
    }
    if let Some(EngineValue::Number(n)) = engine_dict_get(data, "rowGutter") {
        out.row_gutter = Some(*n);
    }
    if let Some(EngineValue::Number(n)) = engine_dict_get(data, "columnGutter") {
        out.column_gutter = Some(*n);
    }
    if let Some(ba) = engine_dict_get(data, "baselineAlignment") {
        let mut alignment = TextPathBaselineAlignment::default();
        if let Some(EngineValue::Number(n)) = engine_dict_get(ba, "flag") {
            alignment.flag = Some(*n);
        }
        if let Some(EngineValue::Number(n)) = engine_dict_get(ba, "min") {
            alignment.min = Some(*n);
        }
        out.baseline_alignment = Some(alignment);
    }
    if let Some(pd) = engine_dict_get(data, "pathData") {
        out.path_data = engine_value_to_path_data(pd);
    }
    out
}

fn engine_value_to_path_data(pd: &EngineValue) -> TextPathPathData {
    let mut out = TextPathPathData::default();
    let EngineValue::Dict(map) = pd else {
        return out;
    };
    for (key, value) in map {
        match key.as_str() {
            "reversed" => {
                if let EngineValue::Bool(b) = value {
                    out.reversed = Some(*b);
                }
            }
            "spacing" => {
                if let EngineValue::Number(n) = value {
                    out.spacing = Some(*n);
                }
            }
            _ => {
                if let Some(atom) = engine_value_to_atom(value) {
                    out.extra.insert(key.clone(), atom);
                }
            }
        }
    }
    out
}
