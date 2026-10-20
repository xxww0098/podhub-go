/*
File: rust/crates/psd-x/src/text_edit/mod.rs

Purpose:
Document-rooted text edit session: box-text
`set_text` / `set_text_reflow` / `set_run_text`, whole-layer style setters with
base⊕run merge rules, immediate hazard close-out (Txt2 drop, raster policy,
inherited-font precondition) and immediate UTF-16 run-length repair. No
upstream counterpart.

Source compatibility:
- no-upstream-counterpart
*/

//! Text editing session for an in-memory [`crate::psd::Psd`].
//!
//! # Hazards closed on each mutating edit
//!
//! - Document-level `Txt2` / `engine_data` blob is cleared on the **first**
//!   mutation (same bytes as `WriteOptions::invalidate_text_layers`, but owned
//!   by the session so it cannot be forgotten).
//! - Layer raster follows the required [`RasterPolicy`] (Drop reuses
//!   [`crate::edit::drop_layer_preview`]).
//! - Session construction requires [`FontResolution::Resolved`] — the caller
//!   must have read with inherited fonts resolved (default read, or
//!   `ReadOptions::resolve_inherited_fonts = Some(true)`).
//! - Style / paragraph run lengths are repaired **immediately** in the model
//!   (`sum(lengths) == text` in UTF-16 code units) — not deferred to encode.
//!
//! There is **no** `commit()`. `finish` is diagnostic only.
//!
//! ## String edits and geometry honesty
//!
//! [`TextLayer::set_text`], [`TextLayer::set_text_reflow`], and
//! [`TextLayer::set_run_text`] accept **point** and **box** text
//! (`TextShapeType::Point` / `Box`). Missing `shape_type` is an error — it is
//! **not** silently treated as point text.
//!
//! After a real string change on **point text**, optional ink-measurement
//! fields that psdx cannot recompute (text-space rect, bounds, bounding box)
//! are cleared to `None` rather than left stale. Under [`RasterPolicy::Leave`],
//! the layer document bounds are cleared too and any remaining raster is
//! dropped so pixels never sit without geometry. [`RasterPolicy::Drop`] and
//! [`RasterPolicy::Provide`] keep the layer document bounds that position the
//! just-applied preview. **Box text** keeps author-defined box geometry
//! (`box_bounds`, `transform`, text rect).
//!
//! Style setters ([`TextLayer::set_font`] and friends) do **not** clear
//! geometry — only string mutations do.
//!
//! ## Error contract
//!
//! If any public mutation on [`TextLayer`] returns [`Err`], that attempted
//! mutation is unapplied: the in-memory [`crate::psd::Psd`] is observably
//! unchanged from immediately before the call. Successful earlier mutations
//! in the same [`TextEdit`] session remain intact; [`TextEdit::finish`] stays
//! diagnostic and is not a commit boundary.
//!
//! This is an in-memory editing guarantee, not a filesystem transaction or an
//! undo/redo history. It does not cover callers that bypass this module and
//! directly mutate the low-level serialization model.
//!
//! ## Known upstream write behavior (not introduced by editing)
//!
//! The text engine drops one transform component on decode and always re-emits
//! an identity value on write, so **any** write — edited or not — loses
//! rotate/skew on text layers. Module docs do not promise otherwise.
//!
//! Point-text outer bounds cannot be recomputed without a font rasterizer;
//! callers must supply preview pixels or accept absent/stale layer rects.
//! Whether cleared measurement fields are recomputed is
//! **UNVERIFIED in Photoshop**.
//!
//! [`RasterPolicy`] behavior (especially Drop update dialogs) is
//! **UNVERIFIED in Photoshop**.
//!
//! Path text (`textPath.data.type == 2`) is refused at `begin` because the path
//! lives only in the blob being dropped.

mod geometry;
mod style;

mod runs;

pub use geometry::{ClearedTextGeometryField, TextGeometryHonestyReport};

use crate::edit::{
    DropLayerPreviewError, PreparedLayerPreview, prepare_layer_preview_change,
    prepare_layer_preview_drop,
};
use crate::psd::{ColorMode, Layer, LayerTextData, PixelData, Psd, TextShapeType, TextStyle};
use thiserror::Error;

