use psdx::descriptor::read_os_type;
use psdx::psd::ReadOptions;
use psdx::reader::{AllocationCategory, PsdReader, ReadError, read_bytes_category};

#[test]
fn exact_live_limit_passes_and_one_over_fails_before_allocation() {
    let mut reader = PsdReader::new(&[], None, None);
    reader
        .configure_allocation_limits(10, 10)
        .expect("configure");

    let exact = reader
        .reserve_allocation(AllocationCategory::Channel, 10)
        .expect("exact limit");
    let error = reader
        .reserve_allocation(AllocationCategory::Mask, 1)
        .expect_err("one over");
    assert!(matches!(
        error,
        ReadError::ExceededMemoryLimit {
            observed: 11,
            limit: 10,
            category: AllocationCategory::Mask
        }
    ));
    drop(exact);
}

#[test]
fn released_temporary_allocations_do_not_consume_historical_budget() {
    let bytes = [0_u8; 800];
    let mut reader = PsdReader::new(&bytes, None, None);
    reader.configure_allocation_limits(8, 8).expect("configure");

    for _ in 0..100 {
        read_bytes_category(&mut reader, 8, AllocationCategory::EngineData)
            .expect("live allocation, not cumulative allocation");
    }

    let observations = reader.allocation_observations();
    assert_eq!(observations.live_bytes, 0);
    assert_eq!(observations.high_water_bytes, 8);
    assert_eq!(observations.metadata_high_water_bytes, 8);
}

#[test]
fn retained_descriptor_payload_is_charged_before_allocation() {
    let mut bytes = Vec::new();
    bytes.extend_from_slice(&4_i32.to_be_bytes());
    bytes.extend_from_slice(&[1, 2, 3, 4]);

    let mut exact = PsdReader::new(&bytes, None, None);
    exact.configure_allocation_limits(4, 4).expect("configure");
    assert!(read_os_type(&mut exact, "tdta").is_ok());
    assert_eq!(exact.allocation_observations().live_bytes, 4);

    let mut one_over = PsdReader::new(&bytes, None, None);
    one_over
        .configure_allocation_limits(3, 3)
        .expect("configure");
    assert!(matches!(
        read_os_type(&mut one_over, "tdta").unwrap_err(),
        ReadError::ExceededMemoryLimit {
            observed: 4,
            limit: 3,
            category: AllocationCategory::Descriptor
        }
    ));
}

#[test]
fn metadata_has_an_independent_aggregate_ceiling_and_categories_are_observed() {
    let mut reader = PsdReader::new(&[], None, None);
    reader
        .configure_allocation_limits(32, 4)
        .expect("configure");

    let descriptor = reader
        .reserve_allocation(AllocationCategory::Descriptor, 4)
        .expect("metadata exact");
    let error = reader
        .reserve_allocation(AllocationCategory::EngineData, 1)
        .expect_err("metadata one over");
    assert!(matches!(
        error,
        ReadError::ExceededMemoryLimit {
            observed: 5,
            limit: 4,
            category: AllocationCategory::EngineData
        }
    ));
    let observations = reader.allocation_observations();
    assert_eq!(observations.category_high_water_bytes.descriptor, 4);
    drop(descriptor);
}

#[test]
fn memory_parser_exposes_bounded_high_water_observations() {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../../fixtures/psd/synthetic/tiny-smart-mask-warp-groups.psd");
    let bytes = std::fs::read(path).expect("fixture");
    let options = ReadOptions {
        skip_layer_image_data: Some(true),
        skip_composite_image_data: Some(true),
        skip_thumbnail: Some(true),
        skip_linked_files_data: Some(true),
        throw_for_missing_features: Some(false),
        total_memory_limit: Some(512 * 1024 * 1024),
        max_metadata_bytes: Some(64 * 1024 * 1024),
        ..ReadOptions::default()
    };

    let (_, observations) = psdx::read_psd_with_observations(&bytes, &options).expect("parse");
    assert!(observations.high_water_bytes > 0);
    assert!(observations.high_water_bytes <= observations.limit_bytes);
    assert!(observations.metadata_high_water_bytes <= observations.metadata_limit_bytes);
    assert!(observations.category_high_water_bytes.metadata > 0);
}
