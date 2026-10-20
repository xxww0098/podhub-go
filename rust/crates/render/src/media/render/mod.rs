use crate::media::delivery::{MemoryDelivery, safe_segment};
use crate::media::document::{plan_top_group_exports, resolve_slot};
use crate::media::document_dependencies::export_group_depends_on_replacement;
use crate::media::encode::content_hash;
use crate::media::error::{MediaError, MediaErrorCode};
use crate::media::intent::{RenderIntent, StaticGroups, admit_render_intent};
use crate::media::limits::RenderLimits;
use crate::media::slab::SlabConfig;
use crate::media::source::design_source;
use crate::psd::{ProductResourcePolicy, RenderDocument};
use std::collections::{HashMap, VecDeque};

mod groups;

use groups::{GroupTask, flush_group_completions, render_group_task, skipped_group};

/// A parsed template, ready to render any number of designs against.
///
/// Parsing is the expensive half of a render, and the browser worker holds one
/// of these across a whole listing batch. The fingerprint is of the *template
/// bytes*, not of the parsed model, so it keys an OPFS slice cache directly.
#[derive(Debug, Clone)]
pub struct ParsedTemplate {
    document: RenderDocument,
    fingerprint: String,
}

impl ParsedTemplate {
    pub fn parse(bytes: &[u8], policy: &ProductResourcePolicy) -> Result<Self, MediaError> {
        let limits = RenderLimits::from(*policy);
        if bytes.len() as u64 > limits.max_template_bytes {
            return Err(MediaError::resource_limit(
                MediaErrorCode::TemplateLimit,
                "template-admission",
                bytes.len() as u64,
                limits.max_template_bytes,
                *policy,
            ));
        }
        let parse_started = crate::media::stage_timing::start();
        let document =
            crate::psd::render::load_render_document(bytes, parser_admission_limits(*policy))?;
        crate::media::stage_timing::record(
            crate::media::stage_timing::Stage::PsdParse,
            parse_started,
        );
        Ok(Self {
            document,
            fingerprint: content_hash(bytes),
        })
    }

    /// `sha256:{hex}` of the template bytes this document was parsed from.
    pub fn fingerprint(&self) -> &str {
        &self.fingerprint
    }
}

/// One exported top group: its JPEG bytes and everything needed to name,
/// address and deduplicate them without decoding.
#[derive(Debug, Clone, Eq)]
pub struct RenderSlice {
    pub group_name: String,
    pub index: u32,
    pub file_name: String,
    pub width: u32,
    pub height: u32,
    /// `sha256:{hex}` of [`Self::bytes`].
    pub content_hash: String,
    /// The group's pixels do not depend on the design, so the slice is the
    /// same for every product of this template and render profile. Under
    /// [`StaticGroups::Skip`] such a slice arrives with no bytes, no hash and
    /// zero dimensions: the caller fills it from its cache.
    pub static_group: bool,
    pub bytes: Vec<u8>,
    /// JPEG encode duration for this group. Diagnostic only, so two
    /// reproducible renders still compare equal when the clock differs.
    pub encode_ms: u32,
}