/// Proof that inherited fonts were resolved when the document was read.
///
/// Not stored on [`Psd`] (the model takes no new serializable fields). Callers
/// pass [`FontResolution::Resolved`] after reading with inherited fonts
/// resolved (default read, or `resolve_inherited_fonts: Some(true)`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FontResolution {
    /// Document was read with inherited fonts resolved (default or explicit).
    Resolved,
    /// Fonts were **not** resolved (`resolve_inherited_fonts: Some(false)`) —
    /// [`TextEdit::begin`] rejects this.
    Unresolved,
}

/// What to do with the edited layer's raster preview (required; no default).
#[derive(Debug, Clone)]
pub enum RasterPolicy {
    /// Keep existing layer pixels (may be stale relative to the new text).
    Leave,
    /// Install caller-provided preview pixels on the edited layer.
    Provide(PixelData),
    /// Transparent preview at the layer's real bounds ([`drop_layer_preview`]).
    Drop,
}

/// Errors from the text-edit session.
#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum TextEditError {
    /// [`FontResolution::Unresolved`] — editing would be destructive.
    #[error(
        "text edit requires FontResolution::Resolved \
         (read with inherited fonts resolved — default or \
         ReadOptions::resolve_inherited_fonts = Some(true))"
    )]
    FontsNotResolved,
    /// v1 editing is RGB-only (channel layout / zero-size shape differ otherwise).
    #[error("{}", match .0 {
        Some(mode) => format!("text edit requires an RGB document, got color mode {mode:?}"),
        None => "text edit requires an RGB document, but color mode is unset".to_owned(),
    })]
    UnsupportedColorMode(Option<ColorMode>),
    /// Document has at least one path-text layer; dropping Txt2 loses the path.
    #[error(
        "document contains path text; dropping the doc-level text blob \
         would permanently lose the path (no Txt2 encoder yet)"
    )]
    PathTextPresent,
    /// No text layer at the given path / name.
    #[error("text layer not found")]
    LayerNotFound,
    /// Layer exists but is not a text layer.
    #[error("layer is not a text layer")]
    NotATextLayer,
    /// String setters require `shapeType` (`point` or `box`); missing is not point.
    #[error(
        "text string setters require shapeType (point or box); \
         missing shapeType is not treated as point text"
    )]
    MissingShapeType,
    /// [`TextLayer::set_run_text`] needs an existing style-run list.
    #[error("set_run_text requires an existing style_runs list on the layer")]
    NoStyleRuns,
    /// Style-run index is outside `style_runs`.
    #[error("style run index {index} out of bounds (style_runs len {len})")]
    RunIndexOutOfBounds { index: usize, len: usize },
    /// A style-run UTF-16 range is out of bounds or splits a surrogate pair.
    #[error("style run UTF-16 range {start}..{end} is invalid for the text")]
    InvalidUtf16RunRange { start: usize, end: usize },
    /// [`RasterPolicy::Drop`] failed.
    #[error("raster policy failed: {0}")]
    Raster(String),
    /// Color kind that EngineData encode would silently degrade to transparent black.
    #[error(
        "unsupported text fill color type (FRGB/HSB/LAB); \
         EngineData encode would silently write transparent black"
    )]
    UnsupportedTextColor,
    /// [`TextLayer::effective_style`] / run indexing out of range.
    #[error("style run index {index} out of bounds (count {count})")]
    StyleRunOutOfBounds { index: usize, count: usize },
}

impl From<DropLayerPreviewError> for TextEditError {
    fn from(err: DropLayerPreviewError) -> Self {
        TextEditError::Raster(err.to_string())
    }
}

/// Diagnostic summary from [`TextEdit::finish`]. Correctness does not depend
/// on calling finish.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct TextEditReport {
    /// How many mutating edits succeeded (no-ops excluded).
    pub mutations: usize,
    /// Whether the document-level EngineData2 blob was cleared.
    pub doc_text_blob_dropped: bool,
    /// Per-layer geometry honesty from string mutations (shape type + cleared fields).
    pub geometry_honesty: Vec<TextGeometryHonestyReport>,
}

/// Document-rooted text edit session.
pub struct TextEdit<'a> {
    psd: &'a mut Psd,
    raster: RasterPolicy,
    report: TextEditReport,
}

