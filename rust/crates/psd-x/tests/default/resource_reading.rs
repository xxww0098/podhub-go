use psdx::psd::{Layer, ReadOptions};
use psdx::reader::{ReadError, read_psd, read_psd_with_observations};

const TEMPLATE: &[u8] =
    include_bytes!("../../../../../fixtures/psd/synthetic/tiny-smart-mask-warp-groups.psd");

fn options() -> ReadOptions {
    ReadOptions {
        skip_layer_image_data: Some(true),
        skip_composite_image_data: Some(true),
        skip_thumbnail: Some(true),
        ..ReadOptions::default()
    }
}

fn resource(id: u16, data: &[u8]) -> Vec<u8> {
    let mut bytes = b"8BIM".to_vec();
    bytes.extend(id.to_be_bytes());
    bytes.extend([0, 0]); // empty, even-padded Pascal name
    bytes.extend((data.len() as u32).to_be_bytes());
    bytes.extend(data);
    if data.len() % 2 != 0 {
        bytes.push(0);
    }
    bytes
}

fn with_resources(resources: &[u8], declared_extra: u32) -> Vec<u8> {
    let color_len = u32::from_be_bytes(TEMPLATE[26..30].try_into().unwrap()) as usize;
    let start = 30 + color_len;
    let old_len = u32::from_be_bytes(TEMPLATE[start..start + 4].try_into().unwrap()) as usize;
    let mut bytes = TEMPLATE[..start].to_vec();
    bytes.extend((resources.len() as u32 + declared_extra).to_be_bytes());
    bytes.extend(resources);
    bytes.extend(&TEMPLATE[start + 4 + old_len..]);
    bytes
}

fn empty_document(resources: &[u8], declared_extra: u32, large: bool) -> Vec<u8> {
    let mut bytes = TEMPLATE[..26].to_vec();
    bytes[4..6].copy_from_slice(&(if large { 2_u16 } else { 1 }).to_be_bytes());
    bytes.extend(0_u32.to_be_bytes()); // color mode data
    bytes.extend((resources.len() as u32 + declared_extra).to_be_bytes());
    bytes.extend(resources);
    bytes.extend(vec![0; if large { 8 } else { 4 }]); // empty layer information
    bytes
}

#[test]
fn whitelist_skips_large_metadata_and_can_select_it_explicitly() {
    let xml = "x".repeat(1024 * 1024);
    let bytes = with_resources(&resource(1060, xml.as_bytes()), 0);
    let (full, full_cost) = read_psd_with_observations(&bytes, &options()).unwrap();
    assert_eq!(
        full.image_resources.unwrap().xmp_metadata.as_deref(),
        Some(xml.as_str())
    );

    let mut selected = options();
    selected.image_resources_whitelist = Some(vec![]);
    let (skipped, skipped_cost) = read_psd_with_observations(&bytes, &selected).unwrap();
    assert!(skipped.image_resources.unwrap().xmp_metadata.is_none());
    assert!(full_cost.category_high_water_bytes.metadata >= xml.len());
    assert!(skipped_cost.category_high_water_bytes.metadata < xml.len() / 4);

    selected.image_resources_whitelist = Some(vec![1060]);
    let kept = read_psd(&bytes, &selected).unwrap();
    assert_eq!(
        kept.image_resources.unwrap().xmp_metadata.as_deref(),
        Some(xml.as_str())
    );
}

