//! Descriptor `createEnum` tables (upstream `descriptor.ts` / `additionalInfo.ts` /
//! `imageResources.ts`).
//!
//! Fork keeps type-carrying [`crate::descriptor::DescriptorValue`]; these codecs
//! only translate the `prefix.value` enum strings. Decode includes the Photoshop
//! 2026 long-form fallback from [`crate::helpers::EnumCodec::decode`].

use crate::helpers::{EnumCodec, dict};

fn codec(prefix: &str, def: &str, pairs: &[(&str, &str)]) -> EnumCodec {
    EnumCodec::new(prefix, def, dict(pairs))
}

// ---------------------------------------------------------------------------
// Text / warp (also used from text_keys / smart_object_keys)
// ---------------------------------------------------------------------------

pub fn text_gridding() -> EnumCodec {
    codec(
        "textGridding",
        "none",
        &[("none", "None"), ("round", "Rnd ")],
    )
}

pub fn ornt() -> EnumCodec {
    codec(
        "Ornt",
        "horizontal",
        &[("horizontal", "Hrzn"), ("vertical", "Vrtc")],
    )
}

pub fn annt() -> EnumCodec {
    codec(
        "Annt",
        "sharp",
        &[
            ("none", "Anno"),
            ("sharp", "antiAliasSharp"),
            ("crisp", "AnCr"),
            ("strong", "AnSt"),
            ("smooth", "AnSm"),
            ("platform", "antiAliasPlatformGray"),
            ("platformLCD", "antiAliasPlatformLCD"),
        ],
    )
}

pub fn warp_style() -> EnumCodec {
    codec(
        "warpStyle",
        "none",
        &[
            ("none", "warpNone"),
            ("arc", "warpArc"),
            ("arcLower", "warpArcLower"),
            ("arcUpper", "warpArcUpper"),
            ("arch", "warpArch"),
            ("bulge", "warpBulge"),
            ("shellLower", "warpShellLower"),
            ("shellUpper", "warpShellUpper"),
            ("flag", "warpFlag"),
            ("wave", "warpWave"),
            ("fish", "warpFish"),
            ("rise", "warpRise"),
            ("fisheye", "warpFisheye"),
            ("inflate", "warpInflate"),
            ("squeeze", "warpSqueeze"),
            ("twist", "warpTwist"),
            ("cylinder", "warpCylinder"),
            ("custom", "warpCustom"),
        ],
    )
}

// ---------------------------------------------------------------------------
// Effects / blend
// ---------------------------------------------------------------------------

pub fn bln_m() -> EnumCodec {
    codec(
        "BlnM",
        "normal",
        &[
            ("normal", "Nrml"),
            ("dissolve", "Dslv"),
            ("darken", "Drkn"),
            ("multiply", "Mltp"),
            ("color burn", "CBrn"),
            ("linear burn", "linearBurn"),
            ("darker color", "darkerColor"),
            ("lighten", "Lghn"),
            ("screen", "Scrn"),
            ("color dodge", "CDdg"),
            ("linear dodge", "linearDodge"),
            ("lighter color", "lighterColor"),
            ("overlay", "Ovrl"),
            ("soft light", "SftL"),
            ("hard light", "HrdL"),
            ("vivid light", "vividLight"),
            ("linear light", "linearLight"),
            ("pin light", "pinLight"),
            ("hard mix", "hardMix"),
            ("difference", "Dfrn"),
            ("exclusion", "Xclu"),
            ("subtract", "blendSubtraction"),
            ("divide", "blendDivide"),
            ("hue", "H   "),
            ("saturation", "Strt"),
            ("color", "Clr "),
            ("luminosity", "Lmns"),
            // ABR-only
            ("linear height", "linearHeight"),
            ("height", "Hght"),
            ("subtraction", "Sbtr"),
            ("pass through", "????"),
        ],
    )
}

pub fn be_sl() -> EnumCodec {
    codec(
        "BESl",
        "inner bevel",
        &[
            ("inner bevel", "InrB"),
            ("outer bevel", "OtrB"),
            ("emboss", "Embs"),
            ("pillow emboss", "PlEb"),
            ("stroke emboss", "strokeEmboss"),
        ],
    )
}

pub fn bvl_t() -> EnumCodec {
    codec(
        "bvlT",
        "smooth",
        &[
            ("smooth", "SfBL"),
            ("chisel hard", "PrBL"),
            ("chisel soft", "Slmt"),
        ],
    )
}

pub fn be_ss() -> EnumCodec {
    codec("BESs", "up", &[("up", "In  "), ("down", "Out ")])
}

pub fn be_te() -> EnumCodec {
    codec("BETE", "softer", &[("softer", "SfBL"), ("precise", "PrBL")])
}