/// Handle to one text layer inside a [`TextEdit`] session.
pub struct TextLayer<'a> {
    psd: &'a mut Psd,
    raster: &'a RasterPolicy,
    report: &'a mut TextEditReport,
    path: Vec<usize>,
}

impl<'a> TextEdit<'a> {
    /// Open a text-edit session.
    ///
    /// `fonts` must be [`FontResolution::Resolved`]. `raster` has no default —
    /// the caller must decide Leave / Provide / Drop.
    pub fn begin(
        psd: &'a mut Psd,
        raster: RasterPolicy,
        fonts: FontResolution,
    ) -> Result<Self, TextEditError> {
        if fonts != FontResolution::Resolved {
            return Err(TextEditError::FontsNotResolved);
        }
        if psd.color_mode != Some(ColorMode::Rgb) {
            return Err(TextEditError::UnsupportedColorMode(psd.color_mode));
        }
        if document_has_path_text(psd) {
            return Err(TextEditError::PathTextPresent);
        }

        Ok(Self {
            psd,
            raster,
            report: TextEditReport::default(),
        })
    }

    /// Text layer at a child-index path under `psd.children` (e.g. `&[1]`).
    pub fn layer_at(&mut self, path: &[usize]) -> Result<TextLayer<'_>, TextEditError> {
        {
            let layer = layer_at_path(self.psd, path).ok_or(TextEditError::LayerNotFound)?;
            if layer.additional_info.text.is_none() {
                return Err(TextEditError::NotATextLayer);
            }
        }
        Ok(TextLayer {
            psd: self.psd,
            raster: &self.raster,
            report: &mut self.report,
            path: path.to_vec(),
        })
    }

    /// First text layer whose `additional_info.name` equals `name`.
    pub fn layer_named(&mut self, name: &str) -> Result<TextLayer<'_>, TextEditError> {
        let path = find_text_layer_named(self.psd, name).ok_or(TextEditError::LayerNotFound)?;
        self.layer_at(&path)
    }

    /// Paths of every text layer (depth-first). Use [`TextEdit::layer_at`] for
    /// a mutable handle — Rust cannot yield multiple overlapping `&mut`
    /// [`TextLayer`] values from one iterator.
    pub fn text_layers(&mut self) -> impl Iterator<Item = Vec<usize>> + '_ {
        collect_text_layer_paths(self.psd).into_iter()
    }

    /// Diagnostic only — does not affect correctness.
    pub fn finish(self) -> TextEditReport {
        self.report
    }
}

