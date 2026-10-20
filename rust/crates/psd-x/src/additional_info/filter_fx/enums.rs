//! Enum encode/decode bridges for smart-filter descriptors.

use crate::descriptor_enums;
use crate::helpers::EnumCodec;
use crate::psd::*;

fn codec_name(codec: &EnumCodec, val: &str, default: &str) -> String {
    codec.decode(val).unwrap_or_else(|_| default.to_string())
}

pub(super) fn bln_m_decode(val: &str) -> BlendMode {
    BlendMode::from_json_str(&codec_name(&descriptor_enums::bln_m(), val, "normal"))
        .unwrap_or(BlendMode::Normal)
}
pub(super) fn bln_m_encode(val: BlendMode) -> String {
    descriptor_enums::bln_m()
        .encode(Some(val.as_json_str()))
        .unwrap_or_else(|_| "BlnM.Nrml".into())
}

pub(super) fn blr_m_decode(val: &str) -> RadialBlurMethod {
    match codec_name(&descriptor_enums::blr_m(), val, "spin").as_str() {
        "zoom" => RadialBlurMethod::Zoom,
        _ => RadialBlurMethod::Spin,
    }
}
pub(super) fn blr_m_encode(v: RadialBlurMethod) -> String {
    let n = match v {
        RadialBlurMethod::Zoom => "zoom",
        RadialBlurMethod::Spin => "spin",
    };
    descriptor_enums::blr_m().encode(Some(n)).unwrap()
}

pub(super) fn blr_q_decode(val: &str) -> RadialBlurQuality {
    match codec_name(&descriptor_enums::blr_q(), val, "good").as_str() {
        "draft" => RadialBlurQuality::Draft,
        "best" => RadialBlurQuality::Best,
        _ => RadialBlurQuality::Good,
    }
}
pub(super) fn blr_q_encode(v: RadialBlurQuality) -> String {
    let n = match v {
        RadialBlurQuality::Draft => "draft",
        RadialBlurQuality::Best => "best",
        RadialBlurQuality::Good => "good",
    };
    descriptor_enums::blr_q().encode(Some(n)).unwrap()
}

pub(super) fn sm_bq_decode(val: &str) -> LowMediumHigh {
    match codec_name(&descriptor_enums::sm_bq(), val, "medium").as_str() {
        "low" => LowMediumHigh::Low,
        "high" => LowMediumHigh::High,
        _ => LowMediumHigh::Medium,
    }
}
pub(super) fn sm_bq_encode(v: LowMediumHigh) -> String {
    let n = match v {
        LowMediumHigh::Low => "low",
        LowMediumHigh::High => "high",
        LowMediumHigh::Medium => "medium",
    };
    descriptor_enums::sm_bq().encode(Some(n)).unwrap()
}

pub(super) fn sm_bm_decode(val: &str) -> SmartBlurMode {
    match codec_name(&descriptor_enums::sm_bm(), val, "normal").as_str() {
        "edge only" => SmartBlurMode::EdgeOnly,
        "overlay edge" => SmartBlurMode::OverlayEdge,
        _ => SmartBlurMode::Normal,
    }
}
pub(super) fn sm_bm_encode(v: SmartBlurMode) -> String {
    let n = match v {
        SmartBlurMode::EdgeOnly => "edge only",
        SmartBlurMode::OverlayEdge => "overlay edge",
        SmartBlurMode::Normal => "normal",
    };
    descriptor_enums::sm_bm().encode(Some(n)).unwrap()
}

pub(super) fn dsp_m_decode(val: &str) -> DisplacementMap {
    match codec_name(&descriptor_enums::dsp_m(), val, "stretch to fit").as_str() {
        "tile" => DisplacementMap::Tile,
        _ => DisplacementMap::StretchToFit,
    }
}
pub(super) fn dsp_m_encode(v: DisplacementMap) -> String {
    let n = match v {
        DisplacementMap::Tile => "tile",
        DisplacementMap::StretchToFit => "stretch to fit",
    };
    descriptor_enums::dsp_m().encode(Some(n)).unwrap()
}