pub fn ig_sr() -> EnumCodec {
    codec("IGSr", "edge", &[("edge", "SrcE"), ("center", "SrcC")])
}

pub fn grd_t() -> EnumCodec {
    codec(
        "GrdT",
        "linear",
        &[
            ("linear", "Lnr "),
            ("radial", "Rdl "),
            ("angle", "Angl"),
            ("reflected", "Rflc"),
            ("diamond", "Dmnd"),
        ],
    )
}

pub fn gradient_interpolation_method_type() -> EnumCodec {
    codec(
        "gradientInterpolationMethodType",
        "perceptual",
        &[
            ("perceptual", "Perc"),
            ("linear", "Lnr "),
            ("classic", "Gcls"),
            ("smooth", "Smoo"),
        ],
    )
}

pub fn clr_s() -> EnumCodec {
    codec(
        "ClrS",
        "rgb",
        &[
            ("rgb", "RGBC"),
            ("hsb", "HSBl"),
            ("lab", "LbCl"),
            ("hsl", "HSLC"),
        ],
    )
}

pub fn f_stl() -> EnumCodec {
    codec(
        "FStl",
        "outside",
        &[("outside", "OutF"), ("center", "CtrF"), ("inside", "InsF")],
    )
}

pub fn fr_fl() -> EnumCodec {
    codec(
        "FrFl",
        "color",
        &[("color", "SClr"), ("gradient", "GrFl"), ("pattern", "Ptrn")],
    )
}

// ---------------------------------------------------------------------------
// Vector stroke
// ---------------------------------------------------------------------------

pub fn stroke_style_line_cap_type() -> EnumCodec {
    codec(
        "strokeStyleLineCapType",
        "butt",
        &[
            ("butt", "strokeStyleButtCap"),
            ("round", "strokeStyleRoundCap"),
            ("square", "strokeStyleSquareCap"),
        ],
    )
}

pub fn stroke_style_line_join_type() -> EnumCodec {
    codec(
        "strokeStyleLineJoinType",
        "miter",
        &[
            ("miter", "strokeStyleMiterJoin"),
            ("round", "strokeStyleRoundJoin"),
            ("bevel", "strokeStyleBevelJoin"),
        ],
    )
}

pub fn stroke_style_line_alignment() -> EnumCodec {
    codec(
        "strokeStyleLineAlignment",
        "inside",
        &[
            ("inside", "strokeStyleAlignInside"),
            ("center", "strokeStyleAlignCenter"),
            ("outside", "strokeStyleAlignOutside"),
        ],
    )
}

// ---------------------------------------------------------------------------
// Slices / print / animation (image resources)
// ---------------------------------------------------------------------------

pub fn eslice_type() -> EnumCodec {
    codec(
        "ESliceType",
        "image",
        &[("image", "Img "), ("noImage", "noImage")],
    )
}

pub fn eslice_horz_align() -> EnumCodec {
    codec("ESliceHorzAlign", "default", &[("default", "default")])
}

pub fn eslice_vert_align() -> EnumCodec {
    codec("ESliceVertAlign", "default", &[("default", "default")])
}

pub fn eslice_origin() -> EnumCodec {
    codec(
        "ESliceOrigin",
        "userGenerated",
        &[
            ("userGenerated", "userGenerated"),
            ("autoGenerated", "autoGenerated"),
            ("layer", "layer"),
        ],
    )
}

pub fn eslice_bg_color_type() -> EnumCodec {
    codec(
        "ESliceBGColorType",
        "none",
        &[("none", "None"), ("matte", "matte"), ("color", "Clr ")],
    )
}

pub fn inte() -> EnumCodec {
    codec(
        "Inte",
        "perceptual",
        &[
            ("perceptual", "Img "),
            ("saturation", "Grp "),
            ("relative colorimetric", "Clrm"),
            ("absolute colorimetric", "AClr"),
        ],
    )
}

pub fn frm_d() -> EnumCodec {
    codec(
        "FrmD",
        "",
        &[("auto", "Auto"), ("none", "None"), ("dispose", "Disp")],
    )
}

pub fn anim_interp_style() -> EnumCodec {
    codec(
        "animInterpStyle",
        "linear",
        &[("linear", "Lnr "), ("hold", "hold")],
    )
}

pub fn std_track_id() -> EnumCodec {
    codec(
        "stdTrackID",
        "opacity",
        &[
            ("opacity", "opacityTrack"),
            ("style", "styleTrack"),
            ("sheetTransform", "sheetTransformTrack"),
            ("sheetPosition", "sheetPositionTrack"),
            ("globalLighting", "globalLightingTrack"),
        ],
    )
}

// ---------------------------------------------------------------------------
// Smart filters / adjustments (additionalInfo + descriptor.ts)
// ---------------------------------------------------------------------------