impl TextLayer<'_> {
    /// Child-index path of this layer under `psd.children`.
    pub fn path(&self) -> &[usize] {
        &self.path
    }

    /// Current text string (model value, not EngineData-normalized).
    pub fn text(&self) -> Result<String, TextEditError> {
        let layer = layer_at_path(self.psd, &self.path).ok_or(TextEditError::LayerNotFound)?;
        let text = layer
            .additional_info
            .text
            .as_ref()
            .ok_or(TextEditError::NotATextLayer)?;
        Ok(text.text.clone())
    }

    /// Whole-string replace: collapse style runs to the effective base style.
    ///
    /// No-op when `new_text` equals the current model string (no Txt2 drop, no
    /// style collapse, no raster change) — required for byte-identical round
    /// trips against `expected.psd`.
    pub fn set_text(&mut self, new_text: &str) -> Result<(), TextEditError> {
        if self.string_edit_text()?.text == new_text {
            return Ok(());
        }
        let mut prepared = self.prepare_string_mutation()?;
        let shape_type = prepared
            .text
            .shape_type
            .expect("checked during preparation");
        {
            let text = prepared.text_mut();
            let base = effective_base_style(text);
            text.text = new_text.to_string();
            text.style = Some(base);
            text.style_runs = None;
            text.paragraph_style_runs = None;
        }
        prepared.apply(self, shape_type)
    }

    /// Whole-string replace that **keeps** style-run boundaries.
    ///
    /// Clamps/drops out-of-range runs; when the string grows, **extends the
    /// last run** (Photoshop) rather than appending a base-style run. Run
    /// lengths are written back immediately so
    /// `sum(run.length) == utf16_len(text)` before any write.
    ///
    /// No-op when `new_text` equals the current model string.
    pub fn set_text_reflow(&mut self, new_text: &str) -> Result<(), TextEditError> {
        if self.string_edit_text()?.text == new_text {
            return Ok(());
        }
        let mut prepared = self.prepare_string_mutation()?;
        let shape_type = prepared
            .text
            .shape_type
            .expect("checked during preparation");
        {
            let text = prepared.text_mut();
            text.text = new_text.to_string();
            let target = runs::utf16_len(&text.text);
            runs::reflow_style_runs(&mut text.style_runs, target);
            runs::reflow_paragraph_runs(&mut text.paragraph_style_runs, target);
        }
        prepared.apply(self, shape_type)
    }

    /// Replace the text of one style run; other runs' lengths and styles stay
    /// byte-identical. Updates that run's length immediately (UTF-16 units) and
    /// reflows paragraph runs to the new total length.
    ///
    /// No-op when `new_run_text` equals that run's current slice.
    pub fn set_run_text(
        &mut self,
        run_index: usize,
        new_run_text: &str,
    ) -> Result<(), TextEditError> {
        let (start, end) = self.run_range(run_index)?;
        let current = runs::slice_utf16(&self.string_edit_text()?.text, start, end)
            .ok_or(TextEditError::InvalidUtf16RunRange { start, end })?;
        if current == new_run_text {
            return Ok(());
        }

        let mut prepared = self.prepare_string_mutation()?;
        let shape_type = prepared
            .text
            .shape_type
            .expect("checked during preparation");
        {
            let text = prepared.text_mut();
            let (start, old_len) = {
                let runs_list = text.style_runs.as_ref().ok_or(TextEditError::NoStyleRuns)?;
                if run_index >= runs_list.len() {
                    return Err(TextEditError::RunIndexOutOfBounds {
                        index: run_index,
                        len: runs_list.len(),
                    });
                }
                let start: usize = runs_list[..run_index]
                    .iter()
                    .map(|r| runs::length_units(r.length))
                    .sum();
                let old_len = runs::length_units(runs_list[run_index].length);
                (start, old_len)
            };
            let end = start + old_len;
            text.text = runs::replace_utf16_range(&text.text, start, end, new_run_text)
                .ok_or(TextEditError::InvalidUtf16RunRange { start, end })?;
            if let Some(runs_list) = text.style_runs.as_mut() {
                runs_list[run_index].length = runs::utf16_len(new_run_text) as f64;
            }
            runs::compact_style_runs(&mut text.style_runs);

            let target = runs::utf16_len(&text.text);
            // Style-run lengths already match after the single-run update (+ compact).
            // Paragraph runs still need the shared extend-last / clamp repair.
            runs::reflow_paragraph_runs(&mut text.paragraph_style_runs, target);

            debug_assert!(
                text.style_runs
                    .as_ref()
                    .map(|r| runs::style_run_lengths_sum(r) == target)
                    .unwrap_or(target == 0),
                "style run lengths must match text UTF-16 length after set_run_text"
            );
        }
        prepared.apply(self, shape_type)
    }

    fn prepare_string_mutation(&self) -> Result<PreparedTextStringMutation, TextEditError> {
        let layer = layer_at_path(self.psd, &self.path).ok_or(TextEditError::LayerNotFound)?;
        let text = self.string_edit_text()?;
        let raster = prepare_raster_policy(layer, self.psd.color_mode, self.raster)?;
        let mut text = text.clone();
        normalize_empty_style_lists(&mut text);
        Ok(PreparedTextStringMutation { text, raster })
    }

    fn string_edit_text(&self) -> Result<&LayerTextData, TextEditError> {
        let layer = layer_at_path(self.psd, &self.path).ok_or(TextEditError::LayerNotFound)?;
        let text = layer
            .additional_info
            .text
            .as_ref()
            .ok_or(TextEditError::NotATextLayer)?;
        match text.shape_type {
            Some(TextShapeType::Point) | Some(TextShapeType::Box) => Ok(text),
            None => Err(TextEditError::MissingShapeType),
        }
    }

    fn run_range(&self, run_index: usize) -> Result<(usize, usize), TextEditError> {
        let text = self.string_edit_text()?;
        let runs_list = text.style_runs.as_ref().ok_or(TextEditError::NoStyleRuns)?;
        if run_index >= runs_list.len() {
            return Err(TextEditError::RunIndexOutOfBounds {
                index: run_index,
                len: runs_list.len(),
            });
        }
        let start: usize = runs_list[..run_index]
            .iter()
            .map(|run| runs::length_units(run.length))
            .sum();
        let end = start.saturating_add(runs::length_units(runs_list[run_index].length));
        if end > runs::utf16_len(&text.text) {
            return Err(TextEditError::InvalidUtf16RunRange { start, end });
        }
        Ok((start, end))
    }

    fn prepare_style_mutation(&self) -> Result<PreparedTextStyleMutation, TextEditError> {
        let layer = layer_at_path(self.psd, &self.path).ok_or(TextEditError::LayerNotFound)?;
        let text = layer
            .additional_info
            .text
            .as_ref()
            .ok_or(TextEditError::NotATextLayer)?;
        let raster = prepare_raster_policy(layer, self.psd.color_mode, self.raster)?;
        let mut text = text.clone();
        normalize_empty_style_lists(&mut text);
        Ok(PreparedTextStyleMutation { text, raster })
    }
}