pub(super) fn und_a_decode(val: &str) -> WrapOrRepeat {
    match codec_name(&descriptor_enums::und_a(), val, "repeat edge pixels").as_str() {
        "wrap around" => WrapOrRepeat::WrapAround,
        _ => WrapOrRepeat::RepeatEdgePixels,
    }
}
pub(super) fn und_a_encode(v: WrapOrRepeat) -> String {
    let n = match v {
        WrapOrRepeat::WrapAround => "wrap around",
        WrapOrRepeat::RepeatEdgePixels => "repeat edge pixels",
    };
    descriptor_enums::und_a().encode(Some(n)).unwrap()
}

pub(super) fn cnvr_decode(val: &str) -> PolarConversion {
    match codec_name(&descriptor_enums::cnvr(), val, "rectangular to polar").as_str() {
        "polar to rectangular" => PolarConversion::PolarToRectangular,
        _ => PolarConversion::RectangularToPolar,
    }
}
pub(super) fn cnvr_encode(v: PolarConversion) -> String {
    let n = match v {
        PolarConversion::PolarToRectangular => "polar to rectangular",
        PolarConversion::RectangularToPolar => "rectangular to polar",
    };
    descriptor_enums::cnvr().encode(Some(n)).unwrap()
}

pub(super) fn rpl_s_decode(val: &str) -> SmallMediumLarge {
    match codec_name(&descriptor_enums::rpl_s(), val, "medium").as_str() {
        "small" => SmallMediumLarge::Small,
        "large" => SmallMediumLarge::Large,
        _ => SmallMediumLarge::Medium,
    }
}
pub(super) fn rpl_s_encode(v: SmallMediumLarge) -> String {
    let n = match v {
        SmallMediumLarge::Small => "small",
        SmallMediumLarge::Large => "large",
        SmallMediumLarge::Medium => "medium",
    };
    descriptor_enums::rpl_s().encode(Some(n)).unwrap()
}

pub(super) fn sph_m_decode(val: &str) -> SpherizeMode {
    match codec_name(&descriptor_enums::sph_m(), val, "normal").as_str() {
        "horizontal only" => SpherizeMode::HorizontalOnly,
        "vertical only" => SpherizeMode::VerticalOnly,
        _ => SpherizeMode::Normal,
    }
}
pub(super) fn sph_m_encode(v: SpherizeMode) -> String {
    let n = match v {
        SpherizeMode::HorizontalOnly => "horizontal only",
        SpherizeMode::VerticalOnly => "vertical only",
        SpherizeMode::Normal => "normal",
    };
    descriptor_enums::sph_m().encode(Some(n)).unwrap()
}

pub(super) fn wvtp_decode(val: &str) -> WaveType {
    match codec_name(&descriptor_enums::wvtp(), val, "sine").as_str() {
        "triangle" => WaveType::Triangle,
        "square" => WaveType::Square,
        _ => WaveType::Sine,
    }
}
pub(super) fn wvtp_encode(v: WaveType) -> String {
    let n = match v {
        WaveType::Triangle => "triangle",
        WaveType::Square => "square",
        WaveType::Sine => "sine",
    };
    descriptor_enums::wvtp().encode(Some(n)).unwrap()
}

pub(super) fn zz_ty_decode(val: &str) -> ZigZagStyle {
    match codec_name(&descriptor_enums::zz_ty(), val, "pond ripples").as_str() {
        "around center" => ZigZagStyle::AroundCenter,
        "out from center" => ZigZagStyle::OutFromCenter,
        _ => ZigZagStyle::PondRipples,
    }
}
pub(super) fn zz_ty_encode(v: ZigZagStyle) -> String {
    let n = match v {
        ZigZagStyle::AroundCenter => "around center",
        ZigZagStyle::OutFromCenter => "out from center",
        ZigZagStyle::PondRipples => "pond ripples",
    };
    descriptor_enums::zz_ty().encode(Some(n)).unwrap()
}

