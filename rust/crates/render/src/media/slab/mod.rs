use crate::media::capability::preflight_render_capabilities;
use crate::media::document::{
    LinkedSourceCache, PlacedPrepCache, RenderDocumentOptions, render_document_prepared,
};
use crate::media::encode::RgbaRows;
use crate::media::error::{MediaError, MediaErrorCode};
use crate::media::intent::ExportBounds;
use crate::media::model::ExportGroup;
use crate::media::raster::{Backdrop, Rect, append_backdrop_bytes, backdrop_to_bytes};
use crate::psd::{LayerNode, RenderDocument, SourceContent};
use psdx::reader::ReadCancellationToken;
use std::cell::RefCell;
use std::collections::HashMap;
use std::sync::Arc;

pub(super) const DEFAULT_SLAB_ROWS: u32 = 128;
const RESAMPLE_HALO_ROWS: u32 = 1;

/// Fraction of the live-byte ceiling the per-group placed preparation cache
/// may hold, expressed as its divisor. Defined once here and consumed at the
/// single construction site below.
pub(super) const PLACED_PREP_DIVISOR: u64 = 4;

/// Fraction of the live-byte ceiling the per-render linked source memo may
/// hold, expressed as its divisor. Defined once here and consumed at its
/// single construction site in `render.rs`.
pub(super) const LINKED_MEMO_DIVISOR: u64 = 8;

/// Opening of the linked-memo degradation report. The memo is per render, so
/// every group restates the same running total and the render keeps only the
/// most recent line.
pub(super) const LINKED_MEMO_REPORT_PREFIX: &str = "linked source memo refused";

#[derive(Debug, Clone, Copy)]
pub(super) struct SlabConfig {
    pub rows: u32,
}

