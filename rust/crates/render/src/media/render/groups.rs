use super::{RenderSlice, ResourceObservations};
use crate::media::delivery::MemoryDelivery;
use crate::media::document::LinkedSourceCache;
use crate::media::encode::encode_jpeg_rows_to_writer;
use crate::media::error::{MediaError, MediaErrorCode};
use crate::media::intent::RenderIntent;
use crate::media::model::ExportPlan;
use crate::media::slab::{
    LINKED_MEMO_REPORT_PREFIX, SlabConfig, SlabObservations, SlabRgbaRows, WindowRgbaRows,
    prepare_group_export,
};
use std::collections::HashMap;

#[derive(Debug)]
pub(super) struct GroupTask {
    pub(super) group_index: usize,
    pub(super) output_file_name: String,
    pub(super) policy: crate::psd::ProductResourcePolicy,
    pub(super) live_bytes: u64,
    pub(super) static_group: bool,
}

/// A static group left unrendered under `StaticGroups::Skip`: the slice keeps
/// its place and name so the caller can fill it from its cache in order.
pub(super) fn skipped_group(
    group_index: usize,
    group_name: &str,
    output_file_name: String,
) -> GroupCompletion {
    GroupCompletion {
        group_index,
        slice: RenderSlice {
            group_name: group_name.to_owned(),
            index: group_index as u32,
            file_name: output_file_name,
            width: 0,
            height: 0,
            content_hash: String::new(),
            static_group: true,
            bytes: Vec::new(),
            encode_ms: 0,
        },
        observations: None,
        encoded_bytes: 0,
        live_bytes: 0,
    }
}

#[derive(Debug)]
pub(super) struct GroupCompletion {
    pub(super) group_index: usize,
    pub(super) slice: RenderSlice,
    pub(super) observations: Option<SlabObservations>,
    pub(super) encoded_bytes: u64,
    pub(super) live_bytes: u64,
}

#[allow(clippy::too_many_arguments)]
pub(super) fn render_group_task(
    task: GroupTask,
    document: &crate::psd::RenderDocument,
    plan: &ExportPlan,
    replacements: &HashMap<String, crate::psd::SourceContent>,
    intent: &RenderIntent,
    slab_config: SlabConfig,
    delivery: &mut MemoryDelivery,
    linked_sources: &LinkedSourceCache,
    shared_resident_bytes: u64,
) -> Result<GroupCompletion, MediaError> {
    let group = plan.groups.get(task.group_index).ok_or_else(|| {
        MediaError::new(
            MediaErrorCode::GroupsNotFound,
            "group-scheduling",
            "scheduled export group disappeared",
        )
    })?;
    let prepared = prepare_group_export(
        document,
        group,
        replacements,
        intent.export_bounds,
        intent.export_scale,
        slab_config,
        task.policy,
        None,
        Some(linked_sources),
        shared_resident_bytes,
    )?;
    let encode_started = crate::media::stage_timing::start();
    let encoded = if let Some(window) = prepared.reuse_window() {
        let rows = WindowRgbaRows::new(window, document, group, &prepared, None);
        delivery.write_streamed_slice(&task.output_file_name, |writer| {
            encode_jpeg_rows_to_writer(
                &rows,
                writer,
                intent.presentation_quality,
                task.policy.max_encoded_bytes,
            )
        })?
    } else {
        let rows = SlabRgbaRows::new(
            document,
            group,
            replacements,
            prepared.clone(),
            slab_config,
            None,
            Some(linked_sources),
        );
        delivery.write_streamed_slice(&task.output_file_name, |writer| {
            encode_jpeg_rows_to_writer(
                &rows,
                writer,
                intent.presentation_quality,
                task.policy.max_encoded_bytes,
            )
        })?
    };
    let encode_ms = crate::media::stage_timing::elapsed_ms(encode_started);
    crate::media::stage_timing::record(
        crate::media::stage_timing::Stage::EncodeTotal,
        encode_started,
    );
    Ok(GroupCompletion {
        group_index: task.group_index,
        slice: RenderSlice {
            group_name: group.name.clone(),
            index: task.group_index as u32,
            file_name: task.output_file_name,
            width: prepared.output_width,
            height: prepared.output_height,
            content_hash: encoded.content_hash,
            static_group: task.static_group,
            // The encoded bytes are held by `delivery` until every group has
            // run; the caller matches them back onto `file_name`.
            bytes: Vec::new(),
            encode_ms,
        },
        observations: Some(prepared.observations),
        encoded_bytes: encoded.bytes_written,
        live_bytes: task.live_bytes,
    })
}

pub(super) fn merge_group_observations(
    completion: &GroupCompletion,
    observations: &mut ResourceObservations,
) {
    observations.encoded_high_water_bytes = observations
        .encoded_high_water_bytes
        .max(completion.encoded_bytes);
    let Some(group) = completion.observations.as_ref() else {
        return;
    };
    observations.slab_reserved_bytes = observations.slab_reserved_bytes.max(group.reserved_bytes);
    observations.slab_rows = group.rows;
    observations.slab_halo_rows = group.halo_rows;
    observations.working_set_peak_bytes = observations
        .working_set_peak_bytes
        .max(group.working_set_bytes);
    if let Some(report) = live_ceiling_report(group.working_set_bytes, completion.live_bytes) {
        observations.live_slot_exceeded = true;
        observations
            .degradations
            .push(format!("group {}: {report}", completion.group_index + 1));
    }
    observations.placed_prep_drops = observations
        .placed_prep_drops
        .saturating_add(group.placed_prep_drops);
    if !group.reuse_window_retained {
        observations.reuse_window_refusals = observations.reuse_window_refusals.saturating_add(1);
    }
    for degradation in &group.degradations {
        if degradation.starts_with(LINKED_MEMO_REPORT_PREFIX) {
            observations
                .degradations
                .retain(|line| !line.contains(LINKED_MEMO_REPORT_PREFIX));
        }
        observations.degradations.push(format!(
            "group {}: {degradation}",
            completion.group_index + 1
        ));
    }
}

pub(super) fn flush_group_completions(
    completed: &mut [Option<GroupCompletion>],
    next_group: &mut usize,
    slices: &mut Vec<RenderSlice>,
    observations: &mut ResourceObservations,
) {
    while let Some(completion) = completed.get_mut(*next_group).and_then(Option::take) {
        merge_group_observations(&completion, observations);
        slices.push(completion.slice);
        *next_group += 1;
    }
}

/// Report an unexpected group working set without changing output behaviour.
/// The admission formula is rounded up, so a report is evidence that a term
/// escaped its accounting and is kept for the manifest/corpus investigation.
pub(super) fn live_ceiling_report(
    working_set_peak_bytes: u64,
    live_slot_bytes: u64,
) -> Option<String> {
    let over = working_set_peak_bytes
        .checked_sub(live_slot_bytes)
        .filter(|over| *over > 0)?;
    Some(format!(
        "live ceiling exceeded: a {working_set_peak_bytes} byte group working set is {over} over \
         its {live_slot_bytes} byte geometry-derived live ceiling"
    ))
}
