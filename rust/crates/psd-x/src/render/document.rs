use crate::composite::PixelRect;
use crate::psd::{Layer, Psd};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SkipReason {
    Hidden,
    Clipping,
    Empty,
    NotSelected,
    /// Top-level layer is not a group; Export As only emits groups.
    NotAGroup,
}

#[derive(Debug)]
pub struct PlannedGroup<'a> {
    pub top_level_index: usize,
    pub name: String,
    pub layer: &'a Layer,
    pub bounds: PixelRect,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SkippedGroup {
    pub top_level_index: usize,
    pub name: String,
    pub reason: SkipReason,
}

#[derive(Debug)]
pub struct ExportPlan<'a> {
    pub groups: Vec<PlannedGroup<'a>>,
    pub skipped: Vec<SkippedGroup>,
}

fn layer_name(layer: &Layer, ordinal: usize) -> String {
    layer
        .additional_info
        .name
        .as_deref()
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .map(str::to_owned)
        .unwrap_or_else(|| format!("group-{ordinal}"))
}

fn loose_layer_name(layer: &Layer, top_level_index: usize) -> String {
    layer
        .additional_info
        .name
        .as_deref()
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .map(str::to_owned)
        .unwrap_or_else(|| format!("layer-{top_level_index}"))
}

fn grow(bounds: &mut Option<(f64, f64, f64, f64)>, layer: &Layer) {
    if layer.hidden.unwrap_or(false) {
        return;
    }
    if let Some(children) = &layer.children {
        for child in children {
            grow(bounds, child);
        }
        return;
    }
    // Match the compositor: a layer without position does not contribute to the
    // group rectangle (and will not be drawn at the origin either).
    let (Some(left), Some(top)) = (layer.left, layer.top) else {
        return;
    };
    let right = layer.right.unwrap_or(left);
    let bottom = layer.bottom.unwrap_or(top);
    if right <= left || bottom <= top {
        return;
    }
    match bounds {
        Some((old_left, old_top, old_right, old_bottom)) => {
            *old_left = old_left.min(left);
            *old_top = old_top.min(top);
            *old_right = old_right.max(right);
            *old_bottom = old_bottom.max(bottom);
        }
        None => *bounds = Some((left, top, right, bottom)),
    }
}

fn group_bounds(layer: &Layer, document_width: u32, document_height: u32) -> Option<PixelRect> {
    let mut bounds = None;
    grow(&mut bounds, layer);
    let (left, top, right, bottom) = bounds?;
    let left = left.floor().clamp(0.0, document_width as f64) as i32;
    let top = top.floor().clamp(0.0, document_height as f64) as i32;
    let right = right.ceil().clamp(0.0, document_width as f64) as i32;
    let bottom = bottom.ceil().clamp(0.0, document_height as f64) as i32;
    (right > left && bottom > top).then_some(PixelRect {
        left,
        top,
        width: (right - left) as u32,
        height: (bottom - top) as u32,
    })
}

pub fn plan_top_level_groups<'a>(psd: &'a Psd, selected: Option<&[usize]>) -> ExportPlan<'a> {
    let mut groups = Vec::new();
    let mut skipped = Vec::new();
    let width = psd.width.max(0.0) as u32;
    let height = psd.height.max(0.0) as u32;
    let mut group_ordinal = 0;
    // Parsed children retain bottom-to-top compositing order. Export As is a
    // user-facing projection and follows the PSD panel from top to bottom.
    for (top_level_index, layer) in psd
        .children
        .as_deref()
        .unwrap_or_default()
        .iter()
        .enumerate()
        .rev()
    {
        if layer.children.is_none() {
            skipped.push(SkippedGroup {
                top_level_index,
                name: loose_layer_name(layer, top_level_index),
                reason: SkipReason::NotAGroup,
            });
            continue;
        }
        group_ordinal += 1;
        let name = layer_name(layer, group_ordinal);
        let reason = if selected.is_some_and(|indices| !indices.contains(&top_level_index)) {
            Some(SkipReason::NotSelected)
        } else if layer.hidden.unwrap_or(false) {
            Some(SkipReason::Hidden)
        } else if layer.clipping.unwrap_or(false) {
            Some(SkipReason::Clipping)
        } else {
            None
        };
        if let Some(reason) = reason {
            skipped.push(SkippedGroup {
                top_level_index,
                name,
                reason,
            });
            continue;
        }
        let Some(bounds) = group_bounds(layer, width, height) else {
            skipped.push(SkippedGroup {
                top_level_index,
                name,
                reason: SkipReason::Empty,
            });
            continue;
        };
        groups.push(PlannedGroup {
            top_level_index,
            name,
            layer,
            bounds,
        });
    }
    ExportPlan { groups, skipped }
}