impl Default for SlabConfig {
    fn default() -> Self {
        Self {
            rows: DEFAULT_SLAB_ROWS,
        }
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(super) struct SlabObservations {
    pub reserved_bytes: u64,
    pub rows: u32,
    pub halo_rows: u32,
    /// The working set admission priced for this complete group task: shared
    /// resident bytes + slab reservation + placed preparation + linked memo +
    /// its retained reuse window. This is the left side of the sum compared
    /// against `max_parser_live_bytes`.
    pub working_set_bytes: u64,
    pub placed_prep_resident_bytes: u64,
    pub linked_memo_resident_bytes: u64,
    /// How many times the placed preparation cache discarded itself to stay
    /// inside its budget.
    pub placed_prep_drops: u32,
    /// How many linked sources the render memo refused to retain so far.
    pub linked_memo_refusals: u32,
    pub reuse_window_retained: bool,
    pub reuse_window_bytes: u64,
    /// One line per memory-driven downgrade taken while preparing this group.
    /// Shaped like psd-x's `memory_worker_cap` report (`render/mod.rs`): a
    /// silent cap makes peak-memory tuning opaque, so every cap says what it
    /// gave up and against which budget.
    pub degradations: Vec<String>,
}

/// The geometry and residency a live-byte ceiling has to cover for one group.
///
/// This is the single definition of the arithmetic behind the 103.2 MiB
/// live-byte ceiling; the expression lives here so changing any priced term
/// moves the number instead of silently invalidating it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) struct LiveCeilingInputs {
    pub document_width: u32,
    pub slab_rows: u32,
    pub halo_rows: u32,
    /// Height of the tallest exported group; the reuse window is one canvas
    /// width by this many rows of RGBA.
    pub group_height: u32,
    /// Reuse windows alive inside one group task. Group-level scheduling prices
    /// one complete task at a time and applies the memory fuse to task count.
    pub live_windows: u64,
    /// Parsed template and decoded design bytes shared by every group. Zero
    /// reproduces the original 103.2 MiB derivation, which omitted this term; a real
    /// render folds the shared resident inputs into the same sum.
    pub shared_resident_bytes: u64,
    /// Group levels nested inside the exported group, counted on the deepest path.
    /// Every one of them composites into its own full-width backdrop and then
    /// copies that backdrop into a byte buffer while blending it down, so each
    /// level is live at 20 bytes per pixel of one slab reservation. Zero describes
    /// a flat group whose layers are all leaves.
    pub nested_group_levels: u64,
}

/// The smallest `max_parser_live_bytes` at which slab admission still admits
/// `inputs` — the ceiling at which the sum is exactly saturated.
///
/// Admission compares `reservation + nested + placed_prep + linked_memo + windows +
/// shared resident` against `L`, where the two cache terms are themselves fractions
/// of `L`. Solving for `L`:
///
/// ```text
/// reservation + nested + L/PLACED_PREP_DIVISOR + L/LINKED_MEMO_DIVISOR
///     + windows + shared resident = L
/// L = (reservation + nested + windows + shared resident) / (1 - 1/4 - 1/8)
///   = (reservation + nested + windows + shared resident) * 8 / 5
/// ```
///
/// `nested` is one slab reservation per nested group level, because a nested
/// group's backdrop is a full-width band of the same height as the slab, held
/// alongside its byte copy while it is blended down.
///
/// Returns `None` when the geometry overflows, so callers cannot mistake an
/// overflowed ceiling for a small one.
pub(super) fn saturating_live_bytes(inputs: LiveCeilingInputs) -> Option<u64> {
    let reservation_bytes =
        slab_reservation_bytes(inputs.document_width, inputs.slab_rows, inputs.halo_rows).ok()?;
    let reservation = u128::from(reservation_bytes);
    // One nested group level is priced exactly like one slab reservation: the
    // level composites into a full-width backdrop of slab height and then copies
    // it, so it holds the same 20 bytes per pixel that the slab itself holds.
    let nested = reservation.checked_mul(u128::from(inputs.nested_group_levels))?;
    let window = u128::from(inputs.document_width)
        .checked_mul(u128::from(inputs.group_height))?
        .checked_mul(4)?;
    let windows = window.checked_mul(u128::from(inputs.live_windows))?;
    let fixed = reservation
        .checked_add(nested)?
        .checked_add(windows)?
        .checked_add(u128::from(inputs.shared_resident_bytes))?;
    // 1 - 1/p - 1/l as an exact rational: (p*l - l - p) / (p*l).
    let product = u128::from(PLACED_PREP_DIVISOR).checked_mul(u128::from(LINKED_MEMO_DIVISOR))?;
    let numerator = product
        .checked_sub(u128::from(LINKED_MEMO_DIVISOR))?
        .checked_sub(u128::from(PLACED_PREP_DIVISOR))?;
    if numerator == 0 {
        return None;
    }
    // Round up: a ceiling one byte short of the sum would be refused.
    let ceiling = fixed
        .checked_mul(product)?
        .checked_add(numerator - 1)?
        .checked_div(numerator)?;
    u64::try_from(ceiling).ok()
}

/// Deepest group nesting inside `root`, where a layer holding at least one child
/// counts as one level and the answer is the longest root-to-leaf chain of them.
///
/// This is the number of backdrops that can be live at the same time while the
/// subtree composites: each nested group composites its children into its own
/// backdrop before blending the result into its parent, so the chain is what
/// stacks up, not the total count of groups.
fn nested_group_levels(root: &LayerNode) -> u64 {
    fn deepest(layer: &LayerNode) -> u64 {
        let below = layer.children.iter().map(deepest).max().unwrap_or_default();
        if layer.is_group() { below + 1 } else { 0 }
    }
    // `root` is the exported group itself; its own backdrop is the slab
    // reservation already priced, so only what hangs below it is added here.
    deepest(root).saturating_sub(1)
}

/// Derives the full live-byte requirement of one independent top-level group.
///
/// This uses the exact geometry and capability halo that the allocator uses;
/// callers must not substitute a fixed policy ceiling and call it "per group".
pub(super) fn group_saturating_live_bytes(
    document: &RenderDocument,
    group: &ExportGroup,
    config: SlabConfig,
    shared_resident_bytes: u64,
) -> Result<u64, MediaError> {
    if config.rows == 0 {
        return Err(MediaError::new(
            MediaErrorCode::RequestInvalid,
            "slab-admission",
            "slab height must be at least one row",
        ));
    }
    let halo_rows = preflight_render_capabilities(document)?
        .max_halo_rows
        .max(RESAMPLE_HALO_ROWS);
    let group_height = u32::try_from(group.bounds.bottom - group.bounds.top).map_err(|_| {
        MediaError::new(
            MediaErrorCode::DimensionLimit,
            "slab-admission",
            "group height does not fit the renderer",
        )
    })?;
    let exported = document.children.get(group.layer_index).ok_or_else(|| {
        MediaError::new(
            MediaErrorCode::RequestInvalid,
            "slab-admission",
            "exported group is not in the layer tree",
        )
    })?;
    saturating_live_bytes(LiveCeilingInputs {
        document_width: document.width,
        slab_rows: config.rows,
        halo_rows,
        group_height,
        live_windows: 1,
        shared_resident_bytes,
        nested_group_levels: nested_group_levels(exported),
    })
    .ok_or_else(|| {
        MediaError::new(
            MediaErrorCode::DimensionLimit,
            "slab-admission",
            "group live-byte derivation overflowed",
        )
    })
}

#[derive(Debug, Clone)]
pub(super) struct PreparedSlabExport {
    pub export_rect: Rect,
    pub output_width: u32,
    pub output_height: u32,
    pub observations: SlabObservations,
    limits: crate::media::limits::RenderLimits,
    placed_prep: Arc<PlacedPrepCache>,
    /// Pass 1's converted RGBA rows for the whole group, retained only when
    /// the priced reuse window admits them. Rows span
    /// `group.bounds.top..group.bounds.bottom` at document width. `None`
    /// degrades pass 2 to the identical slab-refill path.
    reuse_rows: Option<Arc<Vec<u8>>>,
}

impl PreparedSlabExport {
    /// The retained pass-1 window, when admission priced it in.
    pub(super) fn reuse_window(&self) -> Option<Arc<Vec<u8>>> {
        self.reuse_rows.clone()
    }
}

/// The reuse window never exceeds one canvas of RGBA. The derived group live
/// ceiling, not an unrelated half-policy cap, admits the rest of its bytes.
/// A full-canvas window is still refused below so the no-full-frame invariant
/// remains truthful for single-group documents.
fn reuse_window_budget_bytes(policy: crate::psd::ProductResourcePolicy) -> u64 {
    policy.max_canvas_pixels.saturating_mul(4)
}

#[allow(clippy::too_many_arguments)]
pub(super) fn prepare_group_export(
    document: &RenderDocument,
    group: &ExportGroup,
    replacements: &HashMap<String, SourceContent>,
    export_bounds: ExportBounds,
    export_scale: f64,
    config: SlabConfig,
    policy: crate::psd::ProductResourcePolicy,
    cancellation: Option<&ReadCancellationToken>,
    linked: Option<&LinkedSourceCache>,
    resident_floor: u64,
) -> Result<PreparedSlabExport, MediaError> {
    if config.rows == 0 {
        return Err(MediaError::new(
            MediaErrorCode::RequestInvalid,
            "slab-admission",
            "slab height must be at least one row",
        ));
    }
    let capabilities = preflight_render_capabilities(document)?;
    let halo_rows = capabilities.max_halo_rows.max(RESAMPLE_HALO_ROWS);
    let reserved_bytes = slab_reservation_bytes(document.width, config.rows, halo_rows)?;
    if reserved_bytes > policy.max_parser_live_bytes as u64 {
        return Err(MediaError::resource_limit(
            MediaErrorCode::DimensionLimit,
            "slab-admission",
            u128::from(reserved_bytes),
            policy.max_parser_live_bytes as u128,
            policy,
        ));
    }

    let isolated = document
        .children
        .get(group.layer_index)
        .map(std::slice::from_ref)
        .unwrap_or_default();
    let limits = crate::media::limits::RenderLimits::from(policy);
    let placed_prep_started = crate::media::stage_timing::start();
    let placed_prep = Arc::new(PlacedPrepCache::build(
        document,
        isolated,
        replacements,
        (policy.max_parser_live_bytes as u64) / PLACED_PREP_DIVISOR,
        limits,
        0,
        &std::collections::BTreeSet::new(),
        linked,
    )?);
    crate::media::stage_timing::record(
        crate::media::stage_timing::Stage::PlacedPrep,
        placed_prep_started,
    );
    // Degradation ladder, step 1 of 3. Each step reports what it gave up and
    // against which budget; a silent cap makes peak-memory tuning opaque
    // (psd-x `render/mod.rs` `memory_worker_cap` sets the shape).
    let mut degradations = Vec::new();
    if placed_prep.drops() > 0 {
        degradations.push(format!(
            "placed preparation discarded {drops} time(s), the largest at {dropped} bytes, by the {budget} byte placed-prep budget; every placed layer is re-warped per slab",
            drops = placed_prep.drops(),
            dropped = placed_prep.dropped_bytes(),
            budget = placed_prep.budget_bytes(),
        ));
    }
    // Step 2. The memo is per render, so its refusal count is cumulative
    // across groups; the render folds these lines into one report.
    if let Some(cache) = linked
        && cache.refusals() > 0
    {
        degradations.push(format!(
            "{LINKED_MEMO_REPORT_PREFIX} {refusals} source(s) totalling {refused} bytes by the {budget} byte memo budget; each refused source is re-resolved for every group",
            refusals = cache.refusals(),
            refused = cache.refused_bytes(),
            budget = cache.budget_bytes(),
        ));
    }
    let resident_bytes = reserved_bytes
        .saturating_add(placed_prep.resident_bytes())
        .saturating_add(linked.map_or(0, LinkedSourceCache::resident_bytes))
        .saturating_add(resident_floor);
    if resident_bytes > policy.max_parser_live_bytes as u64 {
        return Err(MediaError::resource_limit(
            MediaErrorCode::DimensionLimit,
            "slab-admission",
            u128::from(resident_bytes),
            policy.max_parser_live_bytes as u128,
            policy,
        ));
    }

    // Pass 1 learns the alpha bounds by compositing the whole group once. When
    // the priced window admits the group's converted rows they are retained
    // whole, so pass 2 reads them back instead of compositing a second time.
    // Retention is all-or-nothing: a partial window would pay residency yet
    // still leave pass 2 recompositing, so an inadmissible group retains
    // nothing.
    let group_height = u64::try_from(group.bounds.bottom - group.bounds.top).unwrap_or_default();
    let window_bytes = u64::from(document.width)
        .saturating_mul(group_height)
        .saturating_mul(4);
    let full_frame_bytes = u64::from(document.width)
        .saturating_mul(u64::from(document.height))
        .saturating_mul(4);
    // Degradation ladder, step 3: the window is the only optional term, and
    // it is priced last because its admission depends on the sum of every
    // term already committed above. `refusal` names which condition refused
    // it, so "slower, not rejected" stops being invisible.
    let refusal = if window_bytes == 0 {
        Some("the group is empty".to_owned())
    } else if window_bytes >= full_frame_bytes {
        Some(format!(
            "a {window_bytes} byte window is the whole {full_frame_bytes} byte canvas"
        ))
    } else if window_bytes > reuse_window_budget_bytes(policy) {
        Some(format!(
            "a {window_bytes} byte window is over the {budget} byte reuse budget",
            budget = reuse_window_budget_bytes(policy),
        ))
    } else if resident_bytes.saturating_add(window_bytes) > policy.max_parser_live_bytes as u64 {
        Some(format!(
            "a {window_bytes} byte window would take the working set to {total} bytes, over the {live} byte live ceiling",
            total = resident_bytes.saturating_add(window_bytes),
            live = policy.max_parser_live_bytes,
        ))
    } else if usize::try_from(window_bytes).is_err() {
        Some(format!(
            "a {window_bytes} byte window does not fit in usize"
        ))
    } else {
        None
    };
    let mut window = if refusal.is_some() {
        None
    } else {
        let mut rows = Vec::new();
        if rows.try_reserve_exact(window_bytes as usize).is_err() {
            None
        } else {
            Some(rows)
        }
    };
    let refusal = refusal.or_else(|| {
        window
            .is_none()
            .then(|| format!("reserving {window_bytes} bytes failed"))
    });
    if let Some(reason) = refusal {
        degradations.push(format!(
            "group reuse window not retained: {reason}; pass 2 recomposites every slab instead of reading the retained rows"
        ));
    }
    let reuse_window_retained = window.is_some();

    let pass1_started = crate::media::stage_timing::start();
    let mut bounds: Option<Rect> = None;
    let mut top = group.bounds.top;
    while top < group.bounds.bottom {
        check_cancelled(cancellation, "render-pass-1")?;
        let bottom = (top + i64::from(config.rows)).min(group.bounds.bottom);
        let backdrop = render_group_slab(
            document,
            group,
            replacements,
            top,
            bottom,
            Some(&placed_prep),
            linked,
            limits,
        )?;
        union_alpha_bounds(&mut bounds, &backdrop, top);
        if let Some(rows) = window.as_mut() {
            append_backdrop_bytes(rows, &backdrop);
        }
        top = bottom;
    }
    crate::media::stage_timing::record(
        crate::media::stage_timing::Stage::Pass1Bounds,
        pass1_started,
    );
    let content = bounds.ok_or_else(|| {
        MediaError::new(
            MediaErrorCode::GroupTransparent,
            "render-pass-1",
            "group rendered fully transparent",
        )
    })?;
    let export_rect = match export_bounds {
        ExportBounds::Trim => content,
        ExportBounds::Canvas => Rect {
            left: 0,
            top: 0,
            width: document.width,
            height: document.height,
        },
    };
    let output_width = ((f64::from(export_rect.width)) * export_scale)
        .round()
        .max(1.0) as u32;
    let output_height = ((f64::from(export_rect.height)) * export_scale)
        .round()
        .max(1.0) as u32;
    if output_width > policy.max_output_side
        || output_height > policy.max_output_side
        || u64::from(output_width) * u64::from(output_height) > policy.max_output_pixels
    {
        return Err(MediaError::resource_limit(
            MediaErrorCode::DimensionLimit,
            "slab-export",
            u128::from(output_width)
                .saturating_mul(u128::from(output_height))
                .max(u128::from(output_width.max(output_height))),
            u128::from(policy.max_output_pixels),
            policy,
        ));
    }
    Ok(PreparedSlabExport {
        export_rect,
        output_width,
        output_height,
        limits,
        observations: SlabObservations {
            reserved_bytes,
            rows: config.rows,
            halo_rows,
            working_set_bytes: resident_bytes.saturating_add(if reuse_window_retained {
                window_bytes
            } else {
                0
            }),
            placed_prep_resident_bytes: placed_prep.resident_bytes(),
            linked_memo_resident_bytes: linked.map_or(0, LinkedSourceCache::resident_bytes),
            placed_prep_drops: placed_prep.drops(),
            linked_memo_refusals: linked.map_or(0, LinkedSourceCache::refusals),
            reuse_window_retained,
            reuse_window_bytes: if reuse_window_retained {
                window_bytes
            } else {
                0
            },
            degradations,
        },
        placed_prep,
        reuse_rows: window.map(Arc::new),
    })
}

pub(super) struct SlabRgbaRows<'a> {
    document: &'a RenderDocument,
    group: &'a ExportGroup,
    replacements: &'a HashMap<String, SourceContent>,
    prepared: PreparedSlabExport,
    config: SlabConfig,
    cancellation: Option<ReadCancellationToken>,
    linked: Option<&'a LinkedSourceCache>,
    cache: RefCell<Option<CachedSlab>>,
}

