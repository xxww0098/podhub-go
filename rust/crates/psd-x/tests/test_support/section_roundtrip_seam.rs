//! Prove integration tests can use the unique section harness.
//!
//! Run: `cargo test -p psdx --features test-support --test test_support section_roundtrip`
//!
//! Lives in the `test_support` harness (`required-features = ["test-support"]`)
//! so default `cargo test -p psdx` does not compile this suite.

use psdx::additional_info::test_support::{self, Harness};
use psdx::psd::LayerAdditionalInfo;

#[test]
fn integration_uses_shared_section_harness() {
    let mut info = LayerAdditionalInfo::default();
    info.name = Some("section-seam".to_string());
    info.id = Some(7.0);

    let out = test_support::roundtrip(&info);
    assert_eq!(out.name.as_deref(), Some("section-seam"));
    assert_eq!(out.id, Some(7.0));
}

#[test]
fn harness_builder_roundtrip_matches_convenience() {
    let mut info = LayerAdditionalInfo::default();
    info.name = Some("builder".to_string());

    let via_builder = Harness::new().roundtrip(&info);
    let via_fn = test_support::roundtrip(&info);
    assert_eq!(via_builder.name, via_fn.name);
}
