/*
File: crates/psd-x/src/smart_object/target.rs

Purpose:
Resolve [`LayerTarget`] against a document tree and list smart-object placements.

Source compatibility:
- psdx-owned; no upstream ag-psd counterpart.
*/

use std::collections::HashMap;

use crate::psd::{Layer, LinkedFile, Psd};
use crate::smart_object::errors::SmartObjectError;
use crate::smart_object::guid::check_guid;
use crate::smart_object::types::{LayerTarget, SmartObjectInfo};

#[derive(Debug, Clone)]
pub(crate) struct ResolvedPlacement {
    pub path: Vec<usize>,
    pub linked_id: String,
    pub placed_id: Option<String>,
    pub width: Option<f64>,
    pub height: Option<f64>,
    pub layer_name: Option<String>,
    pub layer_id: Option<u32>,
}

/// List smart objects matching `target` (empty [`LayerTarget::Path`] = whole document).
pub fn find_smart_objects(psd: &Psd, target: &LayerTarget) -> Vec<SmartObjectInfo> {
    if validate_target_guid(target).is_err() {
        return Vec::new();
    }
    let placements = match target {
        LayerTarget::Path(path) if path.is_empty() => collect_all(psd),
        LayerTarget::Path(path) => match layer_at(psd, path) {
            Some(layer) if layer.additional_info.placed_layer.is_some() => {
                vec![placement_of(path.clone(), layer)]
            }
            _ => Vec::new(),
        },
        _ => collect_all(psd)
            .into_iter()
            .filter(|p| matches_placement(p, target))
            .collect(),
    };
    let link_counts = count_linked_refs(psd);
    placements
        .into_iter()
        .map(|p| to_info(psd, p, &link_counts))
        .collect()
}

/// Resolve exactly one smart-object layer for replace.
pub(crate) fn resolve_one(
    psd: &Psd,
    target: &LayerTarget,
) -> Result<ResolvedPlacement, SmartObjectError> {
    validate_target_guid(target)?;
    match target {
        LayerTarget::Path(path) if path.is_empty() => Err(SmartObjectError::AmbiguousTarget {
            count: collect_all(psd).len().max(1),
        }),
        LayerTarget::Path(path) => {
            let layer = layer_at(psd, path).ok_or(SmartObjectError::TargetNotFound)?;
            if layer.additional_info.placed_layer.is_none() {
                return Err(SmartObjectError::NotASmartObject);
            }
            Ok(placement_of(path.clone(), layer))
        }
        LayerTarget::Name(name) => {
            let hits = collect_named(psd, name);
            resolve_hits(hits)
        }
        LayerTarget::LayerId(id) => {
            let want = *id as f64;
            let hits = collect_by(|layer| layer.additional_info.id == Some(want), psd);
            resolve_hits(hits)
        }
        LayerTarget::PlacedId(id) => {
            let hits = collect_all(psd)
                .into_iter()
                .filter(|p| p.placed_id.as_deref() == Some(id.as_str()))
                .collect::<Vec<_>>();
            match hits.len() {
                0 => Err(SmartObjectError::TargetNotFound),
                1 => Ok(hits.into_iter().next().unwrap()),
                n => Err(SmartObjectError::AmbiguousTarget { count: n }),
            }
        }
        LayerTarget::LinkedId(id) => {
            let hits = collect_all(psd)
                .into_iter()
                .filter(|p| p.linked_id == *id)
                .collect::<Vec<_>>();
            match hits.len() {
                0 => Err(SmartObjectError::TargetNotFound),
                1 => Ok(hits.into_iter().next().unwrap()),
                // Same linked id on multiple placements is a shared resource, not a
                // vague name clash — surface the dedicated error.
                n => Err(SmartObjectError::SharedResource { layer_count: n }),
            }
        }
    }
}

enum LayerHit {
    Smart(ResolvedPlacement),
    NotSmart,
}

fn resolve_hits(hits: Vec<LayerHit>) -> Result<ResolvedPlacement, SmartObjectError> {
    let mut smart = Vec::new();
    let mut saw_non_smart = false;
    for hit in hits {
        match hit {
            LayerHit::Smart(p) => smart.push(p),
            LayerHit::NotSmart => saw_non_smart = true,
        }
    }
    match smart.len() {
        1 => Ok(smart.into_iter().next().unwrap()),
        0 if saw_non_smart => Err(SmartObjectError::NotASmartObject),
        0 => Err(SmartObjectError::TargetNotFound),
        n => Err(SmartObjectError::AmbiguousTarget { count: n }),
    }
}

fn validate_target_guid(target: &LayerTarget) -> Result<(), SmartObjectError> {
    match target {
        LayerTarget::PlacedId(id) | LayerTarget::LinkedId(id) => check_guid(id),
        _ => Ok(()),
    }
}

fn matches_placement(p: &ResolvedPlacement, target: &LayerTarget) -> bool {
    match target {
        LayerTarget::LayerId(id) => p.layer_id == Some(*id),
        LayerTarget::PlacedId(id) => p.placed_id.as_deref() == Some(id.as_str()),
        LayerTarget::LinkedId(id) => p.linked_id == *id,
        LayerTarget::Name(name) => p.layer_name.as_deref() == Some(name.as_str()),
        LayerTarget::Path(_) => true,
    }
}

fn collect_all(psd: &Psd) -> Vec<ResolvedPlacement> {
    let mut out = Vec::new();
    walk_all(
        psd.children.as_deref().unwrap_or(&[]),
        &mut Vec::new(),
        &mut out,
    );
    out
}