#[test]
fn an_empty_whitelist_keeps_layer_links_and_channel_names() {
    let mut resources = resource(1026, &[0, 7].repeat(12));
    resources.extend(resource(1072, &[1; 12]));
    resources.extend(resource(1006, b"\x05Alpha"));
    let mut selected = options();
    selected.image_resources_whitelist = Some(vec![]);
    let psd = read_psd(&with_resources(&resources, 0), &selected).unwrap();
    assert_eq!(
        psd.image_resources.unwrap().alpha_channel_names.unwrap(),
        ["Alpha"]
    );
    fn check_links(layers: &[Layer]) {
        for layer in layers {
            assert_eq!(layer.link_group, Some(7.0));
            assert_eq!(layer.link_group_enabled, Some(true));
            if let Some(children) = &layer.children {
                check_links(children);
            }
        }
    }
    check_links(psd.children.as_ref().unwrap());
    let name: Vec<u16> = "Unicode".encode_utf16().collect();
    let mut unicode = (name.len() as u32).to_be_bytes().to_vec();
    unicode.extend(name.into_iter().flat_map(u16::to_be_bytes));
    resources.extend(resource(1045, &unicode));
    let psd = read_psd(&with_resources(&resources, 0), &selected).unwrap();
    assert_eq!(
        psd.image_resources.unwrap().alpha_channel_names.unwrap(),
        ["Unicode"]
    );
}

#[test]
fn resource_tail_padding_does_not_consume_layer_information() {
    for padding in 0..12 {
        let mut resources = resource(1060, b"kept");
        resources.extend(vec![0; padding]);
        let psd = read_psd(&with_resources(&resources, 0), &options()).unwrap();
        assert_eq!(psd.children.unwrap().len(), 2, "padding={padding}");
        assert_eq!(
            psd.image_resources.unwrap().xmp_metadata.as_deref(),
            Some("kept")
        );
    }
}

#[test]
fn an_overdeclared_resource_section_can_realign_to_layer_information() {
    let resources = resource(1060, b"kept");
    for extra in 1..4 {
        let psd = read_psd(&with_resources(&resources, extra), &options()).unwrap();
        assert_eq!(psd.children.unwrap().len(), 2);
    }
}

#[test]
fn skipped_resource_payloads_still_obey_section_boundaries() {
    for extra in [4_u32, u32::MAX - 4] {
        let mut resources = resource(1060, b"data");
        resources[8..12].copy_from_slice(&(4 + extra).to_be_bytes());
        let mut selected = options();
        selected.image_resources_whitelist = Some(vec![]);
        assert!(matches!(
            read_psd(&with_resources(&resources, 0), &selected),
            Err(ReadError::SectionExceedsFileSize)
        ));
    }
}

#[test]
fn resource_tail_alignment_handles_psd_and_psb_lengths() {
    for large in [false, true] {
        for padding in 0..12 {
            let mut resources = resource(1060, b"kept");
            resources.extend(vec![0; padding]);
            read_psd(&empty_document(&resources, 0, large), &options()).unwrap();
        }
        for extra in 1..4 {
            let resources = resource(1060, b"kept");
            read_psd(&empty_document(&resources, extra, large), &options()).unwrap();
        }
    }
}

#[test]
fn thumbnail_skip_overrides_an_explicit_whitelist_entry() {
    let bytes = empty_document(&resource(1036, &[0]), 0, false);
    let mut selected = options();
    selected.image_resources_whitelist = Some(vec![1036]);
    selected.throw_for_missing_features = Some(true);
    read_psd(&bytes, &selected).unwrap();
    selected.skip_thumbnail = Some(false);
    assert!(read_psd(&bytes, &selected).is_err());
}

#[test]
fn resource_names_keep_even_padding_and_cannot_cross_the_resource_section() {
    for name in [b"odd".as_slice(), b"even".as_slice()] {
        let original = resource(1060, b"kept");
        let mut named = original[..6].to_vec();
        named.push(name.len() as u8);
        named.extend(name);
        if (name.len() + 1) % 2 != 0 {
            named.push(0);
        }
        named.extend(&original[8..]);
        let psd = read_psd(&with_resources(&named, 0), &options()).unwrap();
        assert_eq!(
            psd.image_resources.unwrap().xmp_metadata.as_deref(),
            Some("kept")
        );
    }
    let mut malformed = resource(1060, b"kept");
    malformed[6] = 255;
    assert!(matches!(
        read_psd(&with_resources(&malformed, 0), &options()),
        Err(ReadError::SectionExceedsFileSize)
    ));
}
