use crate::media::capability::admit_render_capabilities;
use crate::media::composite::{CompositeOptions, composite_document, composite_group};
use crate::media::error::{MediaError, MediaErrorCode};
use crate::media::limits::RenderLimits;
use crate::media::model::{ExportGroup, ExportPlan, ExportRect, SlotInfo};
use crate::media::raster::PixelSource;
use crate::media::slab::DEFAULT_SLAB_ROWS;
use crate::media::source::LinkedSource;
use crate::media::warp::{
    extract_geom, render_placed, render_placed_peak_bytes, walk_placed_layers,
};
use crate::psd::{LayerNode, RenderDocument, SourceContent};
use std::borrow::Cow;
use std::cell::RefCell;
use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::mem::size_of;
use std::rc::Rc;

/// Conservative accounting for the parsed template retained by a pooled
/// worker. Capacity, not length, is charged for owned buffers so admission
/// does not under-price reusable allocations.
pub(crate) fn document_resident_bytes(document: &crate::psd::RenderDocument) -> u64 {
    fn capacity_bytes(capacity: usize, element_size: usize) -> u64 {
        u64::try_from(capacity)
            .unwrap_or(u64::MAX)
            .saturating_mul(u64::try_from(element_size).unwrap_or(u64::MAX))
    }

    fn bitmap_bytes(bitmap: &crate::psd::Bitmap) -> u64 {
        size_of::<crate::psd::Bitmap>() as u64 + bitmap.data.capacity() as u64
    }

    fn layer_bytes(layer: &crate::psd::LayerNode) -> u64 {
        let mut bytes = (size_of::<crate::psd::LayerNode>() as u64)
            .saturating_add(u64::try_from(layer.name.capacity()).unwrap_or(u64::MAX))
            .saturating_add(u64::try_from(layer.blend_mode.capacity()).unwrap_or(u64::MAX))
            .saturating_add(capacity_bytes(
                layer.children.capacity(),
                size_of::<crate::psd::LayerNode>(),
            ));
        if let Some(bitmap) = layer.image_data.as_ref() {
            bytes = bytes.saturating_add(bitmap_bytes(bitmap));
        }
        if let Some(mask) = layer.mask.as_ref()
            && let Some(bitmap) = mask.image_data.as_ref()
        {
            bytes = bytes.saturating_add(bitmap_bytes(bitmap));
        }
        if let Some(placed) = layer.placed.as_ref() {
            bytes = bytes
                .saturating_add(placed.id.capacity() as u64)
                .saturating_add(capacity_bytes(
                    placed.geom.quad.capacity(),
                    size_of::<f64>(),
                ));
            if let Some(mesh) = placed.geom.mesh.as_ref() {
                bytes = bytes
                    .saturating_add(capacity_bytes(mesh.xs.capacity(), size_of::<f64>()))
                    .saturating_add(capacity_bytes(mesh.ys.capacity(), size_of::<f64>()))
                    .saturating_add(capacity_bytes(mesh.slices_x.capacity(), size_of::<f64>()))
                    .saturating_add(capacity_bytes(mesh.slices_y.capacity(), size_of::<f64>()));
            }
        }
        for child in &layer.children {
            bytes = bytes.saturating_add(layer_bytes(child));
        }
        bytes
    }

    let mut bytes = (size_of::<crate::psd::RenderDocument>() as u64)
        .saturating_add(capacity_bytes(
            document.children.capacity(),
            size_of::<crate::psd::LayerNode>(),
        ))
        .saturating_add(capacity_bytes(
            document.linked_files.capacity(),
            size_of::<crate::psd::LinkedFileData>(),
        ));
    for layer in &document.children {
        bytes = bytes.saturating_add(layer_bytes(layer));
    }
    for linked in &document.linked_files {
        bytes = bytes
            .saturating_add(linked.id.capacity() as u64)
            .saturating_add(linked.name.capacity() as u64)
            .saturating_add(linked.bytes.capacity() as u64);
    }
    bytes
}