pub(super) fn dstr_decode(val: &str) -> NoiseDistribution {
    match codec_name(&descriptor_enums::dstr(), val, "uniform").as_str() {
        "gaussian" => NoiseDistribution::Gaussian,
        _ => NoiseDistribution::Uniform,
    }
}
pub(super) fn dstr_encode(v: NoiseDistribution) -> String {
    let n = match v {
        NoiseDistribution::Gaussian => "gaussian",
        NoiseDistribution::Uniform => "uniform",
    };
    descriptor_enums::dstr().encode(Some(n)).unwrap()
}

pub(super) fn chnl_encode(v: DenoiseChannel) -> String {
    let n = match v {
        DenoiseChannel::Red => "red",
        DenoiseChannel::Green => "green",
        DenoiseChannel::Blue => "blue",
        DenoiseChannel::Composite => "composite",
    };
    descriptor_enums::chnl().encode(Some(n)).unwrap()
}

pub(super) fn curves_chnl_decode(val: &str) -> CurvesFilterChannel {
    match codec_name(&descriptor_enums::chnl(), val, "composite").as_str() {
        "red" => CurvesFilterChannel::Red,
        "green" => CurvesFilterChannel::Green,
        "blue" => CurvesFilterChannel::Blue,
        _ => CurvesFilterChannel::Composite,
    }
}
pub(super) fn curves_chnl_encode(v: CurvesFilterChannel) -> String {
    let n = match v {
        CurvesFilterChannel::Red => "red",
        CurvesFilterChannel::Green => "green",
        CurvesFilterChannel::Blue => "blue",
        CurvesFilterChannel::Composite => "composite",
    };
    descriptor_enums::chnl().encode(Some(n)).unwrap()
}

pub(super) fn mzt_t_decode(val: &str) -> MezzotintType {
    match codec_name(&descriptor_enums::mzt_t(), val, "fine dots").as_str() {
        "medium dots" => MezzotintType::MediumDots,
        "grainy dots" => MezzotintType::GrainyDots,
        "coarse dots" => MezzotintType::CoarseDots,
        "short lines" => MezzotintType::ShortLines,
        "medium lines" => MezzotintType::MediumLines,
        "long lines" => MezzotintType::LongLines,
        "short strokes" => MezzotintType::ShortStrokes,
        "medium strokes" => MezzotintType::MediumStrokes,
        "long strokes" => MezzotintType::LongStrokes,
        _ => MezzotintType::FineDots,
    }
}
pub(super) fn mzt_t_encode(v: MezzotintType) -> String {
    let n = match v {
        MezzotintType::MediumDots => "medium dots",
        MezzotintType::GrainyDots => "grainy dots",
        MezzotintType::CoarseDots => "coarse dots",
        MezzotintType::ShortLines => "short lines",
        MezzotintType::MediumLines => "medium lines",
        MezzotintType::LongLines => "long lines",
        MezzotintType::ShortStrokes => "short strokes",
        MezzotintType::MediumStrokes => "medium strokes",
        MezzotintType::LongStrokes => "long strokes",
        MezzotintType::FineDots => "fine dots",
    };
    descriptor_enums::mzt_t().encode(Some(n)).unwrap()
}

pub(super) fn lns_decode(val: &str) -> LensType {
    match codec_name(&descriptor_enums::lns(), val, "50-300mm zoom").as_str() {
        "32mm prime" => LensType::Prime32,
        "105mm prime" => LensType::Prime105,
        "movie prime" => LensType::MoviePrime,
        _ => LensType::Zoom50To300,
    }
}
pub(super) fn lns_encode(v: LensType) -> String {
    let n = match v {
        LensType::Prime32 => "32mm prime",
        LensType::Prime105 => "105mm prime",
        LensType::MoviePrime => "movie prime",
        LensType::Zoom50To300 => "50-300mm zoom",
    };
    descriptor_enums::lns().encode(Some(n)).unwrap()
}

