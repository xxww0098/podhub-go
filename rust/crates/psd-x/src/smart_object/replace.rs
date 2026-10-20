/*
File: rust/crates/psd-x/src/smart_object/replace.rs

Purpose:
Embedded smart-object replace.
Patches linked-file fields; applies frame policies on resize, warp policies,
shared-resource scopes, and layer-preview policy. psdx never re-rasterizes.

Source compatibility:
- psdx-owned; no upstream ag-psd counterpart.
*/

use crate::edit::{
    DropLayerPreviewError, PreparedLayerPreview, prepare_layer_preview_change,
    prepare_layer_preview_drop,
};
use crate::image_sniff::sniff_image;
use crate::psd::{ColorMode, Layer, LinkedFile, PixelData, Psd, Units, UnitsValue};
use crate::reader;
use crate::smart_object::errors::SmartObjectError;
use crate::smart_object::frame::{apply_frame_policy, frame_quad_from_slice};
use crate::smart_object::guid::{check_guid, collect_doc_guids, generate_linked_file_guid};
use crate::smart_object::target::{
    count_linked_refs, find_linked, find_linked_mut, layer_at, layer_at_mut, resolve_one,
};
use crate::smart_object::types::{
    FramePolicy, PreviewPolicy, ReplaceReport, ReplaceScope, Replacement, WarpPolicy,
};
use crate::smart_object::warp::ensure_warp_mutable;