type RenderKey = (String, i64, i64);

/// One render's memo of resolved linked placed-layer sources.
///
/// Several export groups routinely reference the same linked smart object —
/// commonly an embedded document that receives the replacement design inside
/// it. Resolution is a pure function of the parsed template, the linked id,
/// the render's replacements and the admission limits, so its result is
/// identical for every group of one render and is resolved once. The memo
/// never outlives the render, so a later render with different replacements
/// can never observe stale content, and an entry that would exceed the budget
/// is simply not retained — callers fall back to per-call resolution with
/// identical bytes.
#[derive(Debug, Default)]
struct LinkedSourceCacheState {
    resolved: HashMap<String, Rc<SourceContent>>,
    resident_bytes: u64,
    /// Sources the budget refused to memoise. A refusal is a silent capability
    /// loss — every group re-resolves that source — so it is counted here and
    /// reported as a render degradation (re-resolution was measured at two
    /// thirds of one render's wall clock).
    refusals: u32,
    refused_bytes: u64,
}

#[derive(Debug, Default)]
pub(crate) struct LinkedSourceCache {
    budget_bytes: u64,
    state: RefCell<LinkedSourceCacheState>,
}

impl LinkedSourceCache {
    pub(crate) fn new(budget_bytes: u64) -> Self {
        Self {
            budget_bytes,
            ..Self::default()
        }
    }

    pub(crate) fn resident_bytes(&self) -> u64 {
        self.state.borrow().resident_bytes
    }

    pub(crate) fn budget_bytes(&self) -> u64 {
        self.budget_bytes
    }

    /// How many linked sources the memo refused to retain this render.
    pub(crate) fn refusals(&self) -> u32 {
        self.state.borrow().refusals
    }

    /// The bytes those refused sources would have occupied.
    pub(crate) fn refused_bytes(&self) -> u64 {
        self.state.borrow().refused_bytes
    }

    /// Top-level resolution only: depth 0 and an empty reference chain, which
    /// is the only shape shared by every group of one render.
    fn resolve(
        &self,
        document: &RenderDocument,
        linked_id: &str,
        replacements: &HashMap<String, SourceContent>,
        limits: RenderLimits,
    ) -> Result<Rc<SourceContent>, MediaError> {
        if let Some(hit) = self.state.borrow().resolved.get(linked_id) {
            return Ok(Rc::clone(hit));
        }
        let content = resolve_linked_source(
            document,
            linked_id,
            0,
            &BTreeSet::new(),
            replacements,
            limits,
        )?;
        let bytes = content.data.len() as u64;
        let content = Rc::new(content);
        let mut state = self.state.borrow_mut();
        let next = state.resident_bytes.saturating_add(bytes);
        if next <= self.budget_bytes {
            state
                .resolved
                .insert(linked_id.to_owned(), Rc::clone(&content));
            state.resident_bytes = next;
        } else {
            state.refusals = state.refusals.saturating_add(1);
            state.refused_bytes = state.refused_bytes.saturating_add(bytes);
        }
        Ok(content)
    }
}

/// A source whose pixels remain valid for one placed-layer rasterization.
///
/// Replacement bytes are already retained for the whole render, and cached
/// linked sources are shared by all groups. Returning either by reference or
/// `Rc` avoids copying the entire smart object per group.
enum ResolvedPlacedSource<'a> {
    Replacement(&'a SourceContent),
    Cached(Rc<SourceContent>),
    Owned(SourceContent),
}

impl AsRef<SourceContent> for ResolvedPlacedSource<'_> {
    fn as_ref(&self) -> &SourceContent {
        match self {
            Self::Replacement(source) => source,
            Self::Cached(source) => source,
            Self::Owned(source) => source,
        }
    }
}