pub(super) fn blur_type_decode(val: &str) -> SmartSharpenBlur {
    match codec_name(&descriptor_enums::blur_type(), val, "gaussian blur").as_str() {
        "lens blur" => SmartSharpenBlur::LensBlur,
        "motion blur" => SmartSharpenBlur::MotionBlur,
        _ => SmartSharpenBlur::GaussianBlur,
    }
}
pub(super) fn blur_type_encode(v: SmartSharpenBlur) -> String {
    let n = match v {
        SmartSharpenBlur::LensBlur => "lens blur",
        SmartSharpenBlur::MotionBlur => "motion blur",
        SmartSharpenBlur::GaussianBlur => "gaussian blur",
    };
    descriptor_enums::blur_type().encode(Some(n)).unwrap()
}

pub(super) fn dfs_m_decode(val: &str) -> DiffuseMode {
    match codec_name(&descriptor_enums::dfs_m(), val, "normal").as_str() {
        "darken only" => DiffuseMode::DarkenOnly,
        "lighten only" => DiffuseMode::LightenOnly,
        "anisotropic" => DiffuseMode::Anisotropic,
        _ => DiffuseMode::Normal,
    }
}
pub(super) fn dfs_m_encode(v: DiffuseMode) -> String {
    let n = match v {
        DiffuseMode::DarkenOnly => "darken only",
        DiffuseMode::LightenOnly => "lighten only",
        DiffuseMode::Anisotropic => "anisotropic",
        DiffuseMode::Normal => "normal",
    };
    descriptor_enums::dfs_m().encode(Some(n)).unwrap()
}

pub(super) fn ext_t_decode(val: &str) -> ExtrudeType {
    match codec_name(&descriptor_enums::ext_t(), val, "blocks").as_str() {
        "pyramids" => ExtrudeType::Pyramids,
        _ => ExtrudeType::Blocks,
    }
}
pub(super) fn ext_t_encode(v: ExtrudeType) -> String {
    let n = match v {
        ExtrudeType::Pyramids => "pyramids",
        ExtrudeType::Blocks => "blocks",
    };
    descriptor_enums::ext_t().encode(Some(n)).unwrap()
}

pub(super) fn ext_r_decode(val: &str) -> ExtrudeDepthMode {
    match codec_name(&descriptor_enums::ext_r(), val, "random").as_str() {
        "level-based" => ExtrudeDepthMode::LevelBased,
        _ => ExtrudeDepthMode::Random,
    }
}
pub(super) fn ext_r_encode(v: ExtrudeDepthMode) -> String {
    let n = match v {
        ExtrudeDepthMode::LevelBased => "level-based",
        ExtrudeDepthMode::Random => "random",
    };
    descriptor_enums::ext_r().encode(Some(n)).unwrap()
}

pub(super) fn fl_cl_decode(val: &str) -> TilesFill {
    match codec_name(&descriptor_enums::fl_cl(), val, "background color").as_str() {
        "foreground color" => TilesFill::ForegroundColor,
        "inverse image" => TilesFill::InverseImage,
        "unaltered image" => TilesFill::UnalteredImage,
        _ => TilesFill::BackgroundColor,
    }
}
pub(super) fn fl_cl_encode(v: TilesFill) -> String {
    let n = match v {
        TilesFill::ForegroundColor => "foreground color",
        TilesFill::InverseImage => "inverse image",
        TilesFill::UnalteredImage => "unaltered image",
        TilesFill::BackgroundColor => "background color",
    };
    descriptor_enums::fl_cl().encode(Some(n)).unwrap()
}

pub(super) fn cnt_e_decode(val: &str) -> LowerUpper {
    match codec_name(&descriptor_enums::cnt_e(), val, "upper").as_str() {
        "lower" => LowerUpper::Lower,
        _ => LowerUpper::Upper,
    }
}
pub(super) fn cnt_e_encode(v: LowerUpper) -> String {
    let n = match v {
        LowerUpper::Lower => "lower",
        LowerUpper::Upper => "upper",
    };
    descriptor_enums::cnt_e().encode(Some(n)).unwrap()
}

pub(super) fn wnd_m_decode(val: &str) -> WindMethod {
    match codec_name(&descriptor_enums::wnd_m(), val, "wind").as_str() {
        "blast" => WindMethod::Blast,
        "stagger" => WindMethod::Stagger,
        _ => WindMethod::Wind,
    }
}
pub(super) fn wnd_m_encode(v: WindMethod) -> String {
    let n = match v {
        WindMethod::Blast => "blast",
        WindMethod::Stagger => "stagger",
        WindMethod::Wind => "wind",
    };
    descriptor_enums::wnd_m().encode(Some(n)).unwrap()
}