impl PartialEq for RenderSlice {
    fn eq(&self, other: &Self) -> bool {
        self.group_name == other.group_name
            && self.index == other.index
            && self.file_name == other.file_name
            && self.width == other.width
            && self.height == other.height
            && self.content_hash == other.content_hash
            && self.static_group == other.static_group
            && self.bytes == other.bytes
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RenderOutcome {
    pub template_fingerprint: String,
    pub slices: Vec<RenderSlice>,
    /// The render manifest, hashed beside the slices. A caller that only
    /// forwards it never has to parse it.
    pub manifest_json: Vec<u8>,
    pub resource_observations: ResourceObservations,
}

/// What one render actually cost, measured rather than predicted.
///
/// The browser memory measurement reads these: a browser tab has a hard
/// per-tab memory ceiling that no configuration can raise.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ResourceObservations {
    pub encoded_high_water_bytes: u64,
    pub slab_reserved_bytes: u64,
    pub slab_rows: u32,
    pub slab_halo_rows: u32,
    /// Peak of one group's complete admission sum: shared template/design
    /// bytes, slab, placed preparation, linked memo, and retained reuse rows.
    pub working_set_peak_bytes: u64,
    /// Bytes of parsed template resident for the whole render.
    pub document_resident_bytes: u64,
    /// The geometry-derived live-byte ceiling for the heaviest rendered group.
    pub live_slot_bytes: u64,
    /// Whether any group's measured working set exceeded that group's own
    /// geometry-derived ceiling. It is observed rather than refused, but each
    /// crossing is retained in [`Self::degradations`].
    pub live_slot_exceeded: bool,
    /// The smallest ceiling that admits this render's heaviest group, with its
    /// measured resident template folded in.
    pub saturating_live_bytes: u64,
    /// The process-wide parser ceiling this render ran against.
    ///
    /// Distinct from [`Self::live_slot_bytes`], which is what one group needed.
    /// Dividing this by [`Self::saturating_live_bytes`] is what answers "how
    /// many renders of this weight fit in one worker" — dividing the group
    /// requirement by itself answers `1` for every template ever measured.
    pub parser_ceiling_bytes: u64,
    pub placed_prep_drops: u32,
    pub linked_memo_refusals: u32,
    pub reuse_window_refusals: u32,
    /// One line per memory-driven downgrade taken during this render.
    pub degradations: Vec<String>,
}

/// Composites `design_bytes` into every exportable top group of `template`.
///
/// Groups render one at a time on the caller's stack. wasm32-unknown-unknown
/// has no threads, and a browser worker is a single lane by construction.
pub fn render_product(
    template: &ParsedTemplate,
    design_bytes: &[u8],
    design_name: &str,
    intent: &RenderIntent,
    policy: &ProductResourcePolicy,
) -> Result<RenderOutcome, MediaError> {
    render_with_slab(
        template,
        design_bytes,
        design_name,
        intent,
        *policy,
        SlabConfig::default(),
    )
}

fn render_with_slab(
    template: &ParsedTemplate,
    design_bytes: &[u8],
    design_name: &str,
    intent: &RenderIntent,
    policy: ProductResourcePolicy,
    slab_config: SlabConfig,
) -> Result<RenderOutcome, MediaError> {
    let intent = admit_render_intent(intent)?;
    let limits = RenderLimits::from(policy);
    let document = &template.document;
    let mut observations = ResourceObservations::default();

    crate::media::capability::preflight_render_capabilities(document)?;
    let pixels = u64::from(document.width) * u64::from(document.height);
    if pixels > limits.max_output_pixels {
        return Err(MediaError::new(
            MediaErrorCode::DimensionLimit,
            "template-admission",
            "document pixel count exceeds output limit",
        ));
    }

    let slot = resolve_slot(document, &intent.slot_selection).ok_or_else(|| {
        MediaError::new(
            MediaErrorCode::SlotNotFound,
            "slot-resolution",
            "selected slot was not found",
        )
    })?;
    if slot.src_w == 0 || slot.src_h == 0 {
        return Err(MediaError::new(
            MediaErrorCode::SlotNotFound,
            "slot-resolution",
            "selected slot has no source dimensions",
        ));
    }
    if slot.exported_instances == 0 {
        return Err(MediaError::new(
            MediaErrorCode::SlotOutsideGroups,
            "slot-resolution",
            "selected slot is outside exportable top groups",
        ));
    }

    let plan = plan_top_group_exports(document);
    if plan.groups.is_empty() {
        return Err(MediaError::new(
            MediaErrorCode::GroupsNotFound,
            "export-plan",
            "template has no exportable top groups",
        ));
    }
    // A group that does not depend on the replaced slot renders the same bytes
    // for every design, so its slice is cacheable across a whole batch: each
    // slice says whether it is one, and `StaticGroups::Skip` leaves them out.
    let mut top_level_dependencies = HashMap::new();
    let is_static = plan
        .groups
        .iter()
        .map(|group| {
            !export_group_depends_on_replacement(
                document,
                group,
                &slot.id,
                &mut top_level_dependencies,
                policy.parser_limits(),
            )
        })
        .collect::<Vec<_>>();
    let static_groups = is_static.iter().filter(|is_static| **is_static).count();
    let skip_static = intent.static_groups == StaticGroups::Skip;

    let design_decode_started = crate::media::stage_timing::start();
    let replacement = design_source(design_bytes, slot.src_w, slot.src_h, intent.fit, policy)?;
    crate::media::stage_timing::record(
        crate::media::stage_timing::Stage::DesignDecode,
        design_decode_started,
    );
    let mut replacements = HashMap::new();
    replacements.insert(slot.id.clone(), replacement);

    let stem = safe_segment(
        design_name
            .rsplit('/')
            .next()
            .and_then(|name| name.rsplit_once('.').map(|(stem, _)| stem).or(Some(name)))
            .unwrap_or("design"),
        "design",
    );
    let mut delivery = MemoryDelivery::begin();
    let document_resident_bytes = crate::media::document::document_resident_bytes(document);
    observations.document_resident_bytes = document_resident_bytes;
    let replacement_resident_bytes = replacements.values().fold(0_u64, |total, source| {
        total.saturating_add(source.data.capacity() as u64)
    });
    // The worker retains the raw design input while the decoded replacement is
    // rendered. Price both into every group allowance; otherwise a large JPEG
    // can sit outside the memory ceiling merely because it has already decoded.
    let shared_resident_bytes = document_resident_bytes
        .saturating_add(replacement_resident_bytes)
        .saturating_add(design_bytes.len() as u64);
    let mut completed = (0..plan.groups.len()).map(|_| None).collect::<Vec<_>>();
    let mut tasks = VecDeque::new();
    let mut per_group_live_bytes = 0_u64;
    for (group_index, group) in plan.groups.iter().enumerate() {
        let output_file_name = format!("{stem}-{ordinal}.jpg", ordinal = group_index + 1);
        if skip_static && is_static[group_index] {
            completed[group_index] =
                Some(skipped_group(group_index, &group.name, output_file_name));
            continue;
        }
        let live_bytes = crate::media::slab::group_saturating_live_bytes(
            document,
            group,
            slab_config,
            shared_resident_bytes,
        )?;
        // The derived requirement is what this group actually needs; the
        // configured ceiling is what the deployment is willing to spend. Until
        // this comparison existed, the requirement was handed to the group as
        // its own allowance, so a deeply nested group silently raised the
        // ceiling it was supposed to be measured against and every render
        // admitted. Compare before the override below replaces the configured
        // value with the derived one.
        let configured_live_bytes = policy.max_parser_live_bytes as u64;
        if live_bytes > configured_live_bytes {
            return Err(MediaError::resource_limit(
                MediaErrorCode::DimensionLimit,
                "group-scheduling",
                live_bytes,
                configured_live_bytes,
                policy,
            ));
        }
        let live_bytes = usize::try_from(live_bytes).map_err(|_| {
            MediaError::new(
                MediaErrorCode::DimensionLimit,
                "group-scheduling",
                "group live-byte requirement does not fit this platform",
            )
        })?;
        per_group_live_bytes = per_group_live_bytes.max(live_bytes as u64);
        tasks.push_back(GroupTask {
            group_index,
            output_file_name,
            policy: ProductResourcePolicy {
                max_parser_live_bytes: live_bytes,
                ..policy
            },
            live_bytes: live_bytes as u64,
            static_group: is_static[group_index],
        });
    }
    observations.live_slot_bytes = if per_group_live_bytes == 0 {
        policy.max_parser_live_bytes as u64
    } else {
        per_group_live_bytes
    };
    observations.saturating_live_bytes = per_group_live_bytes;
    observations.parser_ceiling_bytes = policy.max_parser_live_bytes as u64;
    let linked_budget = tasks
        .iter()
        .map(|task| task.policy.max_parser_live_bytes as u64)
        .min()
        .unwrap_or(0)
        / crate::media::slab::LINKED_MEMO_DIVISOR;
    let linked_sources = crate::media::document::LinkedSourceCache::new(linked_budget);

    let mut slices = Vec::with_capacity(plan.groups.len());
    let mut next_group = 0;
    while let Some(task) = tasks.pop_front() {
        let group_index = task.group_index;
        completed[group_index] = Some(render_group_task(
            task,
            document,
            &plan,
            &replacements,
            &intent,
            slab_config,
            &mut delivery,
            &linked_sources,
            shared_resident_bytes,
        )?);
        flush_group_completions(
            &mut completed,
            &mut next_group,
            &mut slices,
            &mut observations,
        );
    }
    // Skipped groups were completed before any task ran; this takes a trailing
    // run of them when the last rendered group was not the last group.
    flush_group_completions(
        &mut completed,
        &mut next_group,
        &mut slices,
        &mut observations,
    );
    observations.linked_memo_refusals = linked_sources.refusals();

    let manifest_json = manifest(
        &template.fingerprint,
        &stem,
        static_groups,
        &slices,
        &observations,
    )?;
    let commit_started = crate::media::stage_timing::start();
    let mut encoded: HashMap<String, Vec<u8>> = delivery.commit().into_iter().collect();
    crate::media::stage_timing::record(
        crate::media::stage_timing::Stage::AtomicCommit,
        commit_started,
    );
    for slice in &mut slices {
        if skip_static && slice.static_group {
            continue;
        }
        slice.bytes = encoded.remove(&slice.file_name).ok_or_else(|| {
            MediaError::new(
                MediaErrorCode::OutputStagingFailed,
                "output-collect",
                "an encoded slice went missing between the encoder and the caller",
            )
        })?;
    }

    Ok(RenderOutcome {
        template_fingerprint: template.fingerprint.clone(),
        slices,
        manifest_json,
        resource_observations: observations,
    })
}

fn manifest(
    template_fingerprint: &str,
    stem: &str,
    static_groups: usize,
    slices: &[RenderSlice],
    observations: &ResourceObservations,
) -> Result<Vec<u8>, MediaError> {
    serde_json::to_vec_pretty(&serde_json::json!({
        "version": 1,
        "templateFingerprint": template_fingerprint,
        "outputDirectoryName": stem,
        "resourceObservations": {
            "encodedHighWaterBytes": observations.encoded_high_water_bytes,
            "slabReservedBytes": observations.slab_reserved_bytes,
            "slabRows": observations.slab_rows,
            "slabHaloRows": observations.slab_halo_rows,
            "workingSetPeakBytes": observations.working_set_peak_bytes,
            "documentResidentBytes": observations.document_resident_bytes,
            "liveSlotBytes": observations.live_slot_bytes,
            "liveSlotExceeded": observations.live_slot_exceeded,
            "saturatingLiveBytes": observations.saturating_live_bytes,
            "parserCeilingBytes": observations.parser_ceiling_bytes,
        },
        "degradations": {
            "placedPrepDrops": observations.placed_prep_drops,
            "linkedMemoRefusals": observations.linked_memo_refusals,
            "reuseWindowRefusals": observations.reuse_window_refusals,
            "reports": observations.degradations,
        },
        "staticGroups": static_groups,
        "stageTimings": crate::media::stage_timing::drain(),
        "slices": slices.iter().map(|slice| serde_json::json!({
            "index": slice.index,
            "groupName": slice.group_name,
            "fileName": slice.file_name,
            "contentHash": slice.content_hash,
            "width": slice.width,
            "height": slice.height,
            "staticGroup": slice.static_group,
        })).collect::<Vec<_>>(),
    }))
    .map_err(|error| {
        MediaError::new(
            MediaErrorCode::OutputStagingFailed,
            "output-manifest",
            error.to_string(),
        )
    })
}

pub(crate) fn parser_admission_limits(policy: ProductResourcePolicy) -> crate::psd::Limits {
    // Parse-phase ceilings stay the product's own: the caller's policy prices
    // the render loop (slabs, caches, reuse windows), and a render budget
    // below the parser's transient high-water must not make the template
    // unparseable. Only the template byte and nesting ceilings follow the
    // caller, as they did before render admission reused `Limits`.
    let limits = RenderLimits::from(policy);
    crate::psd::Limits {
        max_input_bytes: limits.max_template_bytes,
        max_embedded_document_depth: limits.max_nesting_depth,
        ..crate::psd::Limits::default()
    }
}

#[cfg(test)]
mod static_group_tests {
    use super::*;
    use crate::psd::render::PlacedLayerInfo;
    use crate::psd::{Bitmap, LayerNode, PlacedGeom, RenderDocument};