impl<'a> SlabRgbaRows<'a> {
    pub(super) fn new(
        document: &'a RenderDocument,
        group: &'a ExportGroup,
        replacements: &'a HashMap<String, SourceContent>,
        prepared: PreparedSlabExport,
        config: SlabConfig,
        cancellation: Option<ReadCancellationToken>,
        linked: Option<&'a LinkedSourceCache>,
    ) -> Self {
        Self {
            document,
            group,
            replacements,
            prepared,
            config,
            cancellation,
            linked,
            cache: RefCell::new(None),
        }
    }

    fn source_row(&self, y: i64) -> Result<Vec<u8>, MediaError> {
        if y < self.group.bounds.top || y >= self.group.bounds.bottom {
            return Ok(vec![0; self.document.width as usize * 4]);
        }
        let anchor = self.group.bounds.top;
        let slab_top =
            anchor + ((y - anchor) / i64::from(self.config.rows)) * i64::from(self.config.rows);
        let slab_bottom = (slab_top + i64::from(self.config.rows + RESAMPLE_HALO_ROWS))
            .min(self.group.bounds.bottom);
        let needs_render = self
            .cache
            .borrow()
            .as_ref()
            .is_none_or(|cache| y < cache.top || y >= cache.bottom);
        if needs_render {
            check_cancelled(self.cancellation.as_ref(), "render-pass-2")?;
            let pass2_started = crate::media::stage_timing::start();
            let backdrop = render_group_slab(
                self.document,
                self.group,
                self.replacements,
                slab_top,
                slab_bottom,
                Some(&self.prepared.placed_prep),
                self.linked,
                self.prepared.limits,
            )?;
            crate::media::stage_timing::record(
                crate::media::stage_timing::Stage::Pass2Composite,
                pass2_started,
            );
            *self.cache.borrow_mut() = Some(CachedSlab {
                top: slab_top,
                bottom: slab_bottom,
                width: backdrop.width,
                rgba: backdrop_to_bytes(&backdrop),
            });
        }
        let cache = self.cache.borrow();
        let cache = cache.as_ref().expect("slab cache was populated");
        let row_bytes = cache.width as usize * 4;
        let offset = (y - cache.top) as usize * row_bytes;
        Ok(cache.rgba[offset..offset + row_bytes].to_vec())
    }
}