/// Resolves the pixels a placed layer samples from: the render's replacement
/// when the slot is replaced, otherwise the linked source — through the
/// render-scoped memo when one is available at top level.
fn resolve_placed_source<'a>(
    document: &RenderDocument,
    placed_id: &str,
    depth: u32,
    chain: &BTreeSet<String>,
    replacements: &'a HashMap<String, SourceContent>,
    limits: RenderLimits,
    linked: Option<&LinkedSourceCache>,
) -> Result<ResolvedPlacedSource<'a>, MediaError> {
    if let Some(content) = replacements.get(placed_id) {
        return Ok(ResolvedPlacedSource::Replacement(content));
    }
    if depth == 0
        && chain.is_empty()
        && let Some(cache) = linked
    {
        return Ok(ResolvedPlacedSource::Cached(cache.resolve(
            document,
            placed_id,
            replacements,
            limits,
        )?));
    }
    Ok(ResolvedPlacedSource::Owned(resolve_linked_source(
        document,
        placed_id,
        depth,
        chain,
        replacements,
        limits,
    )?))
}

#[derive(Debug, Default)]
pub(crate) struct PlacedPrepCache {
    rendered: HashMap<RenderKey, PixelSource<'static>>,
    resident_bytes: u64,
    /// How many times the budget forced the whole cache to be discarded, and
    /// how many bytes were standing when it happened. A discard is silent to
    /// the render — every placed layer is re-warped per slab afterwards — so
    /// it is counted here and reported as a degradation.
    drops: u32,
    dropped_bytes: u64,
    budget_bytes: u64,
}

impl PlacedPrepCache {
    #[allow(clippy::too_many_arguments)]
    pub(crate) fn build(
        document: &RenderDocument,
        layers: &[LayerNode],
        replacements: &HashMap<String, SourceContent>,
        budget_bytes: u64,
        limits: RenderLimits,
        depth: u32,
        chain: &BTreeSet<String>,
        linked: Option<&LinkedSourceCache>,
    ) -> Result<Self, MediaError> {
        if budget_bytes == 0 {
            return Ok(Self::default());
        }
        let mut rendered = HashMap::new();
        let mut resident_bytes = 0_u64;
        let mut drops = 0_u32;
        let mut dropped_bytes = 0_u64;
        walk_placed_layers(layers, &mut |layer| {
            let Some(geom) = extract_geom(layer) else {
                return Ok(());
            };
            let Some(placed_info) = &layer.placed else {
                return Ok(());
            };
            let source = resolve_placed_source(
                document,
                &placed_info.id,
                depth,
                chain,
                replacements,
                limits,
                linked,
            )?;
            let Some(peak_bytes) = render_placed_peak_bytes(
                source.as_ref(),
                &geom,
                document.width,
                document.height,
                0,
                i64::from(document.height),
            )?
            else {
                return Ok(());
            };
            let Some(peak_total) = resident_bytes.checked_add(peak_bytes) else {
                drops = drops.saturating_add(1);
                dropped_bytes = dropped_bytes.max(resident_bytes);
                rendered.clear();
                resident_bytes = 0;
                return Ok(());
            };
            if peak_total > budget_bytes {
                drops = drops.saturating_add(1);
                dropped_bytes = dropped_bytes.max(peak_total);
                rendered.clear();
                resident_bytes = 0;
                return Ok(());
            }
            let Some(instance) = render_placed(
                source.as_ref(),
                &geom,
                document.width,
                document.height,
                0,
                i64::from(document.height),
            )?
            else {
                return Ok(());
            };
            let Some(next_bytes) = resident_bytes.checked_add(match &instance.data {
                Cow::Owned(bytes) => bytes.capacity() as u64,
                Cow::Borrowed(bytes) => bytes.len() as u64,
            }) else {
                drops = drops.saturating_add(1);
                dropped_bytes = dropped_bytes.max(resident_bytes);
                rendered.clear();
                resident_bytes = 0;
                return Ok(());
            };
            if next_bytes > budget_bytes {
                drops = drops.saturating_add(1);
                dropped_bytes = dropped_bytes.max(next_bytes);
                rendered.clear();
                resident_bytes = 0;
                return Ok(());
            }
            if let Some(key) = render_key(layer) {
                rendered.insert(key, instance);
                resident_bytes = next_bytes;
            }
            Ok(())
        })?;
        Ok(Self {
            rendered,
            resident_bytes,
            drops,
            dropped_bytes,
            budget_bytes,
        })
    }

