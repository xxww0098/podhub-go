#[test]
fn parser_large_buffers_flow_through_the_allocation_ledger() {
    let reader = include_str!("../../src/reader.rs");
    let production = reader
        .split("#[cfg(test)]")
        .next()
        .expect("production reader source");

    for forbidden in [
        "let mut data = vec![0u8; width * height * 4]",
        "data: vec![0u8; width * height]",
        "Vec::with_capacity(layer_count)",
        "Vec::with_capacity(offsets.len() * height)",
    ] {
        assert!(
            !production.contains(forbidden),
            "unaccounted parser allocation reintroduced: {forbidden}"
        );
    }

    for required in [
        "AllocationCategory::Raster",
        "AllocationCategory::Channel",
        "AllocationCategory::Mask",
        "try_reserve_exact",
    ] {
        assert!(
            production.contains(required),
            "allocation ledger path disappeared: {required}"
        );
    }

    let linked_files = include_str!("../../src/additional_info/linked_files.rs");
    assert!(linked_files.contains("AllocationCategory::LinkedPayload"));
    assert!(!linked_files.contains("read_bytes(reader, data_size)?.to_vec()"));

    let descriptors = include_str!("../../src/descriptor.rs");
    assert!(descriptors.contains("AllocationCategory::Descriptor"));
    let text = include_str!("../../src/additional_info/text_keys.rs");
    assert!(text.contains("AllocationCategory::EngineData"));
}
