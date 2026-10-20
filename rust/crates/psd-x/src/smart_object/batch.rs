//! Atomic multi-smart-object replacement for a single parsed PSD.
//!
//! A batch resolves every target up front, rejects overlapping placements and
//! shared linked resources, then applies replacements against stable layer
//! paths. If any item fails, a sparse journal restores only the touched layers
//! and linked-file records; the document tree and unrelated raster data are not
//! cloned.

use std::collections::{HashMap, HashSet};
use std::fmt;

use crate::psd::{Layer, LinkedFile, Psd};
use crate::smart_object::errors::SmartObjectError;
use crate::smart_object::replace::replace_smart_object;
use crate::smart_object::target::{layer_at, layer_at_mut, resolve_one};
use crate::smart_object::types::{
    FramePolicy, LayerTarget, PreviewPolicy, ReplaceReport, ReplaceScope, Replacement, WarpPolicy,
};

/// Observable lifecycle of a [`SmartObjectBatch`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BatchState {
    /// Items may be queued.
    Draft,
    /// Targets and rollback records are being prepared.
    Validating,
    /// Validation completed and stable paths were captured.
    Ready,
    /// Replacements are being committed.
    Applying,
    /// Every replacement committed successfully.
    Applied,
    /// At least one committed item was restored after a later failure.
    RolledBack,
    /// Validation failed before any mutation occurred.
    Failed,
}

/// Owned replacement input suitable for queuing in a batch.
#[derive(Debug, Clone)]
pub struct BatchItem {
    /// Smart-object placement to replace.
    pub target: LayerTarget,
    /// New embedded file bytes.
    pub data: Vec<u8>,
    /// Linked-file display name.
    pub name: String,
    /// Replacement pixel size; `None` sniffs the embedded bytes.
    pub size: Option<(u32, u32)>,
    /// File-type tag policy; see [`Replacement::file_type`].
    pub file_type: Option<Option<String>>,
    /// Optional placed-layer resolution.
    pub resolution: Option<f64>,
    /// Frame resize policy.
    pub frame: FramePolicy,
    /// Warp policy.
    pub warp: WarpPolicy,
    /// Layer preview policy.
    pub preview: PreviewPolicy,
    /// Shared linked-file mutation policy.
    pub scope: ReplaceScope,
}

impl BatchItem {
    /// Create an item with the same safe defaults as [`Replacement::new`].
    pub fn new(target: LayerTarget, data: impl Into<Vec<u8>>, name: impl Into<String>) -> Self {
        Self {
            target,
            data: data.into(),
            name: name.into(),
            size: None,
            file_type: None,
            resolution: None,
            frame: FramePolicy::default(),
            warp: WarpPolicy::default(),
            preview: PreviewPolicy::default(),
            scope: ReplaceScope::default(),
        }
    }

    fn replacement(&self) -> Replacement<'_> {
        Replacement {
            data: &self.data,
            name: self.name.clone(),
            size: self.size,
            file_type: self.file_type.clone(),
            resolution: self.resolution,
            frame: self.frame.clone(),
            warp: self.warp,
            preview: self.preview.clone(),
            scope: self.scope,
        }
    }
}

/// Successful outcome of an atomic batch.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BatchReport {
    /// Terminal state. Successful reports always contain [`BatchState::Applied`].
    pub state: BatchState,
    /// Per-item reports in queue order.
    pub items: Vec<ReplaceReport>,
}

/// Failure while validating or applying a smart-object batch.
#[derive(Debug)]
pub enum BatchError {
    /// No replacements were queued.
    Empty,
    /// The operation is not allowed in the current state.
    InvalidState {
        /// State required by the operation.
        expected: BatchState,
        /// Current batch state.
        actual: BatchState,
    },
    /// Two queue entries resolve to the same placed layer.
    DuplicateTarget {
        /// Earlier item index.
        first: usize,
        /// Later item index.
        second: usize,
        /// Stable document-tree path shared by both items.
        path: Vec<usize>,
    },
    /// Two queue entries refer to the same linked-file record.
    ///
    /// Such a batch would be order-dependent under `InPlace`/`ThisLayerOnly`,
    /// so callers must split it or target distinct linked resources.
    ConflictingLinkedResource {
        /// Earlier item index.
        first: usize,
        /// Later item index.
        second: usize,
        /// Shared linked-file GUID.
        linked_id: String,
    },
    /// One item failed target resolution, validation, or replacement.
    Item {
        /// Queue index of the failing item.
        index: usize,
        /// Existing single-replacement error.
        source: SmartObjectError,
    },
}