    pub(crate) fn resident_bytes(&self) -> u64 {
        self.resident_bytes
    }

    /// How many times this build discarded the whole cache to stay inside its
    /// budget. Non-zero means every placed layer is re-warped per slab.
    pub(crate) fn drops(&self) -> u32 {
        self.drops
    }

    /// The largest standing size a discard threw away.
    pub(crate) fn dropped_bytes(&self) -> u64 {
        self.dropped_bytes
    }

    pub(crate) fn budget_bytes(&self) -> u64 {
        self.budget_bytes
    }

    fn get(&self, layer: &LayerNode) -> Option<&PixelSource<'_>> {
        self.rendered.get(&render_key(layer)?)
    }
}

fn list_slots(document: &RenderDocument) -> Vec<SlotInfo> {
    let mut slots = BTreeMap::new();
    collect_slots(document, 0, &BTreeSet::new(), &mut slots, None, 1, 1);
    let mut values = slots.into_values().collect::<Vec<_>>();
    values.sort_by(|left, right| {
        right
            .depth
            .cmp(&left.depth)
            .then_with(|| right.exported_instances.cmp(&left.exported_instances))
            .then_with(|| right.document_instances.cmp(&left.document_instances))
            .then_with(|| left.name.cmp(&right.name))
    });
    values
}

pub(super) fn resolve_slot(document: &RenderDocument, selection: &str) -> Option<SlotInfo> {
    let slots = list_slots(document);
    let start = if selection == "auto" {
        slots.iter().find(|slot| slot.depth == 0).cloned()
    } else {
        slots.iter().find(|slot| slot.id == selection).cloned()
    }?;
    let mut current = start;
    loop {
        let children = slots
            .iter()
            .filter(|slot| slot.parent_id.as_deref() == Some(current.id.as_str()))
            .cloned()
            .collect::<Vec<_>>();
        if children.is_empty() {
            return Some(current);
        }
        current = children.into_iter().next().expect("child");
    }
}

pub(super) fn plan_top_group_exports(document: &RenderDocument) -> ExportPlan {
    let mut groups = Vec::new();
    let mut order = 0_u32;
    // RenderDocument retains the renderer's bottom-to-top compositing order.
    // Export ordinals are user-facing and follow the PSD panel top-to-bottom.
    for (index, layer) in document.children.iter().enumerate().rev() {
        if !layer.is_group() {
            continue;
        }
        order += 1;
        let name = if layer.name.trim().is_empty() {
            format!("group-{order}")
        } else {
            layer.name.clone()
        };
        if layer.hidden || layer.clipping {
            continue;
        }
        let mut bounds = ExportRect {
            left: i64::MAX,
            top: i64::MAX,
            right: i64::MIN,
            bottom: i64::MIN,
        };
        union_bounds(layer, &mut bounds);
        let clamped = ExportRect {
            left: clamp(bounds.left, document.width as i64),
            top: clamp(bounds.top, document.height as i64),
            right: clamp(bounds.right, document.width as i64),
            bottom: clamp(bounds.bottom, document.height as i64),
        };
        if clamped.right <= clamped.left || clamped.bottom <= clamped.top {
            continue;
        }
        groups.push(ExportGroup {
            name,
            layer_index: index,
            bounds: clamped,
        });
    }
    ExportPlan { groups }
}

pub(super) struct RenderDocumentOptions<'a> {
    pub replacements: &'a HashMap<String, SourceContent>,
    pub isolate_index: Option<usize>,
    pub viewport_top: i64,
    pub viewport_bottom: i64,
}