fn collect_named(psd: &Psd, name: &str) -> Vec<LayerHit> {
    collect_by(
        |layer| layer.additional_info.name.as_deref() == Some(name),
        psd,
    )
}

fn collect_by(pred: impl Fn(&Layer) -> bool, psd: &Psd) -> Vec<LayerHit> {
    let mut out = Vec::new();
    fn walk(
        layers: &[Layer],
        path: &mut Vec<usize>,
        pred: &dyn Fn(&Layer) -> bool,
        out: &mut Vec<LayerHit>,
    ) {
        for (i, layer) in layers.iter().enumerate() {
            path.push(i);
            if pred(layer) {
                if layer.additional_info.placed_layer.is_some() {
                    out.push(LayerHit::Smart(placement_of(path.clone(), layer)));
                } else {
                    out.push(LayerHit::NotSmart);
                }
            }
            if let Some(children) = layer.children.as_deref() {
                walk(children, path, pred, out);
            }
            path.pop();
        }
    }
    walk(
        psd.children.as_deref().unwrap_or(&[]),
        &mut Vec::new(),
        &pred,
        &mut out,
    );
    out
}

fn walk_all(layers: &[Layer], path: &mut Vec<usize>, out: &mut Vec<ResolvedPlacement>) {
    for (i, layer) in layers.iter().enumerate() {
        path.push(i);
        if layer.additional_info.placed_layer.is_some() {
            out.push(placement_of(path.clone(), layer));
        }
        if let Some(children) = layer.children.as_deref() {
            walk_all(children, path, out);
        }
        path.pop();
    }
}

fn placement_of(path: Vec<usize>, layer: &Layer) -> ResolvedPlacement {
    let placed = layer.additional_info.placed_layer.as_ref().unwrap();
    ResolvedPlacement {
        path,
        linked_id: placed.id.clone(),
        placed_id: placed.placed.clone(),
        width: placed.width,
        height: placed.height,
        layer_name: layer.additional_info.name.clone(),
        layer_id: layer.additional_info.id.map(|v| v as u32),
    }
}

pub(crate) fn layer_at<'a>(psd: &'a Psd, path: &[usize]) -> Option<&'a Layer> {
    let mut layers = psd.children.as_deref()?;
    let mut current: Option<&Layer> = None;
    for &idx in path {
        let layer = layers.get(idx)?;
        current = Some(layer);
        layers = layer.children.as_deref().unwrap_or(&[]);
    }
    current
}

pub(crate) fn layer_at_mut<'a>(psd: &'a mut Psd, path: &[usize]) -> Option<&'a mut Layer> {
    fn walk<'b>(layers: &'b mut [Layer], path: &[usize]) -> Option<&'b mut Layer> {
        let (&idx, rest) = path.split_first()?;
        let layer = layers.get_mut(idx)?;
        if rest.is_empty() {
            Some(layer)
        } else {
            walk(layer.children.as_mut()?.as_mut_slice(), rest)
        }
    }
    walk(psd.children.as_mut()?.as_mut_slice(), path)
}

pub(crate) fn count_linked_refs(psd: &Psd) -> HashMap<String, usize> {
    let mut map = HashMap::new();
    fn walk(layers: &[Layer], map: &mut HashMap<String, usize>) {
        for layer in layers {
            if let Some(placed) = layer.additional_info.placed_layer.as_ref() {
                *map.entry(placed.id.clone()).or_insert(0) += 1;
            }
            if let Some(children) = layer.children.as_deref() {
                walk(children, map);
            }
        }
    }
    walk(psd.children.as_deref().unwrap_or(&[]), &mut map);
    map
}

fn to_info(
    psd: &Psd,
    p: ResolvedPlacement,
    link_counts: &HashMap<String, usize>,
) -> SmartObjectInfo {
    let file = find_linked(psd, &p.linked_id);
    let shared = link_counts.get(&p.linked_id).copied().unwrap_or(0) > 1;
    SmartObjectInfo {
        path: p.path,
        layer_name: p.layer_name,
        layer_id: p.layer_id,
        placed_id: p.placed_id,
        linked_id: p.linked_id,
        width: p.width,
        height: p.height,
        file_name: file.map(|f| f.name.clone()),
        shared,
        has_embedded_data: file.and_then(|f| f.data.as_ref()).is_some(),
        is_external: file.and_then(|f| f.linked_file.as_ref()).is_some(),
    }
}

pub(crate) fn find_linked<'a>(psd: &'a Psd, id: &str) -> Option<&'a LinkedFile> {
    psd.linked_files
        .as_deref()
        .and_then(|files| files.iter().find(|f| f.id == id))
}

pub(crate) fn find_linked_mut<'a>(psd: &'a mut Psd, id: &str) -> Option<&'a mut LinkedFile> {
    psd.linked_files
        .as_mut()
        .and_then(|files| files.iter_mut().find(|f| f.id == id))
}

/// GUID association invariant: every placed layer's linked id resolves to exactly one record.
pub fn guid_associations_hold(psd: &Psd) -> bool {
    let files = psd.linked_files.as_deref().unwrap_or(&[]);
    let mut ok = true;
    fn walk(layers: &[Layer], files: &[LinkedFile], ok: &mut bool) {
        for layer in layers {
            if let Some(placed) = layer.additional_info.placed_layer.as_ref() {
                let n = files.iter().filter(|f| f.id == placed.id).count();
                if n != 1 {
                    *ok = false;
                }
            }
            if let Some(children) = layer.children.as_deref() {
                walk(children, files, ok);
            }
        }
    }
    walk(psd.children.as_deref().unwrap_or(&[]), files, &mut ok);
    ok
}
