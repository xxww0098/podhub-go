//! SoLd / PlLd smart-filter tree (`filterFX`).
//!
//! Upstream: `parseFilterFX` / `parseFilterFXItem` / `serializeFilterFXItem`
//! in `additionalInfo.ts` (~2100-3407). 64 filter conversions
//! (51 classID + 13 filterID-only).

mod enums;
mod parse;
mod serialize;
mod util;

pub use parse::{parse_filter_fx, parse_filter_fx_item};
pub use serialize::serialize_filter_fx_item;

use crate::descriptor::{Descriptor, DescriptorValue};
use crate::psd::PlacedLayerFilter;

/// Serialize a placed-layer filter tree into a `filterFX` descriptor.
pub fn serialize_filter_fx(filter: &PlacedLayerFilter) -> Descriptor {
    // fieldToExtType filterFX → filterFXStyle
    let mut d = Descriptor::new("", "filterFXStyle");
    d.set("enab", DescriptorValue::Boolean(filter.enabled));
    d.set(
        "validAtPosition",
        DescriptorValue::Boolean(filter.valid_at_position),
    );
    d.set(
        "filterMaskEnable",
        DescriptorValue::Boolean(filter.mask_enabled),
    );
    d.set(
        "filterMaskLinked",
        DescriptorValue::Boolean(filter.mask_linked),
    );
    d.set(
        "filterMaskExtendWithWhite",
        DescriptorValue::Boolean(filter.mask_extend_with_white),
    );
    let list: Vec<DescriptorValue> = filter
        .list
        .iter()
        .map(|f| DescriptorValue::Descriptor(serialize_filter_fx_item(f)))
        .collect();
    d.set("filterFXList", DescriptorValue::List(list));
    d
}