pub(crate) fn render_document_prepared(
    document: &RenderDocument,
    options: RenderDocumentOptions<'_>,
    limits: RenderLimits,
    prepared: Option<&PlacedPrepCache>,
    linked: Option<&LinkedSourceCache>,
) -> Result<crate::media::raster::Backdrop, MediaError> {
    render_document_at(
        document,
        options,
        0,
        &BTreeSet::new(),
        limits,
        prepared,
        linked,
    )
}

fn render_key(layer: &LayerNode) -> Option<RenderKey> {
    let placed = layer.placed.as_ref()?;
    Some((placed.id.clone(), layer.top, layer.left))
}

#[allow(clippy::too_many_arguments)]
fn render_document_at<'a>(
    document: &'a RenderDocument,
    options: RenderDocumentOptions<'_>,
    depth: u32,
    chain: &BTreeSet<String>,
    limits: RenderLimits,
    prepared: Option<&'a PlacedPrepCache>,
    linked: Option<&'a LinkedSourceCache>,
) -> Result<crate::media::raster::Backdrop, MediaError> {
    admit_render_capabilities(document)?;
    let layers = if let Some(index) = options.isolate_index {
        document
            .children
            .get(index)
            .map(std::slice::from_ref)
            .unwrap_or_default()
    } else {
        &document.children
    };
    let mut rendered = HashMap::<RenderKey, PixelSource<'a>>::new();
    walk_placed_layers(layers, &mut |layer| {
        let Some(geom) = extract_geom(layer) else {
            return Ok(());
        };
        let Some(placed_info) = &layer.placed else {
            return Ok(());
        };
        let quad = &placed_info.geom.quad;
        let min_y = quad
            .iter()
            .skip(1)
            .step_by(2)
            .copied()
            .fold(f64::INFINITY, f64::min);
        let max_y = quad
            .iter()
            .skip(1)
            .step_by(2)
            .copied()
            .fold(f64::NEG_INFINITY, f64::max);
        // Warp rasterization samples a one-pixel antialias support region
        // around the transformed quad. Culling must use that same expanded
        // extent or a slab ending exactly at min/max Y will drop edge pixels.
        let support_top = min_y.floor() - 1.0;
        let support_bottom = max_y.ceil() + 1.0;
        if support_bottom <= options.viewport_top as f64
            || support_top >= options.viewport_bottom as f64
        {
            return Ok(());
        }
        if let Some(instance) = prepared
            .and_then(|cache| cache.get(layer))
            .and_then(|source| {
                crop_pixel_source(source, options.viewport_top, options.viewport_bottom)
            })
        {
            if let Some(key) = render_key(layer) {
                rendered.insert(key, instance);
            }
            return Ok(());
        }
        let source = resolve_placed_source(
            document,
            &placed_info.id,
            depth,
            chain,
            options.replacements,
            limits,
            linked,
        )?;
        if let Some(instance) = render_placed(
            source.as_ref(),
            &geom,
            document.width,
            document.height,
            options.viewport_top,
            options.viewport_bottom,
        )? && let Some(key) = render_key(layer)
        {
            rendered.insert(key, instance);
        }
        Ok(())
    })?;

    let resolve_pixels = |layer: &LayerNode| {
        render_key(layer)
            .and_then(|key| rendered.get(&key))
            .cloned()
    };

    let backdrop = if let Some(index) = options.isolate_index {
        let group = document.children.get(index).ok_or_else(|| {
            MediaError::new(
                MediaErrorCode::GroupsNotFound,
                "group-isolation",
                "missing export group",
            )
        })?;
        composite_group(
            document,
            group,
            CompositeOptions {
                resolve_pixels: Some(Box::new(resolve_pixels)),
                viewport_top: options.viewport_top,
                viewport_bottom: options.viewport_bottom,
            },
        )?
    } else {
        composite_document(
            document,
            CompositeOptions {
                resolve_pixels: Some(Box::new(resolve_pixels)),
                viewport_top: options.viewport_top,
                viewport_bottom: options.viewport_bottom,
            },
        )?
    };
    Ok(backdrop)
}

