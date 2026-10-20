use crate::psd::BlendMode;

fn clamp(value: f32) -> f32 {
    value.clamp(0.0, 1.0)
}

fn multiply(backdrop: f32, source: f32) -> f32 {
    backdrop * source
}

fn screen(backdrop: f32, source: f32) -> f32 {
    backdrop + source - backdrop * source
}

fn hard_light(backdrop: f32, source: f32) -> f32 {
    if source <= 0.5 {
        multiply(backdrop, 2.0 * source)
    } else {
        screen(backdrop, 2.0 * source - 1.0)
    }
}

fn color_dodge(backdrop: f32, source: f32) -> f32 {
    if backdrop == 0.0 {
        0.0
    } else if source >= 1.0 {
        1.0
    } else {
        (backdrop / (1.0 - source)).min(1.0)
    }
}

fn color_burn(backdrop: f32, source: f32) -> f32 {
    if backdrop >= 1.0 {
        1.0
    } else if source == 0.0 {
        0.0
    } else {
        1.0 - ((1.0 - backdrop) / source).min(1.0)
    }
}

fn soft_light(backdrop: f32, source: f32) -> f32 {
    if source <= 0.5 {
        backdrop - (1.0 - 2.0 * source) * backdrop * (1.0 - backdrop)
    } else {
        let d = if backdrop <= 0.25 {
            ((16.0 * backdrop - 12.0) * backdrop + 4.0) * backdrop
        } else {
            backdrop.sqrt()
        };
        backdrop + (2.0 * source - 1.0) * (d - backdrop)
    }
}

fn lum(color: [f32; 3]) -> f32 {
    0.3 * color[0] + 0.59 * color[1] + 0.11 * color[2]
}

fn sat(color: [f32; 3]) -> f32 {
    color[0].max(color[1]).max(color[2]) - color[0].min(color[1]).min(color[2])
}

fn clip_color(mut color: [f32; 3]) -> [f32; 3] {
    let l = lum(color);
    let n = color[0].min(color[1]).min(color[2]);
    let x = color[0].max(color[1]).max(color[2]);
    if n < 0.0 {
        for channel in &mut color {
            *channel = l + (*channel - l) * l / (l - n);
        }
    }
    if x > 1.0 {
        for channel in &mut color {
            *channel = l + (*channel - l) * (1.0 - l) / (x - l);
        }
    }
    color
}

fn set_lum(mut color: [f32; 3], target: f32) -> [f32; 3] {
    let delta = target - lum(color);
    for channel in &mut color {
        *channel += delta;
    }
    clip_color(color)
}

fn set_sat(color: [f32; 3], target: f32) -> [f32; 3] {
    let mut values = [(color[0], 0usize), (color[1], 1usize), (color[2], 2usize)];
    values.sort_by(|left, right| left.0.total_cmp(&right.0));
    let [(min, min_i), (mid, mid_i), (max, max_i)] = values;
    let mut out = [0.0; 3];
    if max > min {
        out[mid_i] = (mid - min) * target / (max - min);
        out[max_i] = target;
    }
    out[min_i] = 0.0;
    out
}

pub(crate) fn supported(mode: BlendMode) -> bool {
    // Dissolve is rendered as Normal without dither — not a supported mode.
    !matches!(
        mode,
        BlendMode::Dissolve | BlendMode::LinearHeight | BlendMode::Height | BlendMode::Subtraction
    )
}