    const DESIGN: &[u8] = include_bytes!(
        "../../../../../../fixtures/psd/synthetic/replacement-transparent-edges.png"
    );

    fn leaf(
        name: &str,
        left: i64,
        top: i64,
        side: u32,
        placed: Option<PlacedLayerInfo>,
    ) -> LayerNode {
        let image_data = placed.is_none().then(|| Bitmap {
            data: vec![90; side as usize * side as usize * 4],
            width: side,
            height: side,
        });
        LayerNode {
            name: name.to_owned(),
            left,
            top,
            right: left + i64::from(side),
            bottom: top + i64::from(side),
            blend_mode: "normal".to_owned(),
            opacity: 1.0,
            fill_opacity: 1.0,
            hidden: false,
            clipping: false,
            mask: None,
            placed,
            image_data,
            children: Vec::new(),
        }
    }

    fn group(name: &str, child: LayerNode) -> LayerNode {
        LayerNode {
            name: name.to_owned(),
            left: 0,
            top: 0,
            right: 16,
            bottom: 16,
            blend_mode: "pass through".to_owned(),
            opacity: 1.0,
            fill_opacity: 1.0,
            hidden: false,
            clipping: false,
            mask: None,
            placed: None,
            image_data: None,
            children: vec![child],
        }
    }