impl RgbaRows for SlabRgbaRows<'_> {
    fn width(&self) -> u32 {
        self.prepared.output_width
    }

    fn height(&self) -> u32 {
        self.prepared.output_height
    }

    fn read_rgba_row(&self, target_y: u32, output: &mut Vec<u8>) -> Result<(), MediaError> {
        check_cancelled(self.cancellation.as_ref(), "render-pass-2")?;
        let row_read_started = crate::media::stage_timing::start();
        let result = self.read_rgba_row_inner(target_y, output);
        crate::media::stage_timing::record(
            crate::media::stage_timing::Stage::RowRead,
            row_read_started,
        );
        result
    }
}

/// One output-row resample shared by every row source, so pipelined and
/// serial encodes cannot diverge by construction.
fn resample_output_row(
    rect: Rect,
    output_width: u32,
    output_height: u32,
    doc_width: u32,
    target_y: u32,
    source_row: &dyn Fn(i64) -> Result<Vec<u8>, MediaError>,
    output: &mut Vec<u8>,
) -> Result<(), MediaError> {
    // Identity export: with output dimensions equal to the export rect the
    // bilinear kernel is exact passthrough — `(t + 0.5) * n / n - 0.5` is
    // exactly `t` in IEEE f64 for admissible dimensions, so both fractions
    // are zero and every sample reads its own pixel. Copy the row segment
    // instead of resampling; the export rect is clamped inside the
    // document, so the segment is always in range.
    if output_width == rect.width && output_height == rect.height {
        let row = source_row(rect.top + i64::from(target_y))?;
        let start = usize::try_from(rect.left).unwrap_or_default() * 4;
        output.clear();
        output.extend_from_slice(&row[start..start + rect.width as usize * 4]);
        return Ok(());
    }
    let source_y =
        ((f64::from(target_y) + 0.5) * f64::from(rect.height) / f64::from(output_height) - 0.5)
            .clamp(0.0, f64::from(rect.height.saturating_sub(1)));
    let y0 = source_y.floor() as i64 + rect.top;
    let y1 = (y0 + 1).min(rect.top + i64::from(rect.height) - 1);
    let fy = source_y - source_y.floor();
    let row0 = source_row(y0)?;
    let row1 = if y1 == y0 {
        row0.clone()
    } else {
        source_row(y1)?
    };

    output.clear();
    output.reserve(output_width as usize * 4);
    for target_x in 0..output_width {
        let source_x =
            ((f64::from(target_x) + 0.5) * f64::from(rect.width) / f64::from(output_width) - 0.5)
                .clamp(0.0, f64::from(rect.width.saturating_sub(1)));
        let x0 = source_x.floor() as i64 + rect.left;
        let x1 = (x0 + 1).min(rect.left + i64::from(rect.width) - 1);
        let fx = source_x - source_x.floor();
        for channel in 0..4 {
            let sample = |row: &[u8], x: i64| -> u8 {
                if x < 0 || x >= i64::from(doc_width) {
                    0
                } else {
                    row[x as usize * 4 + channel]
                }
            };
            let top = f64::from(sample(&row0, x0)) * (1.0 - fx) + f64::from(sample(&row0, x1)) * fx;
            let bottom =
                f64::from(sample(&row1, x0)) * (1.0 - fx) + f64::from(sample(&row1, x1)) * fx;
            output.push((top * (1.0 - fy) + bottom * fy + 0.5) as u8);
        }
    }
    Ok(())
}