/// Replace the embedded bytes of the smart object identified by `target`.
///
/// If this function returns [`Err`], the attempted replacement is unapplied
/// and `psd` is observably unchanged from immediately before the call. This
/// does not provide filesystem transactions, undo/redo history, or protection
/// for direct low-level model mutations outside this editing API.
///
/// # Frame vs layer raster bounds
///
/// Updating the placement frame does **not** re-rasterize the layer. Frame
/// corners (`PlacedLayer.transform`) and layer rect / `image_data` bounds are
/// independent; they match in only about half of corpus samples. This API never
/// derives one from the other — after a resize they may be out of sync until a
/// host re-renders.
///
/// # Size change
///
/// When the replacement pixel size differs from the current placed size, the
/// chosen [`FramePolicy`] (default [`FramePolicy::KeepScale`]) updates the
/// frame. Placed `width` / `height` are always written (warp mesh domain).
/// `non_affine_transform` is cleared whenever geometry is updated (there is no
/// caller re-provide hook yet).
///
/// # Warp ([`WarpPolicy`])
///
/// Mesh coordinates are relative to the linked image size. Default
/// [`WarpPolicy::Auto`] keeps warp on same-size replace and clears it on size
/// change so the writer can synthesise an identity mesh for the new domain.
/// [`WarpPolicy::Reset`] always clears; **this is not a byte no-op** even for
/// identity meshes (~808 bytes observed on one fixture). [`WarpPolicy::Keep`]
/// leaves warp untouched (caller owns risk after a resize).
///
/// Warps whose bounds descriptor class is `classFloatRect` are read-only in
/// v1 — any policy that would clear them returns
/// [`SmartObjectError::WarpFloatRectReadOnly`]. v1 does not rescale meshes.
///
/// Same-size + default policies leave placement geometry untouched, byte for
/// byte (including any existing `non_affine_transform`).
///
/// # Preview policy
///
/// **psdx does not re-rasterize.** Callers choose layer-preview handling via
/// [`PreviewPolicy`] (`Leave` / `Provide` / `Drop`). The report **always** marks
/// layer preview, document composite, and thumbnail as stale. Document
/// composite/thumbnail are never cleared. Smart-object cache redraw on open is
/// **UNVERIFIED in Photoshop**.
///
/// # Shared linked files
///
/// - [`ReplaceScope::RequireExclusive`] (default) → [`SmartObjectError::SharedResource`]
/// - [`ReplaceScope::InPlace`] → patch the shared record; all placements see new
///   content; GUIDs unchanged
/// - [`ReplaceScope::ThisLayerOnly`] → fork a new linked-file record + GUID for
///   the target layer only; other placements stay byte-identical
pub fn replace_smart_object(
    psd: &mut Psd,
    target: &crate::smart_object::types::LayerTarget,
    replacement: Replacement<'_>,
) -> Result<ReplaceReport, SmartObjectError> {
    ensure_rgb(psd)?;

    let resolved = resolve_one(psd, target)?;
    check_guid(&resolved.linked_id)?;
    if let Some(placed_id) = resolved.placed_id.as_deref() {
        check_guid(placed_id)?;
    }

    {
        let file = find_linked(psd, &resolved.linked_id).ok_or_else(|| {
            SmartObjectError::LinkedFileNotFound {
                id: resolved.linked_id.clone(),
            }
        })?;
        reject_file_state(file)?;
        check_guid(&file.id)?;
    }

    validate_preview_policy(&replacement.preview)?;

    let refs = count_linked_refs(psd);
    let share_count = refs.get(&resolved.linked_id).copied().unwrap_or(0);
    let fork = match replacement.scope {
        ReplaceScope::RequireExclusive => {
            if share_count > 1 {
                return Err(SmartObjectError::SharedResource {
                    layer_count: share_count,
                });
            }
            false
        }
        ReplaceScope::InPlace => false,
        ReplaceScope::ThisLayerOnly => share_count > 1,
    };

    let old_size = current_size(resolved.width, resolved.height)?;
    let new_size = replacement_size(&replacement)?;
    let size_changed = new_size != old_size;

    let reset_warp = match replacement.warp {
        WarpPolicy::Keep => false,
        WarpPolicy::Reset => true,
        WarpPolicy::Auto => size_changed,
    };

    // Geometry: same-size KeepScale / KeepFrame / FitInFrame are byte no-ops.
    // Exact always installs corners. Any size change applies policy.
    let geometry = match (&replacement.frame, size_changed) {
        (FramePolicy::KeepScale | FramePolicy::KeepFrame | FramePolicy::FitInFrame, false) => None,
        (policy, _) => {
            let layer = layer_at(psd, &resolved.path).ok_or(SmartObjectError::TargetNotFound)?;
            let placed = layer
                .additional_info
                .placed_layer
                .as_ref()
                .ok_or(SmartObjectError::NotASmartObject)?;
            let current = frame_quad_from_slice(&placed.transform)?;
            Some(apply_frame_policy(&current, old_size, new_size, policy)?)
        }
    };

    if reset_warp {
        let layer = layer_at(psd, &resolved.path).ok_or(SmartObjectError::TargetNotFound)?;
        let placed = layer
            .additional_info
            .placed_layer
            .as_ref()
            .ok_or(SmartObjectError::NotASmartObject)?;
        if let Some(warp) = placed.warp.as_ref() {
            ensure_warp_mutable(warp, old_size.0 as f64, old_size.1 as f64)?;
        }
    }

    let prepared_preview = {
        let layer = layer_at(psd, &resolved.path).ok_or(SmartObjectError::TargetNotFound)?;
        prepare_preview_policy(layer, psd.color_mode, &replacement.preview)?
    };
    let forked_file = if fork {
        Some(prepare_fork_linked_file(psd, &resolved, &replacement)?)
    } else {
        None
    };

    // Commit only after every fallible calculation and preview materialization
    // has succeeded. Everything below is field assignment into locations proven
    // to exist during preparation.
    let linked_id = if let Some((new_id, new_file)) = forked_file {
        psd.linked_files.as_mut().unwrap().push(new_file);
        let layer = layer_at_mut(psd, &resolved.path).unwrap();
        layer.additional_info.placed_layer.as_mut().unwrap().id = new_id.clone();
        new_id
    } else {
        // Patch linked-file record (field-level; preserve version-selecting Options).
        let file = find_linked_mut(psd, &resolved.linked_id).unwrap();
        file.data = Some(replacement.data.to_vec());
        file.name = replacement.name.clone();
        if let Some(ft) = &replacement.file_type {
            file.file_type = ft.clone();
        }
        // creator / descriptor / child_document_id / asset_mod_time /
        // asset_locked_state / id — untouched.
        resolved.linked_id.clone()
    };

    let mut content_stretched = false;
    {
        let layer = layer_at_mut(psd, &resolved.path).unwrap();
        {
            let placed = layer.additional_info.placed_layer.as_mut().unwrap();

            if let Some(geom) = geometry {
                placed.transform = geom.transform.to_vec();
                // Stale non-affine quads would silently override the new affine frame.
                placed.non_affine_transform = None;
                content_stretched = geom.content_stretched;
                // Pixel size is the warp domain — refresh on every geometry update /
                // resize (all four frame policies). Same-size default policies skip
                // this block so same-size byte identity (sub-pixel SVG sizes) holds.
                placed.width = Some(new_size.0 as f64);
                placed.height = Some(new_size.1 as f64);
            }

            if reset_warp {
                // Clear → writer synthesises identity for current width/height.
                // Not a byte no-op (see WarpPolicy docs).
                placed.warp = None;
            }

            if let Some(dpi) = replacement.resolution {
                placed.resolution = Some(UnitsValue {
                    units: Units::Density,
                    value: dpi,
                });
            }
        }
        if let Some(preview) = prepared_preview {
            preview.apply(layer);
        }
    }

    Ok(ReplaceReport {
        path: resolved.path,
        linked_id,
        old_size,
        new_size,
        content_stretched,
        // Always stale: psdx does not re-rasterize.
        preview_stale: true,
        composite_stale: true,
        thumbnail_stale: true,
    })
}