    /// Two exportable groups: `art` holds the slot, `label` is plain pixels.
    fn template() -> ParsedTemplate {
        let slot = leaf(
            "design",
            2,
            2,
            8,
            Some(PlacedLayerInfo {
                id: "slot".to_owned(),
                width: 8.0,
                height: 8.0,
                geom: PlacedGeom {
                    src_w: 8.0,
                    src_h: 8.0,
                    quad: vec![2.0, 2.0, 10.0, 2.0, 10.0, 10.0, 2.0, 10.0],
                    mesh: None,
                },
            }),
        );
        ParsedTemplate {
            document: RenderDocument {
                width: 16,
                height: 16,
                // Bottom to top, as the parser keeps them; export order is the reverse.
                children: vec![
                    group("label", leaf("pixels", 1, 1, 6, None)),
                    group("art", slot),
                ],
                linked_files: Vec::new(),
            },
            fingerprint: "sha256:test".to_owned(),
        }
    }

    fn render(intent: &RenderIntent) -> RenderOutcome {
        render_product(
            &template(),
            DESIGN,
            "design.png",
            intent,
            &ProductResourcePolicy::default(),
        )
        .expect("render")
    }

    #[test]
    fn the_slot_group_is_dynamic_and_the_pixel_group_is_static() {
        let full = render(&RenderIntent::default());
        assert_eq!(
            full.slices
                .iter()
                .map(|slice| (slice.group_name.as_str(), slice.static_group))
                .collect::<Vec<_>>(),
            vec![("art", false), ("label", true)],
        );
        assert!(full.slices.iter().all(|slice| !slice.bytes.is_empty()));
        let manifest: serde_json::Value = serde_json::from_slice(&full.manifest_json).unwrap();
        assert_eq!(manifest["staticGroups"], 1);
        assert_eq!(manifest["slices"][1]["staticGroup"], true);
    }