impl fmt::Display for BatchError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Empty => f.write_str("smart-object batch is empty"),
            Self::InvalidState { expected, actual } => {
                write!(f, "batch state is {actual:?}; expected {expected:?}")
            }
            Self::DuplicateTarget {
                first,
                second,
                path,
            } => write!(
                f,
                "batch items {first} and {second} resolve to the same layer path {path:?}"
            ),
            Self::ConflictingLinkedResource {
                first,
                second,
                linked_id,
            } => write!(
                f,
                "batch items {first} and {second} share linked resource {linked_id}"
            ),
            Self::Item { index, source } => {
                write!(f, "smart-object batch item {index} failed: {source}")
            }
        }
    }
}

impl std::error::Error for BatchError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Item { source, .. } => Some(source),
            _ => None,
        }
    }
}

/// Atomic queue for replacing multiple smart objects in one parsed PSD.
///
/// Parsing and serialization stay outside the batch, so one template can be
/// opened once, receive many inputs, and be written once. Rollback clones only
/// the targeted layers and linked-file records rather than the full document.
#[derive(Debug, Default)]
pub struct SmartObjectBatch {
    items: Vec<BatchItem>,
    state: BatchState,
}

impl Default for BatchState {
    fn default() -> Self {
        Self::Draft
    }
}

impl SmartObjectBatch {
    /// Create an empty draft batch.
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Current lifecycle state.
    #[must_use]
    pub fn state(&self) -> BatchState {
        self.state
    }

    /// Number of queued replacements.
    #[must_use]
    pub fn len(&self) -> usize {
        self.items.len()
    }

    /// Whether no replacements are queued.
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.items.is_empty()
    }

    /// Queue one replacement. Items can only be added while the batch is a draft.
    pub fn push(&mut self, item: BatchItem) -> Result<&mut Self, BatchError> {
        if self.state != BatchState::Draft {
            return Err(BatchError::InvalidState {
                expected: BatchState::Draft,
                actual: self.state,
            });
        }
        self.items.push(item);
        Ok(self)
    }

    /// Validate and atomically apply all queued replacements.
    ///
    /// Targets are converted to stable layer paths before the first mutation.
    /// On an item failure, every earlier mutation from this call is restored.
    pub fn execute(&mut self, psd: &mut Psd) -> Result<BatchReport, BatchError> {
        if self.state != BatchState::Draft {
            return Err(BatchError::InvalidState {
                expected: BatchState::Draft,
                actual: self.state,
            });
        }
        if self.items.is_empty() {
            self.state = BatchState::Failed;
            return Err(BatchError::Empty);
        }

        self.state = BatchState::Validating;
        let prepared = match PreparedBatch::try_new(psd, &self.items) {
            Ok(prepared) => prepared,
            Err(error) => {
                self.state = BatchState::Failed;
                return Err(error);
            }
        };

        self.state = BatchState::Ready;
        self.state = BatchState::Applying;
        let mut reports = Vec::with_capacity(self.items.len());

        for prepared_item in &prepared.items {
            let replacement = self.items[prepared_item.index].replacement();
            let stable_target = LayerTarget::Path(prepared_item.path.clone());
            match replace_smart_object(psd, &stable_target, replacement) {
                Ok(report) => reports.push(report),
                Err(source) => {
                    prepared.journal.rollback(psd);
                    self.state = BatchState::RolledBack;
                    return Err(BatchError::Item {
                        index: prepared_item.index,
                        source,
                    });
                }
            }
        }

        self.state = BatchState::Applied;
        Ok(BatchReport {
            state: self.state,
            items: reports,
        })
    }
}

struct PreparedBatch {
    items: Vec<PreparedItem>,
    journal: RollbackJournal,
}