fn resolve_linked_source(
    document: &RenderDocument,
    linked_id: &str,
    depth: u32,
    chain: &BTreeSet<String>,
    replacements: &HashMap<String, SourceContent>,
    limits: RenderLimits,
) -> Result<SourceContent, MediaError> {
    let linked = document
        .linked_files
        .iter()
        .find(|file| file.id == linked_id)
        .ok_or_else(|| {
            MediaError::new(
                MediaErrorCode::UnsupportedCapability,
                "linked-source",
                format!("missing linked file {linked_id}"),
            )
        })?;
    admit_linked_payload(linked.bytes.len(), limits)?;
    match crate::media::source::decode_linked_bytes(&linked.bytes, limits.linked_source_policy())? {
        LinkedSource::Bitmap(content) => {
            admit_embedded_bitmap(content.width, content.height, limits)?;
            Ok(content)
        }
        LinkedSource::Document(inner) => {
            admit_embedded_descent(depth, limits.max_nesting_depth)?;
            admit_embedded_bitmap(inner.width, inner.height, limits)?;
            if chain.contains(linked_id) {
                return Err(MediaError::new(
                    MediaErrorCode::UnsupportedCapability,
                    "linked-source",
                    "cyclic nested smart object reference",
                ));
            }
            let mut nested_chain = chain.clone();
            nested_chain.insert(linked_id.to_owned());
            render_embedded_document(&inner, replacements, depth + 1, &nested_chain, limits)
        }
    }
}

fn render_embedded_document(
    document: &RenderDocument,
    replacements: &HashMap<String, SourceContent>,
    depth: u32,
    chain: &BTreeSet<String>,
    limits: RenderLimits,
) -> Result<SourceContent, MediaError> {
    let source_bytes = u128::from(document.width)
        .checked_mul(u128::from(document.height))
        .and_then(|pixels| pixels.checked_mul(4))
        .ok_or_else(|| embedded_working_set_error(u128::MAX, limits))?;
    let source_len = usize::try_from(source_bytes)
        .map_err(|_| embedded_working_set_error(source_bytes, limits))?;
    let mut data = Vec::new();
    data.try_reserve_exact(source_len).map_err(|_| {
        MediaError::new(
            MediaErrorCode::Io,
            "linked-source",
            "unable to reserve bounded embedded source pixels",
        )
    })?;

    // An embedded document is rendered slab by slab like the outer canvas, so
    // without preparation each inner placed layer would be re-warped once per
    // slab. Preparing the inner placed layers once bounds that work to one
    // warp per layer; the budget shares the embedded working-set policy and an
    // over-budget build degrades to the identical per-slab fallback.
    let placed_prep = PlacedPrepCache::build(
        document,
        &document.children,
        replacements,
        limits.max_embedded_working_bytes / 4,
        limits,
        depth,
        chain,
        None,
    )?;
    let mut viewport_top = 0_i64;
    let document_bottom = i64::from(document.height);
    while viewport_top < document_bottom {
        let viewport_bottom = viewport_top
            .saturating_add(i64::from(DEFAULT_SLAB_ROWS))
            .min(document_bottom);
        let backdrop = render_document_at(
            document,
            RenderDocumentOptions {
                replacements,
                isolate_index: None,
                viewport_top,
                viewport_bottom,
            },
            depth,
            chain,
            limits,
            Some(&placed_prep),
            None,
        )?;
        data.extend(
            backdrop
                .data
                .iter()
                .map(|value| (value * 255.0 + 0.5) as u8),
        );
        viewport_top = viewport_bottom;
    }

    debug_assert_eq!(data.len(), source_len);
    Ok(SourceContent {
        data,
        width: document.width,
        height: document.height,
    })
}