impl SlabRgbaRows<'_> {
    fn read_rgba_row_inner(&self, target_y: u32, output: &mut Vec<u8>) -> Result<(), MediaError> {
        resample_output_row(
            self.prepared.export_rect,
            self.prepared.output_width,
            self.prepared.output_height,
            self.document.width,
            target_y,
            &|y| self.source_row(y),
            output,
        )
    }
}

/// A detached, `Send` row source over one group's retained reuse window. It
/// carries no document references, which is what lets a bounded encode run
/// while the next group composites.
pub(super) struct WindowRgbaRows {
    window: Arc<Vec<u8>>,
    doc_width: u32,
    group_top: i64,
    group_bottom: i64,
    export_rect: Rect,
    output_width: u32,
    output_height: u32,
    cancellation: Option<ReadCancellationToken>,
}

impl WindowRgbaRows {
    pub(super) fn new(
        window: Arc<Vec<u8>>,
        document: &RenderDocument,
        group: &ExportGroup,
        prepared: &PreparedSlabExport,
        cancellation: Option<ReadCancellationToken>,
    ) -> Self {
        Self {
            window,
            doc_width: document.width,
            group_top: group.bounds.top,
            group_bottom: group.bounds.bottom,
            export_rect: prepared.export_rect,
            output_width: prepared.output_width,
            output_height: prepared.output_height,
            cancellation,
        }
    }