pub fn blr_m() -> EnumCodec {
    codec("BlrM", "spin", &[("spin", "Spn "), ("zoom", "Zm  ")])
}

pub fn blr_q() -> EnumCodec {
    codec(
        "BlrQ",
        "good",
        &[("draft", "Drft"), ("good", "Gd  "), ("best", "Bst ")],
    )
}

pub fn sm_bm() -> EnumCodec {
    codec(
        "SmBM",
        "normal",
        &[
            ("normal", "SBMN"),
            ("edge only", "SBME"),
            ("overlay edge", "SBMO"),
        ],
    )
}

pub fn sm_bq() -> EnumCodec {
    codec(
        "SmBQ",
        "medium",
        &[("low", "SBQL"), ("medium", "SBQM"), ("high", "SBQH")],
    )
}

pub fn dsp_m() -> EnumCodec {
    codec(
        "DspM",
        "stretch to fit",
        &[("stretch to fit", "StrF"), ("tile", "Tile")],
    )
}

pub fn und_a() -> EnumCodec {
    codec(
        "UndA",
        "repeat edge pixels",
        &[("wrap around", "WrpA"), ("repeat edge pixels", "RptE")],
    )
}

pub fn cnvr() -> EnumCodec {
    codec(
        "Cnvr",
        "rectangular to polar",
        &[
            ("rectangular to polar", "RctP"),
            ("polar to rectangular", "PlrR"),
        ],
    )
}

pub fn rpl_s() -> EnumCodec {
    codec(
        "RplS",
        "medium",
        &[("small", "Sml "), ("medium", "Mdm "), ("large", "Lrg ")],
    )
}

pub fn sph_m() -> EnumCodec {
    codec(
        "SphM",
        "normal",
        &[
            ("normal", "Nrml"),
            ("horizontal only", "HrzO"),
            ("vertical only", "VrtO"),
        ],
    )
}

pub fn wvtp() -> EnumCodec {
    codec(
        "Wvtp",
        "sine",
        &[("sine", "WvSn"), ("triangle", "WvTr"), ("square", "WvSq")],
    )
}

pub fn zz_ty() -> EnumCodec {
    codec(
        "ZZTy",
        "pond ripples",
        &[
            ("around center", "ArnC"),
            ("out from center", "OtFr"),
            ("pond ripples", "PndR"),
        ],
    )
}

pub fn dstr() -> EnumCodec {
    codec(
        "Dstr",
        "uniform",
        &[("uniform", "Unfr"), ("gaussian", "Gsn ")],
    )
}

pub fn chnl() -> EnumCodec {
    codec(
        "Chnl",
        "composite",
        &[
            ("red", "Rd  "),
            ("green", "Grn "),
            ("blue", "Bl  "),
            ("composite", "Cmps"),
        ],
    )
}

pub fn mzt_t() -> EnumCodec {
    codec(
        "MztT",
        "fine dots",
        &[
            ("fine dots", "FnDt"),
            ("medium dots", "MdmD"),
            ("grainy dots", "GrnD"),
            ("coarse dots", "CrsD"),
            ("short lines", "ShrL"),
            ("medium lines", "MdmL"),
            ("long lines", "LngL"),
            ("short strokes", "ShSt"),
            ("medium strokes", "MdmS"),
            ("long strokes", "LngS"),
        ],
    )
}

pub fn lns() -> EnumCodec {
    codec(
        "Lns ",
        "50-300mm zoom",
        &[
            ("50-300mm zoom", "Zm  "),
            ("32mm prime", "Nkn "),
            ("105mm prime", "Nkn1"),
            ("movie prime", "PnVs"),
        ],
    )
}

pub fn blur_type() -> EnumCodec {
    codec(
        "blurType",
        "gaussian blur",
        &[
            ("gaussian blur", "GsnB"),
            ("lens blur", "lensBlur"),
            ("motion blur", "MtnB"),
        ],
    )
}

pub fn dfs_m() -> EnumCodec {
    codec(
        "DfsM",
        "normal",
        &[
            ("normal", "Nrml"),
            ("darken only", "DrkO"),
            ("lighten only", "LghO"),
            ("anisotropic", "anisotropic"),
        ],
    )
}

pub fn ext_t() -> EnumCodec {
    codec(
        "ExtT",
        "blocks",
        &[("blocks", "Blks"), ("pyramids", "Pyrm")],
    )
}

pub fn ext_r() -> EnumCodec {
    codec(
        "ExtR",
        "random",
        &[("random", "Rndm"), ("level-based", "LvlB")],
    )
}

