type SeparableBlend = fn(f64, f64) -> f64;

fn multiply(cb: f64, cs: f64) -> f64 {
    cb * cs
}

fn screen(cb: f64, cs: f64) -> f64 {
    cb + cs - cb * cs
}

pub(super) fn separable(mode: &str) -> Option<SeparableBlend> {
    match mode {
        "normal" | "pass through" => Some(|_cb, cs| cs),
        "multiply" => Some(multiply),
        "screen" => Some(screen),
        "darken" => Some(f64::min),
        "lighten" => Some(f64::max),
        "overlay" => Some(|cb, cs| hard_light(cs, cb)),
        "hard light" => Some(hard_light),
        _ => None,
    }
}

/// This compositor owns only the separable blend set above. Anything else must
/// fail closed — never silently map to normal.
pub(super) fn is_supported(mode: &str) -> bool {
    separable(mode).is_some()
}

fn hard_light(cb: f64, cs: f64) -> f64 {
    if cs <= 0.5 {
        multiply(cb, 2.0 * cs)
    } else {
        screen(cb, 2.0 * cs - 1.0)
    }
}

pub(super) fn blend_channel(mode: &str, backdrop: f64, source: f64) -> f64 {
    separable(mode)
        .map(|blend| blend(backdrop, source))
        .unwrap_or(source)
}

pub(super) fn composite_straight(
    backdrop: f64,
    source: f64,
    source_alpha: f64,
    blend: f64,
    backdrop_alpha: f64,
) -> (f64, f64) {
    let alpha_out = source_alpha + backdrop_alpha * (1.0 - source_alpha);
    if alpha_out <= 0.0 {
        return (0.0, 0.0);
    }
    let weight_source = (1.0 - backdrop_alpha) * source_alpha;
    let weight_backdrop = (1.0 - source_alpha) * backdrop_alpha;
    let weight_mix = source_alpha * backdrop_alpha;
    let color =
        (weight_source * source + weight_backdrop * backdrop + weight_mix * blend) / alpha_out;
    (color, alpha_out)
}