    fn source_row(&self, y: i64) -> Result<&[u8], MediaError> {
        if y < self.group_top || y >= self.group_bottom {
            // Empty means transparent canvas padding; the identity path
            // writes zeros into the encoder's existing output buffer.
            return Ok(&[]);
        }
        let row_bytes = self.doc_width as usize * 4;
        let offset = (y - self.group_top) as usize * row_bytes;
        // The immutable Arc-backed window outlives every row read.
        Ok(&self.window[offset..offset + row_bytes])
    }
}

impl RgbaRows for WindowRgbaRows {
    fn width(&self) -> u32 {
        self.output_width
    }

    fn height(&self) -> u32 {
        self.output_height
    }

    fn read_rgba_row(&self, target_y: u32, output: &mut Vec<u8>) -> Result<(), MediaError> {
        check_cancelled(self.cancellation.as_ref(), "render-pass-2")?;
        let row_read_started = crate::media::stage_timing::start();
        let rect = self.export_rect;
        let result = if self.output_width == rect.width && self.output_height == rect.height {
            // The common 1:1 export needs only the cropped window segment,
            // not a temporary full-document-width Vec for every JPEG row.
            self.source_row(rect.top + i64::from(target_y)).map(|row| {
                output.clear();
                if row.is_empty() {
                    output.resize(rect.width as usize * 4, 0);
                } else {
                    let start = usize::try_from(rect.left).unwrap_or_default() * 4;
                    output.extend_from_slice(&row[start..start + rect.width as usize * 4]);
                }
            })
        } else {
            // Keep the measured scaling kernel unchanged. Testing padding
            // inside its per-pixel sampler regressed scaled exports; expand
            // padding here, once per source row, as the old adapter did.
            resample_output_row(
                rect,
                self.output_width,
                self.output_height,
                self.doc_width,
                target_y,
                &|y| {
                    self.source_row(y).map(|row| {
                        if row.is_empty() {
                            vec![0; self.doc_width as usize * 4]
                        } else {
                            row.to_vec()
                        }
                    })
                },
                output,
            )
        };
        crate::media::stage_timing::record(
            crate::media::stage_timing::Stage::RowRead,
            row_read_started,
        );
        result
    }
}

