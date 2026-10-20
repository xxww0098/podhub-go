pub(super) use crate::psd::render::{RenderDocument, SourceContent};

#[derive(Debug, Clone)]
pub(super) struct SlotInfo {
    pub id: String,
    pub name: String,
    pub src_w: u32,
    pub src_h: u32,
    pub document_instances: u32,
    pub exported_instances: u32,
    pub depth: u32,
    pub parent_id: Option<String>,
}

#[derive(Debug, Clone)]
pub(super) struct ExportRect {
    pub left: i64,
    pub top: i64,
    pub right: i64,
    pub bottom: i64,
}

#[derive(Debug, Clone)]
pub(super) struct ExportGroup {
    pub name: String,
    pub layer_index: usize,
    pub bounds: ExportRect,
}

#[derive(Debug, Clone)]
pub(super) struct ExportPlan {
    pub groups: Vec<ExportGroup>,
}