struct PreparedTextStringMutation {
    text: LayerTextData,
    raster: Option<PreparedLayerPreview>,
}

impl PreparedTextStringMutation {
    fn text_mut(&mut self) -> &mut LayerTextData {
        &mut self.text
    }

    fn apply(
        self,
        edit: &mut TextLayer<'_>,
        shape_type: TextShapeType,
    ) -> Result<(), TextEditError> {
        let layer = layer_at_path_mut(edit.psd, &edit.path).ok_or(TextEditError::LayerNotFound)?;
        layer.additional_info.text = Some(self.text);
        if let Some(raster) = self.raster {
            raster.apply(layer);
        }
        let cleared_fields = match shape_type {
            TextShapeType::Point => match edit.raster {
                // Leave kept the old raster; clearing unrecomputable layer bounds
                // would leave pixels without geometry — drop the stale raster too.
                RasterPolicy::Leave => {
                    let cleared = geometry::clear_point_text_geometry(layer);
                    geometry::clear_stale_point_text_raster(layer);
                    cleared
                }
                // Drop/Provide just installed a positioned preview; keep layer
                // document bounds and clear only text-space measurements.
                RasterPolicy::Drop | RasterPolicy::Provide(_) => {
                    geometry::clear_point_text_measurements(layer)
                }
            },
            TextShapeType::Box => Vec::new(),
        };

        if edit.psd.additional_info.engine_data.is_some() {
            edit.psd.additional_info.engine_data = None;
            edit.report.doc_text_blob_dropped = true;
        }
        edit.report
            .geometry_honesty
            .push(TextGeometryHonestyReport {
                layer_path: edit.path.clone(),
                shape_type,
                cleared_fields,
            });
        edit.report.mutations += 1;
        Ok(())
    }
}

struct PreparedTextStyleMutation {
    text: LayerTextData,
    raster: Option<PreparedLayerPreview>,
}

impl PreparedTextStyleMutation {
    fn text_mut(&mut self) -> &mut LayerTextData {
        &mut self.text
    }

    fn apply(self, edit: &mut TextLayer<'_>) -> Result<(), TextEditError> {
        let layer = layer_at_path_mut(edit.psd, &edit.path).ok_or(TextEditError::LayerNotFound)?;
        layer.additional_info.text = Some(self.text);
        if let Some(raster) = self.raster {
            raster.apply(layer);
        }
        if edit.psd.additional_info.engine_data.is_some() {
            edit.psd.additional_info.engine_data = None;
            edit.report.doc_text_blob_dropped = true;
        }
        edit.report.mutations += 1;
        Ok(())
    }
}

fn prepare_raster_policy(
    layer: &Layer,
    color_mode: Option<ColorMode>,
    raster: &RasterPolicy,
) -> Result<Option<PreparedLayerPreview>, TextEditError> {
    let prepared = match raster {
        RasterPolicy::Leave => return Ok(None),
        RasterPolicy::Provide(pixels) => prepare_layer_preview_change(layer, |prepared| {
            prepared.raw_data = None;
            prepared.canvas = None;
            prepared.image_data = Some(pixels.clone());
            Ok::<(), TextEditError>(())
        })?,
        RasterPolicy::Drop => prepare_layer_preview_drop(layer, color_mode)?,
    };
    Ok(Some(prepared))
}