pub(super) fn drct_decode(val: &str) -> LeftRight {
    match codec_name(&descriptor_enums::drct(), val, "right").as_str() {
        "left" => LeftRight::Left,
        _ => LeftRight::Right,
    }
}
pub(super) fn drct_encode(v: LeftRight) -> String {
    let n = match v {
        LeftRight::Left => "left",
        LeftRight::Right => "right",
    };
    descriptor_enums::drct().encode(Some(n)).unwrap()
}

pub(super) fn int_e_decode(val: &str) -> DeInterlaceEliminate {
    match codec_name(&descriptor_enums::int_e(), val, "odd lines").as_str() {
        "even lines" => DeInterlaceEliminate::EvenLines,
        _ => DeInterlaceEliminate::OddLines,
    }
}
pub(super) fn int_e_encode(v: DeInterlaceEliminate) -> String {
    let n = match v {
        DeInterlaceEliminate::EvenLines => "even lines",
        DeInterlaceEliminate::OddLines => "odd lines",
    };
    descriptor_enums::int_e().encode(Some(n)).unwrap()
}

pub(super) fn int_c_decode(val: &str) -> DeInterlaceNewFields {
    match codec_name(&descriptor_enums::int_c(), val, "interpolation").as_str() {
        "duplication" => DeInterlaceNewFields::Duplication,
        _ => DeInterlaceNewFields::Interpolation,
    }
}
pub(super) fn int_c_encode(v: DeInterlaceNewFields) -> String {
    let n = match v {
        DeInterlaceNewFields::Duplication => "duplication",
        DeInterlaceNewFields::Interpolation => "interpolation",
    };
    descriptor_enums::int_c().encode(Some(n)).unwrap()
}

pub(super) fn fl_md_decode(val: &str) -> OffsetUndefinedAreas {
    match codec_name(&descriptor_enums::fl_md(), val, "wrap around").as_str() {
        "set to transparent" => OffsetUndefinedAreas::SetToTransparent,
        "repeat edge pixels" => OffsetUndefinedAreas::RepeatEdgePixels,
        _ => OffsetUndefinedAreas::WrapAround,
    }
}
pub(super) fn fl_md_encode(v: OffsetUndefinedAreas) -> String {
    let n = match v {
        OffsetUndefinedAreas::SetToTransparent => "set to transparent",
        OffsetUndefinedAreas::RepeatEdgePixels => "repeat edge pixels",
        OffsetUndefinedAreas::WrapAround => "wrap around",
    };
    descriptor_enums::fl_md().encode(Some(n)).unwrap()
}

pub(super) fn clr_s_decode(val: &str) -> RgbHsbHsl {
    match codec_name(&descriptor_enums::clr_s(), val, "rgb").as_str() {
        "hsb" => RgbHsbHsl::Hsb,
        "hsl" => RgbHsbHsl::Hsl,
        _ => RgbHsbHsl::Rgb,
    }
}
pub(super) fn clr_s_encode(v: RgbHsbHsl) -> String {
    let n = match v {
        RgbHsbHsl::Hsb => "hsb",
        RgbHsbHsl::Hsl => "hsl",
        RgbHsbHsl::Rgb => "rgb",
    };
    descriptor_enums::clr_s().encode(Some(n)).unwrap()
}

pub(super) fn preset_kind_decode(val: &str) -> CurvesPresetKind {
    match codec_name(&descriptor_enums::preset_kind_type(), val, "custom").as_str() {
        "default" => CurvesPresetKind::Default,
        _ => CurvesPresetKind::Custom,
    }
}
pub(super) fn preset_kind_encode(v: CurvesPresetKind) -> String {
    let n = match v {
        CurvesPresetKind::Default => "default",
        CurvesPresetKind::Custom => "custom",
    };
    descriptor_enums::preset_kind_type()
        .encode(Some(n))
        .unwrap()
}