impl PreparedBatch {
    fn try_new(psd: &Psd, items: &[BatchItem]) -> Result<Self, BatchError> {
        let mut seen_paths = HashMap::<Vec<usize>, usize>::with_capacity(items.len());
        let mut seen_links = HashMap::<String, usize>::with_capacity(items.len());
        let mut prepared = Vec::with_capacity(items.len());
        let mut layer_backups = Vec::with_capacity(items.len());
        let mut linked_indices = HashSet::with_capacity(items.len());
        let mut linked_backups = Vec::with_capacity(items.len());

        for (index, item) in items.iter().enumerate() {
            let resolved = resolve_one(psd, &item.target)
                .map_err(|source| BatchError::Item { index, source })?;

            if let Some(first) = seen_paths.insert(resolved.path.clone(), index) {
                return Err(BatchError::DuplicateTarget {
                    first,
                    second: index,
                    path: resolved.path,
                });
            }
            if let Some(first) = seen_links.insert(resolved.linked_id.clone(), index) {
                return Err(BatchError::ConflictingLinkedResource {
                    first,
                    second: index,
                    linked_id: resolved.linked_id,
                });
            }

            let layer = layer_at(psd, &resolved.path)
                .ok_or_else(|| BatchError::Item {
                    index,
                    source: SmartObjectError::TargetNotFound,
                })?
                .clone();
            layer_backups.push((resolved.path.clone(), layer));

            let linked_index = psd
                .linked_files
                .as_deref()
                .and_then(|files| files.iter().position(|file| file.id == resolved.linked_id))
                .ok_or_else(|| BatchError::Item {
                    index,
                    source: SmartObjectError::LinkedFileNotFound {
                        id: resolved.linked_id.clone(),
                    },
                })?;
            if linked_indices.insert(linked_index) {
                let linked = psd.linked_files.as_deref().unwrap()[linked_index].clone();
                linked_backups.push((linked_index, linked));
            }

            prepared.push(PreparedItem {
                index,
                path: resolved.path,
            });
        }

        Ok(Self {
            items: prepared,
            journal: RollbackJournal {
                layers: layer_backups,
                linked_files: linked_backups,
                original_linked_len: psd.linked_files.as_deref().map_or(0, |files| files.len()),
            },
        })
    }
}

struct PreparedItem {
    index: usize,
    path: Vec<usize>,
}

struct RollbackJournal {
    layers: Vec<(Vec<usize>, Layer)>,
    linked_files: Vec<(usize, LinkedFile)>,
    original_linked_len: usize,
}

impl RollbackJournal {
    fn rollback(&self, psd: &mut Psd) {
        if let Some(files) = psd.linked_files.as_mut() {
            files.truncate(self.original_linked_len);
            for (index, original) in &self.linked_files {
                files[*index] = original.clone();
            }
        }
        for (path, original) in &self.layers {
            if let Some(layer) = layer_at_mut(psd, path) {
                *layer = original.clone();
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn new_batch_is_an_empty_draft() {
        let batch = SmartObjectBatch::new();
        assert_eq!(batch.state(), BatchState::Draft);
        assert!(batch.is_empty());
    }

    #[test]
    fn owned_item_uses_single_replace_defaults() {
        let item = BatchItem::new(LayerTarget::Path(vec![0]), vec![1, 2, 3], "input.png");
        let replacement = item.replacement();
        assert_eq!(replacement.data, &[1, 2, 3]);
        assert_eq!(replacement.name, "input.png");
        assert_eq!(replacement.frame, FramePolicy::KeepScale);
        assert_eq!(replacement.warp, WarpPolicy::Auto);
        assert_eq!(replacement.preview, PreviewPolicy::Leave);
        assert_eq!(replacement.scope, ReplaceScope::RequireExclusive);
    }

    #[test]
    fn push_is_rejected_after_state_leaves_draft() {
        let mut batch = SmartObjectBatch::new();
        batch.state = BatchState::Failed;
        let error = batch
            .push(BatchItem::new(LayerTarget::Path(vec![0]), Vec::new(), "x"))
            .expect_err("terminal batch must reject new work");
        assert!(matches!(error, BatchError::InvalidState { .. }));
    }
}