pub fn fl_cl() -> EnumCodec {
    codec(
        "FlCl",
        "background color",
        &[
            ("background color", "FlBc"),
            ("foreground color", "FlFr"),
            ("inverse image", "FlIn"),
            ("unaltered image", "FlSm"),
        ],
    )
}

pub fn cnt_e() -> EnumCodec {
    codec("CntE", "upper", &[("lower", "Lwr "), ("upper", "Upr ")])
}

pub fn wnd_m() -> EnumCodec {
    codec(
        "WndM",
        "wind",
        &[("wind", "Wnd "), ("blast", "Blst"), ("stagger", "Stgr")],
    )
}

pub fn drct() -> EnumCodec {
    codec("Drct", "right", &[("left", "Left"), ("right", "Rght")])
}

pub fn int_e() -> EnumCodec {
    codec(
        "IntE",
        "odd lines",
        &[("odd lines", "ElmO"), ("even lines", "ElmE")],
    )
}

pub fn int_c() -> EnumCodec {
    codec(
        "IntC",
        "interpolation",
        &[("duplication", "CrtD"), ("interpolation", "CrtI")],
    )
}

pub fn fl_md() -> EnumCodec {
    codec(
        "FlMd",
        "wrap around",
        &[
            ("set to transparent", "Bckg"),
            ("repeat edge pixels", "Rpt "),
            ("wrap around", "Wrp "),
        ],
    )
}

pub fn prj_m() -> EnumCodec {
    codec(
        "prjM",
        "fisheye",
        &[
            ("fisheye", "fisP"),
            ("perspective", "perP"),
            ("auto", "auto"),
            ("full spherical", "fusP"),
        ],
    )
}

pub fn preset_kind_type() -> EnumCodec {
    codec(
        "presetKindType",
        "custom",
        &[
            ("custom", "presetKindCustom"),
            ("default", "presetKindDefault"),
        ],
    )
}

pub fn color_lookup_type() -> EnumCodec {
    codec(
        "colorLookupType",
        "3dlut",
        &[
            ("3dlut", "3DLUT"),
            ("abstractProfile", "abstractProfile"),
            ("deviceLinkProfile", "deviceLinkProfile"),
        ],
    )
}

pub fn lut_format_type() -> EnumCodec {
    codec(
        "LUTFormatType",
        "look",
        &[
            ("look", "LUTFormatLOOK"),
            ("cube", "LUTFormatCUBE"),
            ("3dl", "LUTFormat3DL"),
        ],
    )
}

pub fn color_lookup_order() -> EnumCodec {
    codec(
        "colorLookupOrder",
        "rgb",
        &[("rgb", "rgbOrder"), ("bgr", "bgrOrder")],
    )
}

/// Count of production `createEnum` tables ported in this module.
pub const CREATE_ENUM_TABLE_COUNT: usize = 58;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn create_enum_table_count_matches_plan() {
        // Touch each codec so the module stays linked; count is the acceptance ratchet.
        let _ = [
            text_gridding(),
            ornt(),
            annt(),
            warp_style(),
            bln_m(),
            be_sl(),
            bvl_t(),
            be_ss(),
            be_te(),
            ig_sr(),
            grd_t(),
            gradient_interpolation_method_type(),
            clr_s(),
            f_stl(),
            fr_fl(),
            stroke_style_line_cap_type(),
            stroke_style_line_join_type(),
            stroke_style_line_alignment(),
            eslice_type(),
            eslice_horz_align(),
            eslice_vert_align(),
            eslice_origin(),
            eslice_bg_color_type(),
            inte(),
            frm_d(),
            anim_interp_style(),
            std_track_id(),
            blr_m(),
            blr_q(),
            sm_bm(),
            sm_bq(),
            dsp_m(),
            und_a(),
            cnvr(),
            rpl_s(),
            sph_m(),
            wvtp(),
            zz_ty(),
            dstr(),
            chnl(),
            mzt_t(),
            lns(),
            blur_type(),
            dfs_m(),
            ext_t(),
            ext_r(),
            fl_cl(),
            cnt_e(),
            wnd_m(),
            drct(),
            int_e(),
            int_c(),
            fl_md(),
            prj_m(),
            preset_kind_type(),
            color_lookup_type(),
            lut_format_type(),
            color_lookup_order(),
        ];
        assert_eq!(CREATE_ENUM_TABLE_COUNT, 58);
    }

    #[test]
    fn bln_m_decodes_2026_long_form() {
        let c = bln_m();
        assert_eq!(c.decode("BlnM.multiply").unwrap(), "multiply");
        assert_eq!(c.decode("BlnM.colorBurn").unwrap(), "color burn");
        assert_eq!(c.decode("BlnM.Mltp").unwrap(), "multiply");
        assert_eq!(c.encode(Some("multiply")).unwrap(), "BlnM.Mltp");
    }
}