fn crop_pixel_source<'a>(
    source: &'a PixelSource<'_>,
    top: i64,
    bottom: i64,
) -> Option<PixelSource<'a>> {
    let crop_top = source.top.max(top);
    let crop_bottom = (source.top + i64::from(source.height)).min(bottom);
    if crop_bottom <= crop_top {
        return None;
    }
    let row_bytes = source.width as usize * 4;
    let start = (crop_top - source.top) as usize * row_bytes;
    let end = (crop_bottom - source.top) as usize * row_bytes;
    Some(PixelSource {
        data: Cow::Borrowed(&source.data[start..end]),
        width: source.width,
        height: (crop_bottom - crop_top) as u32,
        left: source.left,
        top: crop_top,
    })
}

fn admit_linked_payload(byte_count: usize, limits: RenderLimits) -> Result<(), MediaError> {
    let observed = u128::try_from(byte_count).unwrap_or(u128::MAX);
    if observed > u128::from(limits.max_linked_payload_bytes) {
        return Err(MediaError::resource_limit(
            MediaErrorCode::InputTooLarge,
            "linked-source",
            observed,
            u128::from(limits.max_linked_payload_bytes),
            limits.linked_source_policy(),
        ));
    }
    Ok(())
}

fn admit_embedded_bitmap(width: u32, height: u32, limits: RenderLimits) -> Result<(), MediaError> {
    // Embedded documents retain the RGBA source needed by warp sampling while
    // compositing only one fixed-height f32 slab at a time.
    let source_bytes = u128::from(width)
        .checked_mul(u128::from(height))
        .and_then(|pixels| pixels.checked_mul(4))
        .unwrap_or(u128::MAX);
    let slab_bytes = u128::from(width)
        .checked_mul(u128::from(height.min(DEFAULT_SLAB_ROWS)))
        .and_then(|pixels| pixels.checked_mul(4))
        .and_then(|channels| channels.checked_mul(std::mem::size_of::<f32>() as u128))
        .unwrap_or(u128::MAX);
    let observed = source_bytes.saturating_add(slab_bytes);
    if observed > u128::from(limits.max_embedded_working_bytes) {
        return Err(embedded_working_set_error(observed, limits));
    }
    Ok(())
}

fn embedded_working_set_error(observed: u128, limits: RenderLimits) -> MediaError {
    MediaError::resource_limit(
        MediaErrorCode::DimensionLimit,
        "linked-source",
        observed,
        u128::from(limits.max_embedded_working_bytes),
        limits.linked_source_policy(),
    )
}

fn admit_embedded_descent(depth: u32, limit: u32) -> Result<(), MediaError> {
    let observed = depth.checked_add(1).ok_or_else(|| {
        MediaError::resource_limit(
            MediaErrorCode::RecursionLimit,
            "linked-source",
            u128::from(u32::MAX) + 1,
            u128::from(limit),
            crate::psd::ProductResourcePolicy::default(),
        )
    })?;
    if observed > limit {
        return Err(MediaError::resource_limit(
            MediaErrorCode::RecursionLimit,
            "linked-source",
            u128::from(observed),
            u128::from(limit),
            crate::psd::ProductResourcePolicy::default(),
        ));
    }
    Ok(())
}