    /// The same template with the pixel group's leaf buried under `levels`
    /// nested groups. Bounds, pixels and the export plan are identical; only the
    /// depth of the tree changes.
    fn nested_template(levels: usize) -> ParsedTemplate {
        let mut inner = leaf("pixels", 1, 1, 6, None);
        for depth in 0..levels {
            inner = LayerNode {
                name: format!("inner-{depth}"),
                left: 0,
                top: 0,
                right: 16,
                bottom: 16,
                blend_mode: "pass through".to_owned(),
                opacity: 1.0,
                fill_opacity: 1.0,
                hidden: false,
                clipping: false,
                mask: None,
                placed: None,
                image_data: None,
                children: vec![inner],
            };
        }
        let mut parsed = template();
        parsed.document.children[0] = group("label", inner);
        parsed
    }

    fn render_template(
        template: &ParsedTemplate,
        policy: ProductResourcePolicy,
    ) -> Result<RenderOutcome, MediaError> {
        render_with_slab(
            template,
            DESIGN,
            "design.png",
            &RenderIntent::default(),
            policy,
            SlabConfig::default(),
        )
    }

    #[test]
    fn nesting_raises_the_priced_ceiling_in_proportion_to_the_chain() {
        let flat = render_template(&template(), ProductResourcePolicy::default())
            .expect("flat render")
            .resource_observations
            .saturating_live_bytes;
        let one = render_template(&nested_template(1), ProductResourcePolicy::default())
            .expect("one level")
            .resource_observations
            .saturating_live_bytes;
        let three = render_template(&nested_template(3), ProductResourcePolicy::default())
            .expect("three levels")
            .resource_observations
            .saturating_live_bytes;
        let first_step = one.checked_sub(flat).expect("nesting has to cost bytes");
        assert!(
            first_step > 0,
            "a nested group level has to raise the ceiling"
        );
        assert!(three > one, "depth keeps costing as the chain grows");
        // Two more levels cost at least two more of the first level's price. The
        // exact per-level arithmetic is pinned in `slab::tests` against fixed
        // inputs; here the added nodes also raise the shared resident term, so
        // the growth is proportional rather than byte-identical.
        assert!(
            three - one >= first_step * 2,
            "the priced depth has to be the chain length, not the group count",
        );
    }

