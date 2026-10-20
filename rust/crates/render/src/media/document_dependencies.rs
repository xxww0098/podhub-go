use crate::media::model::ExportGroup;
use crate::psd::{LayerNode, RenderDocument};
use std::collections::{BTreeSet, HashMap};

/// Whether one exported top-level group can observe the selected replacement.
///
/// A placed-layer replacement is keyed by linked-file ID, and embedded PSDs
/// can contain that ID beneath another placed layer. A direct-ID check would
/// therefore incorrectly reuse an outer group as static. Missing, cyclic, or
/// unparsable linked content stays dynamic so cache reuse can never hide the
/// renderer's normal fail-closed path.
pub(crate) fn export_group_depends_on_replacement(
    document: &RenderDocument,
    group: &ExportGroup,
    replacement_id: &str,
    top_level_dependencies: &mut HashMap<String, bool>,
    limits: crate::psd::Limits,
) -> bool {
    let Some(layer) = document.children.get(group.layer_index) else {
        return true;
    };
    top_level_layers_depend_on_replacement(
        document,
        std::slice::from_ref(layer),
        replacement_id,
        top_level_dependencies,
        limits,
    )
}

fn top_level_layers_depend_on_replacement(
    document: &RenderDocument,
    layers: &[LayerNode],
    replacement_id: &str,
    dependencies: &mut HashMap<String, bool>,
    limits: crate::psd::Limits,
) -> bool {
    for layer in layers {
        if let Some(placed) = &layer.placed {
            if placed.id == replacement_id {
                return true;
            }
            let reaches_replacement = *dependencies.entry(placed.id.clone()).or_insert_with(|| {
                linked_source_depends_on_replacement(
                    document,
                    &placed.id,
                    replacement_id,
                    &BTreeSet::new(),
                    limits,
                )
            });
            if reaches_replacement {
                return true;
            }
        }
        if top_level_layers_depend_on_replacement(
            document,
            &layer.children,
            replacement_id,
            dependencies,
            limits,
        ) {
            return true;
        }
    }
    false
}

fn nested_layers_depend_on_replacement(
    document: &RenderDocument,
    layers: &[LayerNode],
    replacement_id: &str,
    chain: &BTreeSet<String>,
    limits: crate::psd::Limits,
) -> bool {
    for layer in layers {
        if let Some(placed) = &layer.placed
            && (placed.id == replacement_id
                || linked_source_depends_on_replacement(
                    document,
                    &placed.id,
                    replacement_id,
                    chain,
                    limits,
                ))
        {
            return true;
        }
        if nested_layers_depend_on_replacement(
            document,
            &layer.children,
            replacement_id,
            chain,
            limits,
        ) {
            return true;
        }
    }
    false
}

fn linked_source_depends_on_replacement(
    document: &RenderDocument,
    linked_id: &str,
    replacement_id: &str,
    chain: &BTreeSet<String>,
    limits: crate::psd::Limits,
) -> bool {
    if chain.contains(linked_id) {
        return true;
    }
    let Some(bytes) = document
        .linked_files
        .iter()
        .find(|file| file.id == linked_id)
        .map(|file| file.bytes.as_slice())
    else {
        return true;
    };
    if !crate::media::source::is_psd_bytes(bytes) {
        return false;
    }
    let Ok(linked) = crate::psd::render::load_render_document(bytes, limits) else {
        return true;
    };
    let mut nested_chain = chain.clone();
    nested_chain.insert(linked_id.to_owned());
    nested_layers_depend_on_replacement(
        &linked,
        &linked.children,
        replacement_id,
        &nested_chain,
        limits,
    )
}