fn collect_slots(
    document: &RenderDocument,
    depth: u32,
    chain: &BTreeSet<String>,
    out: &mut BTreeMap<String, SlotInfo>,
    parent_id: Option<String>,
    multiplier: u32,
    exported_multiplier: u32,
) {
    let here = tally_placed(document, depth);
    for (id, tally) in &here {
        let entry = out.entry(id.clone()).or_insert_with(|| SlotInfo {
            id: id.clone(),
            name: document
                .linked_files
                .iter()
                .find(|file| file.id == *id)
                .map(|file| file.name.clone())
                .unwrap_or_else(|| tally.layer_name.clone()),
            src_w: tally.src_w,
            src_h: tally.src_h,
            document_instances: 0,
            exported_instances: 0,
            depth,
            parent_id: parent_id.clone(),
        });
        entry.document_instances = entry
            .document_instances
            .saturating_add(tally.count.saturating_mul(multiplier));
        entry.exported_instances = entry
            .exported_instances
            .saturating_add(tally.grouped.saturating_mul(exported_multiplier));
    }
    if depth >= RenderLimits::default().max_nesting_depth {
        return;
    }
    for (id, tally) in here {
        if chain.contains(&id) {
            continue;
        }
        let Some(bytes) = document
            .linked_files
            .iter()
            .find(|file| file.id == id)
            .map(|file| file.bytes.as_slice())
        else {
            continue;
        };
        if !crate::media::source::is_psd_bytes(bytes) {
            continue;
        }
        let Ok(linked) =
            crate::psd::render::load_render_document(bytes, crate::psd::Limits::default())
        else {
            continue;
        };
        let mut nested_chain = chain.clone();
        nested_chain.insert(id.clone());
        collect_slots(
            &linked,
            depth + 1,
            &nested_chain,
            out,
            Some(id.clone()),
            multiplier.saturating_mul(tally.count),
            exported_multiplier.saturating_mul(tally.grouped),
        );
    }
}

struct PlacedTally {
    count: u32,
    grouped: u32,
    src_w: u32,
    src_h: u32,
    layer_name: String,
}

fn tally_placed(document: &RenderDocument, depth: u32) -> BTreeMap<String, PlacedTally> {
    let mut here = BTreeMap::new();
    if depth == 0 {
        for child in &document.children {
            let grouped = child.is_group() && !child.hidden && !child.clipping;
            add_placed(child, grouped, &mut here);
        }
    } else {
        for child in &document.children {
            add_placed(child, true, &mut here);
        }
    }
    here
}

fn add_placed(layer: &LayerNode, grouped: bool, here: &mut BTreeMap<String, PlacedTally>) {
    let mut stack = vec![layer];
    while let Some(current) = stack.pop() {
        if let Some(placed) = &current.placed {
            let entry = here
                .entry(placed.id.clone())
                .or_insert_with(|| PlacedTally {
                    count: 0,
                    grouped: 0,
                    src_w: placed.width.round() as u32,
                    src_h: placed.height.round() as u32,
                    layer_name: current.name.clone(),
                });
            entry.count = entry.count.saturating_add(1);
            if grouped {
                entry.grouped = entry.grouped.saturating_add(1);
            }
        }
        for child in &current.children {
            stack.push(child);
        }
    }
}

fn union_bounds(layer: &LayerNode, acc: &mut ExportRect) {
    if layer.hidden {
        return;
    }
    if layer.is_group() {
        for child in &layer.children {
            union_bounds(child, acc);
        }
        return;
    }
    grow(acc, layer.left, layer.top, layer.right, layer.bottom);
    if let Some(geom) = extract_geom(layer) {
        let quad = geom.quad;
        let min_x = quad
            .iter()
            .step_by(2)
            .copied()
            .fold(f64::INFINITY, f64::min);
        let max_x = quad
            .iter()
            .step_by(2)
            .copied()
            .fold(f64::NEG_INFINITY, f64::max);
        let min_y = quad
            .iter()
            .skip(1)
            .step_by(2)
            .copied()
            .fold(f64::INFINITY, f64::min);
        let max_y = quad
            .iter()
            .skip(1)
            .step_by(2)
            .copied()
            .fold(f64::NEG_INFINITY, f64::max);
        grow(
            acc,
            min_x.floor() as i64,
            min_y.floor() as i64,
            max_x.ceil() as i64,
            max_y.ceil() as i64,
        );
    }
}

fn grow(acc: &mut ExportRect, left: i64, top: i64, right: i64, bottom: i64) {
    if right <= left || bottom <= top {
        return;
    }
    acc.left = acc.left.min(left);
    acc.top = acc.top.min(top);
    acc.right = acc.right.max(right);
    acc.bottom = acc.bottom.max(bottom);
}

fn clamp(value: i64, max: i64) -> i64 {
    value.clamp(0, max)
}
