use psdx::psd::{Layer, ReadOptions, WriteOptions};
use render::{ParsedTemplate, ProductResourcePolicy, RenderIntent, render_product};

const TEMPLATE: &[u8] =
    include_bytes!("../../../../fixtures/psd/synthetic/tiny-smart-mask-warp-groups.psd");
const DESIGN: &[u8] =
    include_bytes!("../../../../fixtures/psd/synthetic/replacement-transparent-edges.png");

fn set_density(
    layers: &mut [Layer],
    density: Option<f64>,
    disabled: bool,
    all_parameters: bool,
) -> usize {
    let mut count = 0;
    for layer in layers {
        if let Some(mask) = &mut layer.additional_info.mask {
            mask.user_mask_density = density;
            mask.disabled = Some(disabled);
            if all_parameters {
                mask.user_mask_feather = Some(0.0);
                mask.vector_mask_density = Some(1.0);
                mask.vector_mask_feather = Some(0.0);
            }
            count += 1;
        }
        if let Some(children) = &mut layer.children {
            count += set_density(children, density, disabled, all_parameters);
        }
    }
    count
}

fn template(density: Option<f64>, disabled: bool, all_parameters: bool) -> Vec<u8> {
    let mut psd = psdx::read_psd(
        TEMPLATE,
        &ReadOptions {
            use_image_data: Some(true),
            skip_composite_image_data: Some(true),
            skip_thumbnail: Some(true),
            ..ReadOptions::default()
        },
    )
    .unwrap();
    assert_eq!(
        set_density(
            psd.children.as_mut().unwrap(),
            density,
            disabled,
            all_parameters
        ),
        2
    );
    psdx::write_psd(&psd, &WriteOptions::default()).unwrap()
}

fn hashes(bytes: &[u8]) -> Vec<String> {
    let policy = ProductResourcePolicy::default();
    let parsed = ParsedTemplate::parse(bytes, &policy).unwrap();
    render_product(
        &parsed,
        DESIGN,
        "density.png",
        &RenderIntent::default(),
        &policy,
    )
    .unwrap()
    .slices
    .into_iter()
    .map(|slice| slice.content_hash)
    .collect()
}

#[test]
fn zero_density_matches_a_disabled_mask_and_full_density_keeps_current_pixels() {
    for all_parameters in [false, true] {
        let full = hashes(&template(Some(1.0), false, all_parameters));
        assert_eq!(full, hashes(TEMPLATE));
        assert_eq!(full, hashes(&template(None, false, all_parameters)));
        let unmasked = hashes(&template(None, true, all_parameters));
        let zero = hashes(&template(Some(0.0), false, all_parameters));
        assert_eq!(zero, unmasked);
        assert_ne!(zero, full);
        let partial = hashes(&template(Some(128.0 / 255.0), false, all_parameters));
        assert_ne!(partial, full);
        assert_ne!(partial, zero);
    }
}