/// Effective base style for a whole-string collapse: keep the decoded base,
/// fill a missing font from the first run that carries one.
fn effective_base_style(text: &LayerTextData) -> TextStyle {
    let mut style = text.style.clone().unwrap_or_default();
    if style.font.is_none() {
        if let Some(runs) = text.style_runs.as_ref() {
            for run in runs {
                if run.style.font.is_some() {
                    style.font = run.style.font.clone();
                    break;
                }
            }
        }
    }
    style
}

/// EngineData2 frame path type 2 = text on a path (see `text-path` fixture).
fn is_path_text(text: &LayerTextData) -> bool {
    text.text_path
        .as_ref()
        .and_then(|p| p.data.path_type)
        .is_some_and(|t| (t - 2.0).abs() < f64::EPSILON)
}

fn document_has_path_text(psd: &Psd) -> bool {
    fn walk(layers: &[Layer]) -> bool {
        for layer in layers {
            if let Some(text) = layer.additional_info.text.as_ref() {
                if is_path_text(text) {
                    return true;
                }
            }
            if let Some(children) = layer.children.as_ref() {
                if walk(children) {
                    return true;
                }
            }
        }
        false
    }
    psd.children.as_ref().is_some_and(|c| walk(c))
}

fn normalize_empty_style_lists(text: &mut LayerTextData) {
    if text.style_runs.as_ref().is_some_and(|runs| runs.is_empty()) {
        text.style_runs = None;
    }
    if text
        .paragraph_style_runs
        .as_ref()
        .is_some_and(|runs| runs.is_empty())
    {
        text.paragraph_style_runs = None;
    }
}

fn layer_at_path<'b>(psd: &'b Psd, path: &[usize]) -> Option<&'b Layer> {
    let mut layers = psd.children.as_ref()?;
    let mut current: Option<&Layer> = None;
    for (depth, &idx) in path.iter().enumerate() {
        current = layers.get(idx);
        let layer = current?;
        if depth + 1 < path.len() {
            layers = layer.children.as_ref()?;
        }
    }
    current
}

fn layer_at_path_mut<'b>(psd: &'b mut Psd, path: &[usize]) -> Option<&'b mut Layer> {
    let children = psd.children.as_mut()?;
    layer_at_indices_mut(children, path)
}

fn layer_at_indices_mut<'b>(layers: &'b mut [Layer], path: &[usize]) -> Option<&'b mut Layer> {
    match path {
        [] => None,
        [idx] => layers.get_mut(*idx),
        [idx, rest @ ..] => {
            let layer = layers.get_mut(*idx)?;
            let children = layer.children.as_mut()?;
            layer_at_indices_mut(children, rest)
        }
    }
}

fn find_text_layer_named(psd: &Psd, name: &str) -> Option<Vec<usize>> {
    fn walk(layers: &[Layer], prefix: &mut Vec<usize>, name: &str) -> Option<Vec<usize>> {
        for (i, layer) in layers.iter().enumerate() {
            prefix.push(i);
            if layer.additional_info.text.is_some()
                && layer.additional_info.name.as_deref() == Some(name)
            {
                return Some(prefix.clone());
            }
            if let Some(children) = layer.children.as_ref() {
                if let Some(found) = walk(children, prefix, name) {
                    return Some(found);
                }
            }
            prefix.pop();
        }
        None
    }
    let children = psd.children.as_ref()?;
    walk(children, &mut Vec::new(), name)
}

fn collect_text_layer_paths(psd: &Psd) -> Vec<Vec<usize>> {
    fn walk(layers: &[Layer], prefix: &mut Vec<usize>, out: &mut Vec<Vec<usize>>) {
        for (i, layer) in layers.iter().enumerate() {
            prefix.push(i);
            if layer.additional_info.text.is_some() {
                out.push(prefix.clone());
            }
            if let Some(children) = layer.children.as_ref() {
                walk(children, prefix, out);
            }
            prefix.pop();
        }
    }
    let mut out = Vec::new();
    if let Some(children) = psd.children.as_ref() {
        walk(children, &mut Vec::new(), &mut out);
    }
    out
}

#[cfg(test)]
mod session_tests;