struct CachedSlab {
    top: i64,
    bottom: i64,
    width: u32,
    rgba: Vec<u8>,
}

#[allow(clippy::too_many_arguments)]
fn render_group_slab(
    document: &RenderDocument,
    group: &ExportGroup,
    replacements: &HashMap<String, SourceContent>,
    top: i64,
    bottom: i64,
    prepared: Option<&PlacedPrepCache>,
    linked: Option<&LinkedSourceCache>,
    limits: crate::media::limits::RenderLimits,
) -> Result<Backdrop, MediaError> {
    render_document_prepared(
        document,
        RenderDocumentOptions {
            replacements,
            isolate_index: Some(group.layer_index),
            viewport_top: top,
            viewport_bottom: bottom,
        },
        limits,
        prepared,
        linked,
    )
}

fn union_alpha_bounds(bounds: &mut Option<Rect>, backdrop: &Backdrop, top: i64) {
    let mut min_x = backdrop.width;
    let mut min_y = backdrop.height;
    let mut max_x = None;
    let mut max_y = None;
    for y in 0..backdrop.height {
        for x in 0..backdrop.width {
            let alpha = backdrop.data[((y * backdrop.width + x) * 4 + 3) as usize];
            if alpha <= 0.0 {
                continue;
            }
            min_x = min_x.min(x);
            min_y = min_y.min(y);
            max_x = Some(max_x.map_or(x, |current: u32| current.max(x)));
            max_y = Some(max_y.map_or(y, |current: u32| current.max(y)));
        }
    }
    let (Some(max_x), Some(max_y)) = (max_x, max_y) else {
        return;
    };
    let slab = Rect {
        left: i64::from(min_x),
        top: top + i64::from(min_y),
        width: max_x - min_x + 1,
        height: max_y - min_y + 1,
    };
    *bounds = Some(match *bounds {
        None => slab,
        Some(current) => {
            let left = current.left.min(slab.left);
            let top = current.top.min(slab.top);
            let right =
                (current.left + i64::from(current.width)).max(slab.left + i64::from(slab.width));
            let bottom =
                (current.top + i64::from(current.height)).max(slab.top + i64::from(slab.height));
            Rect {
                left,
                top,
                width: (right - left) as u32,
                height: (bottom - top) as u32,
            }
        }
    });
}

fn slab_reservation_bytes(width: u32, rows: u32, halo: u32) -> Result<u64, MediaError> {
    let pixels = u128::from(width)
        .checked_mul(u128::from(rows.saturating_add(halo)))
        .ok_or_else(slab_overflow_error)?;
    let bytes = pixels
        .checked_mul(4)
        .and_then(|value| value.checked_mul((std::mem::size_of::<f32>() + 1) as u128))
        .ok_or_else(slab_overflow_error)?;
    u64::try_from(bytes).map_err(|_| slab_overflow_error())
}

fn slab_overflow_error() -> MediaError {
    MediaError::new(
        MediaErrorCode::DimensionLimit,
        "slab-admission",
        "slab reservation arithmetic overflow",
    )
}

fn check_cancelled(
    cancellation: Option<&ReadCancellationToken>,
    phase: &'static str,
) -> Result<(), MediaError> {
    if cancellation.is_some_and(ReadCancellationToken::is_cancelled) {
        Err(MediaError::new(
            MediaErrorCode::Aborted,
            phase,
            "render cancellation requested",
        ))
    } else {
        Ok(())
    }
}

#[cfg(test)]
mod tests;

#[cfg(test)]
mod borrowed_rows_tests;