pub(crate) fn apply(mode: BlendMode, backdrop: [f32; 3], source: [f32; 3]) -> [f32; 3] {
    use BlendMode::*;
    match mode {
        Hue => set_lum(set_sat(source, sat(backdrop)), lum(backdrop)),
        Saturation => set_lum(set_sat(backdrop, sat(source)), lum(backdrop)),
        Color => set_lum(source, lum(backdrop)),
        Luminosity => set_lum(backdrop, lum(source)),
        DarkerColor => {
            if lum(source) < lum(backdrop) {
                source
            } else {
                backdrop
            }
        }
        LighterColor => {
            if lum(source) > lum(backdrop) {
                source
            } else {
                backdrop
            }
        }
        // Match the mode once, then apply the same formula to each channel.
        // The previous per-channel closure rematched `mode` three times per pixel.
        Normal | Dissolve | PassThrough => source,
        Darken => [
            backdrop[0].min(source[0]),
            backdrop[1].min(source[1]),
            backdrop[2].min(source[2]),
        ],
        Multiply => [
            multiply(backdrop[0], source[0]),
            multiply(backdrop[1], source[1]),
            multiply(backdrop[2], source[2]),
        ],
        ColorBurn => [
            color_burn(backdrop[0], source[0]),
            color_burn(backdrop[1], source[1]),
            color_burn(backdrop[2], source[2]),
        ],
        LinearBurn => [
            clamp(backdrop[0] + source[0] - 1.0),
            clamp(backdrop[1] + source[1] - 1.0),
            clamp(backdrop[2] + source[2] - 1.0),
        ],
        Lighten => [
            backdrop[0].max(source[0]),
            backdrop[1].max(source[1]),
            backdrop[2].max(source[2]),
        ],
        Screen => [
            screen(backdrop[0], source[0]),
            screen(backdrop[1], source[1]),
            screen(backdrop[2], source[2]),
        ],
        ColorDodge => [
            color_dodge(backdrop[0], source[0]),
            color_dodge(backdrop[1], source[1]),
            color_dodge(backdrop[2], source[2]),
        ],
        LinearDodge => [
            clamp(backdrop[0] + source[0]),
            clamp(backdrop[1] + source[1]),
            clamp(backdrop[2] + source[2]),
        ],
        Overlay => [
            hard_light(source[0], backdrop[0]),
            hard_light(source[1], backdrop[1]),
            hard_light(source[2], backdrop[2]),
        ],
        SoftLight => [
            soft_light(backdrop[0], source[0]),
            soft_light(backdrop[1], source[1]),
            soft_light(backdrop[2], source[2]),
        ],
        HardLight => [
            hard_light(backdrop[0], source[0]),
            hard_light(backdrop[1], source[1]),
            hard_light(backdrop[2], source[2]),
        ],
        VividLight => [
            vivid_light(backdrop[0], source[0]),
            vivid_light(backdrop[1], source[1]),
            vivid_light(backdrop[2], source[2]),
        ],
        LinearLight => [
            clamp(backdrop[0] + 2.0 * source[0] - 1.0),
            clamp(backdrop[1] + 2.0 * source[1] - 1.0),
            clamp(backdrop[2] + 2.0 * source[2] - 1.0),
        ],
        PinLight => [
            pin_light(backdrop[0], source[0]),
            pin_light(backdrop[1], source[1]),
            pin_light(backdrop[2], source[2]),
        ],
        HardMix => [
            hard_mix(backdrop[0], source[0]),
            hard_mix(backdrop[1], source[1]),
            hard_mix(backdrop[2], source[2]),
        ],
        Difference => [
            (backdrop[0] - source[0]).abs(),
            (backdrop[1] - source[1]).abs(),
            (backdrop[2] - source[2]).abs(),
        ],
        Exclusion => [
            exclusion(backdrop[0], source[0]),
            exclusion(backdrop[1], source[1]),
            exclusion(backdrop[2], source[2]),
        ],
        Subtract => [
            clamp(backdrop[0] - source[0]),
            clamp(backdrop[1] - source[1]),
            clamp(backdrop[2] - source[2]),
        ],
        Divide => [
            divide(backdrop[0], source[0]),
            divide(backdrop[1], source[1]),
            divide(backdrop[2], source[2]),
        ],
        _ => source,
    }
}

fn vivid_light(backdrop: f32, source: f32) -> f32 {
    if source <= 0.5 {
        color_burn(backdrop, 2.0 * source)
    } else {
        color_dodge(backdrop, 2.0 * source - 1.0)
    }
}

fn pin_light(backdrop: f32, source: f32) -> f32 {
    if source <= 0.5 {
        backdrop.min(2.0 * source)
    } else {
        backdrop.max(2.0 * source - 1.0)
    }
}

fn hard_mix(backdrop: f32, source: f32) -> f32 {
    if backdrop + source >= 1.0 { 1.0 } else { 0.0 }
}

fn exclusion(backdrop: f32, source: f32) -> f32 {
    backdrop + source - 2.0 * backdrop * source
}