fn prepare_fork_linked_file(
    psd: &Psd,
    resolved: &crate::smart_object::target::ResolvedPlacement,
    replacement: &Replacement<'_>,
) -> Result<(String, LinkedFile), SmartObjectError> {
    let old_id = resolved.linked_id.clone();
    let seed = format!(
        "{}|{}|{}",
        old_id,
        resolved.placed_id.as_deref().unwrap_or(""),
        resolved
            .path
            .iter()
            .map(|i| i.to_string())
            .collect::<Vec<_>>()
            .join(".")
    );
    let existing = collect_doc_guids(psd);
    let new_id = generate_linked_file_guid(&existing, &seed);

    let mut new_file = find_linked(psd, &old_id)
        .ok_or_else(|| SmartObjectError::LinkedFileNotFound { id: old_id.clone() })?
        .clone();
    new_file.id = new_id.clone();
    new_file.data = Some(replacement.data.to_vec());
    new_file.name = replacement.name.clone();
    if let Some(ft) = &replacement.file_type {
        new_file.file_type = ft.clone();
    }
    // Remaining fields cloned from the original (D6 version-selecting Options).

    Ok((new_id, new_file))
}

fn validate_preview_policy(preview: &PreviewPolicy) -> Result<(), SmartObjectError> {
    match preview {
        PreviewPolicy::Leave | PreviewPolicy::Drop => Ok(()),
        PreviewPolicy::Provide {
            width,
            height,
            rgba,
        } => {
            if *width == 0 || *height == 0 {
                return Err(SmartObjectError::InvalidPreviewBuffer {
                    expected: 0,
                    got: rgba.len(),
                });
            }
            let expected = (*width as usize)
                .saturating_mul(*height as usize)
                .saturating_mul(4);
            if rgba.len() != expected {
                return Err(SmartObjectError::InvalidPreviewBuffer {
                    expected,
                    got: rgba.len(),
                });
            }
            Ok(())
        }
    }
}

fn prepare_preview_policy(
    layer: &Layer,
    color_mode: Option<ColorMode>,
    preview: &PreviewPolicy,
) -> Result<Option<PreparedLayerPreview>, SmartObjectError> {
    match preview {
        PreviewPolicy::Leave => Ok(None),
        PreviewPolicy::Drop => prepare_layer_preview_drop(layer, color_mode)
            .map_err(map_drop_err)
            .map(Some),
        PreviewPolicy::Provide {
            width,
            height,
            rgba,
        } => {
            if color_mode != Some(ColorMode::Rgb) {
                return Err(SmartObjectError::NonRgbDocument);
            }
            prepare_layer_preview_change(layer, |prepared| {
                // Materialize so masks that only lived in raw channel bytes
                // survive after the writer's raw-data path is cleared.
                reader::materialize_layer_raw_data(prepared)
                    .map_err(|e| SmartObjectError::PreviewApplyFailed(e.to_string()))?;
                let left = prepared.left.unwrap_or(0.0);
                let top = prepared.top.unwrap_or(0.0);
                prepared.right = Some(left + f64::from(*width));
                prepared.bottom = Some(top + f64::from(*height));
                prepared.raw_data = None;
                prepared.canvas = None;
                prepared.image_data = Some(PixelData::rgba8(*width, *height, rgba.clone()));
                Ok(())
            })
            .map(Some)
        }
    }
}

fn map_drop_err(err: DropLayerPreviewError) -> SmartObjectError {
    match err {
        DropLayerPreviewError::UnsupportedColorMode(_) => SmartObjectError::NonRgbDocument,
        DropLayerPreviewError::Materialize(msg) => SmartObjectError::PreviewApplyFailed(msg),
    }
}

fn ensure_rgb(psd: &Psd) -> Result<(), SmartObjectError> {
    match psd.color_mode {
        Some(ColorMode::Rgb) => Ok(()),
        _ => Err(SmartObjectError::NonRgbDocument),
    }
}

fn reject_file_state(file: &LinkedFile) -> Result<(), SmartObjectError> {
    if file.linked_file.is_some() {
        return Err(SmartObjectError::ExternalLinkNotSupported);
    }
    if file.data.is_none() {
        return Err(SmartObjectError::LinkedDataSkipped);
    }
    Ok(())
}

fn current_size(w: Option<f64>, h: Option<f64>) -> Result<(u32, u32), SmartObjectError> {
    let (Some(w), Some(h)) = (w, h) else {
        return Err(SmartObjectError::CurrentSizeUnknown);
    };
    // Placed-layer sizes are f64. Most corpus samples are integral; a few
    // (embedded SVG) carry sub-pixel values. Round to the nearest pixel for
    // size comparison; stored fields are overwritten with the replacement size.
    let rw = w.round();
    let rh = h.round();
    if w <= 0.0 || h <= 0.0 || rw < 1.0 || rh < 1.0 {
        return Err(SmartObjectError::CurrentSizeUnknown);
    }
    Ok((rw as u32, rh as u32))
}

fn replacement_size(replacement: &Replacement<'_>) -> Result<(u32, u32), SmartObjectError> {
    if let Some(size) = replacement.size {
        if size.0 == 0 || size.1 == 0 {
            return Err(SmartObjectError::SizeUnknown);
        }
        return Ok(size);
    }
    let sniff = sniff_image(replacement.data);
    match (sniff.width, sniff.height) {
        (Some(w), Some(h)) if w > 0 && h > 0 => Ok((w, h)),
        _ => Err(SmartObjectError::SizeUnknown),
    }
}