    #[test]
    fn a_group_whose_depth_outgrows_the_configured_ceiling_is_refused() {
        let flat =
            render_template(&template(), ProductResourcePolicy::default()).expect("flat render");
        // The flat template's own requirement is exactly what this ceiling
        // admits. Before the depth term existed, the group's derived
        // requirement was handed back to it as its allowance, so this template
        // could never be refused no matter how deep it nested.
        let configured = ProductResourcePolicy {
            max_parser_live_bytes: flat.resource_observations.saturating_live_bytes as usize,
            ..ProductResourcePolicy::default()
        };
        render_template(&template(), configured).expect("the flat template still fits");
        let error = render_template(&nested_template(1), configured).expect_err("nested refusal");
        assert_eq!(error.code, MediaErrorCode::DimensionLimit);
        assert_eq!(error.phase, "group-scheduling");
        assert!(!error.retryable);
        assert_eq!(
            error.configured_limit,
            Some(configured.max_parser_live_bytes as u128)
        );
        assert!(error.observed.expect("observed bytes") > error.configured_limit.expect("limit"),);
    }

    #[test]
    fn skipping_static_groups_keeps_order_and_leaves_dynamic_bytes_untouched() {
        let full = render(&RenderIntent::default());
        let skipped = render(&RenderIntent {
            static_groups: StaticGroups::Skip,
            ..RenderIntent::default()
        });
        let places = |outcome: &RenderOutcome| {
            outcome
                .slices
                .iter()
                .map(|slice| {
                    (
                        slice.index,
                        slice.group_name.clone(),
                        slice.file_name.clone(),
                    )
                })
                .collect::<Vec<_>>()
        };
        assert_eq!(places(&skipped), places(&full));
        assert_eq!(skipped.slices[0].content_hash, full.slices[0].content_hash);
        assert_eq!(skipped.slices[0].bytes, full.slices[0].bytes);
        let label = &skipped.slices[1];
        assert!(label.static_group);
        assert!(label.bytes.is_empty() && label.content_hash.is_empty());
        assert_eq!((label.width, label.height), (0, 0));
    }
}