fn divide(backdrop: f32, source: f32) -> f32 {
    if source == 0.0 {
        1.0
    } else {
        (backdrop / source).min(1.0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::psd::BlendMode;

    const EPS: f32 = 1e-5;

    fn assert_rgb(actual: [f32; 3], expected: [f32; 3]) {
        for (a, e) in actual.iter().zip(expected.iter()) {
            assert!(
                (a - e).abs() < EPS,
                "channel mismatch: got {actual:?}, expected {expected:?}"
            );
        }
    }

    /// Data-driven check of every blend-mode formula against representative
    /// backdrop / source values (PDF-style separable + non-separable modes).
    #[test]
    fn every_blend_mode_formula_matches_reference_table() {
        let backdrop = [0.25, 0.50, 0.75];
        let source = [0.80, 0.40, 0.10];
        let cases: &[(BlendMode, [f32; 3])] = &[
            (BlendMode::PassThrough, [0.8, 0.4, 0.1]),
            (BlendMode::Normal, [0.8, 0.4, 0.1]),
            (BlendMode::Dissolve, [0.8, 0.4, 0.1]),
            (BlendMode::Darken, [0.25, 0.4, 0.1]),
            (BlendMode::Multiply, [0.2, 0.2, 0.075]),
            (BlendMode::ColorBurn, [0.0625, 0.0, 0.0]),
            (BlendMode::LinearBurn, [0.05, 0.0, 0.0]),
            (BlendMode::Lighten, [0.8, 0.5, 0.75]),
            (BlendMode::Screen, [0.85, 0.7, 0.775]),
            (BlendMode::ColorDodge, [1.0, 0.833_333_3, 0.833_333_3]),
            (BlendMode::LinearDodge, [1.0, 0.9, 0.85]),
            (BlendMode::Overlay, [0.4, 0.4, 0.55]),
            (BlendMode::SoftLight, [0.4, 0.45, 0.6]),
            (BlendMode::HardLight, [0.7, 0.4, 0.15]),
            (BlendMode::VividLight, [0.625, 0.375, 0.0]),
            (BlendMode::LinearLight, [0.85, 0.3, 0.0]),
            (BlendMode::PinLight, [0.6, 0.5, 0.2]),
            (BlendMode::HardMix, [1.0, 0.0, 0.0]),
            (BlendMode::Difference, [0.55, 0.1, 0.65]),
            (BlendMode::Exclusion, [0.65, 0.5, 0.7]),
            (BlendMode::Subtract, [0.0, 0.1, 0.65]),
            (BlendMode::Divide, [0.3125, 1.0, 1.0]),
            // Non-separable / luminance picks
            (BlendMode::Hue, [0.676_071_4, 0.390_357_14, 0.176_071_42]),
            (BlendMode::Saturation, [0.169, 0.519, 0.869]),
            (BlendMode::Color, [0.7655, 0.3655, 0.0655]),
            (BlendMode::Luminosity, [0.2845, 0.5345, 0.7845]),
            (BlendMode::DarkerColor, backdrop), // lum(source) > lum(backdrop)
            (BlendMode::LighterColor, source),
            // Unsupported ABR-only modes fall through to source
            (BlendMode::LinearHeight, source),
            (BlendMode::Height, source),
            (BlendMode::Subtraction, source),
        ];
        for &(mode, expected) in cases {
            assert_rgb(apply(mode, backdrop, source), expected);
        }
    }

    #[test]
    fn luminosity_saturation_and_clip_color_helpers() {
        let color = [0.25, 0.50, 0.75];
        assert!((lum(color) - 0.4525).abs() < EPS);
        assert!((sat(color) - 0.5).abs() < EPS);

        // Below-zero and above-one channels both take the PDF clip path.
        assert_rgb(
            clip_color([-0.2, 0.5, 1.2]),
            [0.088_115_25, 0.432_417_4, 0.776_719_6],
        );

        // set_lum redistributes then clips into gamut.
        assert_rgb(
            set_lum([1.0, 0.0, 0.0], 0.5),
            [1.0, 0.285_714_3, 0.285_714_3],
        );

        // set_sat preserves channel order; min pinned at 0, max at target.
        assert_rgb(set_sat([0.2, 0.5, 0.9], 0.4), [0.0, 0.171_428_57, 0.4]);
        assert_rgb(set_sat([0.4, 0.4, 0.4], 0.8), [0.0, 0.0, 0.0]); // max == min
    }

    #[test]
    fn soft_light_covers_both_piecewise_branches() {
        // source <= 0.5 → first branch (no `d`).
        assert!((soft_light(0.2, 0.4) - 0.168).abs() < EPS);
        // Boundary source == 0.5 stays on the first branch.
        assert!((soft_light(0.25, 0.5) - 0.25).abs() < EPS);

        // source > 0.5, backdrop <= 0.25 → polynomial `d`.
        assert!((soft_light(0.2, 0.6) - 0.2496).abs() < EPS);
        assert!((soft_light(0.25, 0.6) - 0.3).abs() < EPS);

        // source > 0.5, backdrop > 0.25 → sqrt `d`.
        assert!((soft_light(0.5, 0.6) - 0.541_421_36).abs() < EPS);
    }
}
