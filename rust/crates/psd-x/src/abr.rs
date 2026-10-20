/*
File: rust/crates/psd-x/src/abr.rs

Purpose:
reading Photoshop brushes (.abr).

Source compatibility:
- port of upstream ag-psd `src/abr.ts`. Upstream is READ-ONLY (no `writeAbr`),
  so only `read_abr` is ported here.

RLE / patterns: use crate-level `reader::read_data_rle` and `reader::read_pattern`
(no private PackBits copy; a local one could OOB-panic on bad lengths).

Blend modes: `blnm_decode` goes through `descriptor_enums::bln_m()` so ABR-only
variants (`linear height` / `height` / `subtraction`) stay wired to [`BlendMode`].

Main responsibilities:
- parse ABR versions 6/7/9/10 (minor 1/2): '8BIM' sections samp/desc/patt/phry.
*/

use crate::descriptor::{Descriptor, DescriptorValue, UnitDoubleValue};
use crate::descriptor_enums;
use crate::psd::{BlendMode, PatternInfo};
use crate::reader::{
    AllocationCategory, DecodeTarget, PsdReader, ReadError, ReadResult, check_signature,
    read_bytes, read_data_rle, read_int16, read_int32, read_pascal_string, read_pattern,
    read_signature, read_uint8, read_uint16, read_uint32, skip_bytes,
};

// ===========================================================================
// Data model (mirror of abr.ts interfaces)
// ===========================================================================

/// TS `Abr`.
#[derive(Debug, Clone, Default)]
pub struct Abr {
    pub brushes: Vec<Brush>,
    pub samples: Vec<SampleInfo>,
    pub patterns: Vec<PatternInfo>,
}

/// TS `SampleInfo`.
#[derive(Debug, Clone)]
pub struct SampleInfo {
    pub id: String,
    pub bounds: SampleBounds,
    pub alpha: Vec<u8>,
}

#[derive(Debug, Clone, Copy, Default)]
pub struct SampleBounds {
    pub x: i32,
    pub y: i32,
    pub w: i32,
    pub h: i32,
}

/// TS `BrushDynamics`.
#[derive(Debug, Clone)]
pub struct BrushDynamics {
    /// control: 'off' | 'fade' | 'pen pressure' | ...
    pub control: String,
    pub steps: f64,
    pub jitter: f64,
    pub minimum: f64,
}

const DYNAMICS_CONTROL: &[&str] = &[
    "off",
    "fade",
    "pen pressure",
    "pen tilt",
    "stylus wheel",
    "initial direction",
    "direction",
    "initial rotation",
    "rotation",
];

const DYNAMIC_BRUSH_SHAPE_SHAPES: &[&str] = &[
    "round point",
    "round blunt",
    "round curve",
    "round angle",
    "round fan",
    "flat point",
    "flat blunt",
    "flat curve",
    "flat angle",
    "flat fan",
];

const TIPS_BRUSH_SHAPE_SHAPES: &[&str] = &[
    "erodible point",
    "erodible flat",
    "erodible round",
    "erodible square",
    "erodible triangle",
    "custom",
];

/// TS `BrushShape` union.
#[derive(Debug, Clone)]
pub enum BrushShape {
    Computed {
        size: f64,
        angle: f64,
        roundness: f64,
        hardness: f64,
        spacing_on: bool,
        spacing: f64,
        flip_x: bool,
        flip_y: bool,
    },
    Sampled {
        name: String,
        size: f64,
        angle: f64,
        roundness: f64,
        spacing_on: bool,
        spacing: f64,
        flip_x: bool,
        flip_y: bool,
        sampled_data: String,
    },
    Tips {
        angle: f64,
        size: f64,
        shape: String,
        physics: bool,
        spacing: f64,
        spacing_on: bool,
        flip_x: bool,
        flip_y: bool,
        tips_type: String,
        tips_length_ratio: f64,
        tips_hardness: f64,
        tips_grid_size: Option<f64>,
        tips_erodible_tip_height_map: Option<Vec<u8>>,
        tips_airbrush_cutoff_angle: f64,
        tips_airbrush_granularity: f64,
        tips_airbrush_streakiness: f64,
        tips_airbrush_splat_size: f64,
        tips_airbrush_splat_count: f64,
    },
    Dynamic {
        size: f64,
        angle: f64,
        shape: String,
        density: f64,
        length: f64,
        clumping: f64,
        thickness: f64,
        stiffness: f64,
        physics: bool,
        spacing: f64,
        spacing_on: bool,
        flip_x: bool,
        flip_y: bool,
    },
}

#[derive(Debug, Clone)]
pub struct ShapeDynamics {
    pub size_dynamics: BrushDynamics,
    pub minimum_diameter: f64,
    pub tilt_scale: f64,
    pub angle_dynamics: BrushDynamics,
    pub roundness_dynamics: BrushDynamics,
    pub minimum_roundness: f64,
    pub flip_x: bool,
    pub flip_y: bool,
    pub brush_projection: bool,
}

#[derive(Debug, Clone)]
pub struct Scatter {
    pub both_axes: bool,
    pub scatter_dynamics: BrushDynamics,
    pub count_dynamics: BrushDynamics,
    pub count: f64,
}

#[derive(Debug, Clone)]
pub struct Texture {
    pub id: String,
    pub name: String,
    pub invert: bool,
    pub scale: f64,
    pub brightness: f64,
    pub contrast: f64,
    pub blend_mode: BlendMode,
    pub depth: f64,
    pub depth_minimum: f64,
    pub depth_dynamics: BrushDynamics,
    pub texture_each_tip: bool,
}

#[derive(Debug, Clone)]
pub struct DualBrush {
    pub flip: bool,
    pub shape: BrushShape,
    pub blend_mode: BlendMode,
    pub use_scatter: bool,
    pub spacing: f64,
    pub count: f64,
    pub both_axes: bool,
    pub count_dynamics: BrushDynamics,
    pub scatter_dynamics: BrushDynamics,
}

#[derive(Debug, Clone)]
pub struct ColorDynamics {
    pub foreground_background: BrushDynamics,
    pub hue: f64,
    pub saturation: f64,
    pub brightness: f64,
    pub purity: f64,
    pub per_tip: bool,
}

#[derive(Debug, Clone)]
pub struct Transfer {
    pub flow_dynamics: BrushDynamics,
    pub opacity_dynamics: BrushDynamics,
    pub wetness_dynamics: BrushDynamics,
    pub mix_dynamics: BrushDynamics,
}

#[derive(Debug, Clone)]
pub struct BrushPose {
    pub override_angle: bool,
    pub override_tilt_x: bool,
    pub override_tilt_y: bool,
    pub override_pressure: bool,
    pub pressure: f64,
    pub tilt_x: f64,
    pub tilt_y: f64,
    pub angle: f64,
}

/// TS `Brush.toolOptions.type`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ToolType {
    Brush,
    MixerBrush,
    SmudgeBrush,
}

#[derive(Debug, Clone)]
pub struct ToolOptions {
    pub type_: ToolType,
    pub brush_preset: bool,
    pub flow: f64,
    pub wetness: Option<f64>,
    pub dryness: Option<f64>,
    pub mix: Option<f64>,
    pub smooth: f64,
    pub mode: BlendMode,
    pub opacity: f64,
    pub smoothing: bool,
    pub smoothing_value: f64,
    pub smoothing_radius_mode: bool,
    pub smoothing_catchup: bool,
    pub smoothing_catchup_at_end: bool,
    pub smoothing_zoom_compensation: bool,
    pub pressure_smoothing: bool,
    pub use_pressure_overrides_size: bool,
    pub use_pressure_overrides_opacity: bool,
    pub use_legacy: bool,
    pub auto_fill: Option<bool>,
    pub auto_clean: Option<bool>,
    pub load_solid_color_only: Option<bool>,
    pub sample_all_layers: Option<bool>,
    pub flow_dynamics: Option<BrushDynamics>,
    pub opacity_dynamics: Option<BrushDynamics>,
    pub size_dynamics: Option<BrushDynamics>,
    pub smudge_finger_painting: Option<bool>,
    pub smudge_sample_all_layers: Option<bool>,
    pub strength: Option<f64>,
}

/// TS `Brush`.
#[derive(Debug, Clone)]
pub struct Brush {
    pub name: String,
    pub shape: BrushShape,
    pub shape_dynamics: Option<ShapeDynamics>,
    pub scatter: Option<Scatter>,
    pub texture: Option<Texture>,
    pub dual_brush: Option<DualBrush>,
    pub color_dynamics: Option<ColorDynamics>,
    pub transfer: Option<Transfer>,
    pub brush_pose: Option<BrushPose>,
    pub noise: bool,
    pub wet_edges: bool,
    pub protect_texture: Option<bool>,
    pub spacing: f64,
    pub interpretation: Option<bool>,
    pub use_brush_size: bool,
    pub tool_options: Option<ToolOptions>,
}

// ===========================================================================
// Descriptor accessors (thin wrapper over the typed tree)
// ===========================================================================

fn dget<'a>(d: &'a Descriptor, key: &str) -> Option<&'a DescriptorValue> {
    d.get(key)
}

fn as_bool(v: Option<&DescriptorValue>) -> bool {
    matches!(v, Some(DescriptorValue::Boolean(true)))
}

fn as_opt_bool(v: Option<&DescriptorValue>) -> Option<bool> {
    match v {
        Some(DescriptorValue::Boolean(b)) => Some(*b),
        _ => None,
    }
}

fn as_number(v: Option<&DescriptorValue>) -> f64 {
    match v {
        Some(DescriptorValue::Integer(i)) => *i as f64,
        Some(DescriptorValue::Double(d)) => *d,
        Some(DescriptorValue::UnitDouble(u)) => u.value,
        _ => 0.0,
    }
}

fn as_opt_number(v: Option<&DescriptorValue>) -> Option<f64> {
    match v {
        Some(DescriptorValue::Integer(i)) => Some(*i as f64),
        Some(DescriptorValue::Double(d)) => Some(*d),
        Some(DescriptorValue::UnitDouble(u)) => Some(u.value),
        _ => None,
    }
}

fn to_text(v: Option<&DescriptorValue>) -> String {
    match v {
        Some(DescriptorValue::Text(s)) => s.clone(),
        Some(DescriptorValue::Enum(s)) => s.clone(),
        _ => String::new(),
    }
}

fn as_descriptor(v: Option<&DescriptorValue>) -> Option<&Descriptor> {
    match v {
        Some(DescriptorValue::Descriptor(d)) => Some(d),
        _ => None,
    }
}

fn as_units<'a>(v: Option<&'a DescriptorValue>) -> Option<&'a UnitDoubleValue> {
    match v {
        Some(DescriptorValue::UnitDouble(u)) => Some(u),
        _ => None,
    }
}

fn as_raw(v: Option<&DescriptorValue>) -> Option<&[u8]> {
    match v {
        Some(DescriptorValue::RawData(b)) => Some(b),
        _ => None,
    }
}

// ===========================================================================
// Parse helpers (local variants of the descriptor.rs parsers over
// Option<&DescriptorValue>; the canonical ports live in descriptor.rs)
// ===========================================================================

/// Mirror of `parseAngle(x)`: 0 if undefined; otherwise requires units == 'Angle'.
fn parse_angle(v: Option<&DescriptorValue>) -> ReadResult<f64> {
    match as_units(v) {
        None => Ok(0.0),
        Some(u) => {
            if u.units != "Angle" {
                return Err(ReadError::StrictViolation(format!(
                    "Invalid units: {}",
                    u.units
                )));
            }
            Ok(u.value)
        }
    }
}

/// Mirror of `parsePercent(x)`: 1 if undefined; otherwise units == 'Percent', value/100.
fn parse_percent(v: Option<&DescriptorValue>) -> ReadResult<f64> {
    match as_units(v) {
        None => Ok(1.0),
        Some(u) => {
            if u.units != "Percent" {
                return Err(ReadError::StrictViolation(format!(
                    "Invalid units: {}",
                    u.units
                )));
            }
            Ok(u.value / 100.0)
        }
    }
}

/// Mirror of `parseUnitsToNumber(x, expectedUnits)`: requires matching units.
fn parse_units_to_number(v: Option<&DescriptorValue>, expected: &str) -> ReadResult<f64> {
    match as_units(v) {
        Some(u) if u.units == expected => Ok(u.value),
        Some(u) => Err(ReadError::StrictViolation(format!(
            "Invalid units: {}",
            u.units
        ))),
        None => Err(ReadError::StrictViolation(format!(
            "Invalid units: missing (expected {})",
            expected
        ))),
    }
}

/// Mirror upstream `BlnM.decode(code)` → [`BlendMode`].
///
/// Uses the shared descriptor enum table (includes ABR-only `linear height` /
/// `height` / `subtraction`). Unrecognized codes fall back to Normal, matching
/// the prior private match arms.
fn blnm_decode(code: &str) -> BlendMode {
    match descriptor_enums::bln_m().decode(code) {
        Ok(name) => BlendMode::from_json_str(&name).unwrap_or(BlendMode::Normal),
        Err(_) => BlendMode::Normal,
    }
}

fn parse_dynamics(desc: &Descriptor) -> ReadResult<BrushDynamics> {
    let control_index = as_number(dget(desc, "bVTy")) as usize;
    Ok(BrushDynamics {
        control: DYNAMICS_CONTROL
            .get(control_index)
            .copied()
            .unwrap_or("off")
            .to_string(),
        steps: as_number(dget(desc, "fStp")),
        jitter: parse_percent(dget(desc, "jitter"))?,
        minimum: parse_percent(dget(desc, "Mnm "))?,
    })
}

fn parse_dynamics_opt(v: Option<&DescriptorValue>) -> ReadResult<Option<BrushDynamics>> {
    match as_descriptor(v) {
        Some(d) => Ok(Some(parse_dynamics(d)?)),
        None => Ok(None),
    }
}

fn parse_heightmap(array: &[u8]) -> Vec<u8> {
    array.to_vec()
}

fn parse_brush_shape(desc: &Descriptor) -> ReadResult<BrushShape> {
    match desc.class_id.as_str() {
        "computedBrush" => Ok(BrushShape::Computed {
            size: parse_units_to_number(dget(desc, "Dmtr"), "Pixels")?,
            angle: parse_angle(dget(desc, "Angl"))?,
            roundness: parse_percent(dget(desc, "Rndn"))?,
            spacing_on: as_bool(dget(desc, "Intr")),
            spacing: parse_percent(dget(desc, "Spcn"))?,
            flip_x: as_bool(dget(desc, "flipX")),
            flip_y: as_bool(dget(desc, "flipY")),
            hardness: parse_percent(dget(desc, "Hrdn"))?,
        }),
        "sampledBrush" => Ok(BrushShape::Sampled {
            size: parse_units_to_number(dget(desc, "Dmtr"), "Pixels")?,
            angle: parse_angle(dget(desc, "Angl"))?,
            roundness: parse_percent(dget(desc, "Rndn"))?,
            spacing_on: as_bool(dget(desc, "Intr")),
            spacing: parse_percent(dget(desc, "Spcn"))?,
            flip_x: as_bool(dget(desc, "flipX")),
            flip_y: as_bool(dget(desc, "flipY")),
            name: to_text(dget(desc, "Nm  ")),
            sampled_data: to_text(dget(desc, "sampledData")),
        }),
        "dBrush" => Ok(BrushShape::Dynamic {
            shape: shape_name(DYNAMIC_BRUSH_SHAPE_SHAPES, as_number(dget(desc, "Shp "))),
            angle: parse_angle(dget(desc, "Angl"))?,
            size: parse_units_to_number(dget(desc, "Dmtr"), "Pixels")?,
            density: parse_percent(dget(desc, "Dnst"))?,
            length: parse_percent(dget(desc, "Lngt"))?,
            clumping: parse_percent(dget(desc, "clumping"))?,
            thickness: parse_percent(dget(desc, "thickness"))?,
            stiffness: parse_percent(dget(desc, "stiffness"))?,
            physics: as_bool(dget(desc, "physics")),
            spacing: parse_percent(dget(desc, "Spcn"))?,
            spacing_on: as_bool(dget(desc, "Intr")),
            flip_x: as_bool(dget(desc, "flipX")),
            flip_y: as_bool(dget(desc, "flipY")),
        }),
        "dTips" => {
            let grid_size = as_number(dget(desc, "dtipsGridSize"));
            let height_map = as_raw(dget(desc, "dtipsErodibleTipHeightMap"));
            let (tips_grid_size, tips_erodible_tip_height_map) =
                if grid_size != 0.0 && height_map.is_some() {
                    (Some(grid_size), Some(parse_heightmap(height_map.unwrap())))
                } else {
                    (None, None)
                };
            Ok(BrushShape::Tips {
                angle: parse_angle(dget(desc, "Angl"))?,
                size: parse_units_to_number(dget(desc, "Dmtr"), "Pixels")?,
                shape: shape_name(DYNAMIC_BRUSH_SHAPE_SHAPES, as_number(dget(desc, "Shp "))),
                physics: as_bool(dget(desc, "physics")),
                spacing: parse_percent(dget(desc, "Spcn"))?,
                spacing_on: as_bool(dget(desc, "Intr")),
                flip_x: as_bool(dget(desc, "flipX")),
                flip_y: as_bool(dget(desc, "flipY")),
                tips_type: shape_name(TIPS_BRUSH_SHAPE_SHAPES, as_number(dget(desc, "dtipsType"))),
                tips_length_ratio: parse_percent(dget(desc, "dtipsLengthRatio"))?,
                tips_hardness: parse_percent(dget(desc, "dtipsHardness"))?,
                tips_grid_size,
                tips_erodible_tip_height_map,
                tips_airbrush_cutoff_angle: as_number(dget(desc, "dtipsAirbrushCutoffAngle")),
                tips_airbrush_granularity: parse_percent(dget(desc, "dtipsAirbrushGranularity"))?,
                tips_airbrush_streakiness: parse_percent(dget(desc, "dtipsAirbrushStreakiness"))?,
                tips_airbrush_splat_size: parse_percent(dget(desc, "dtipsAirbrushSplatSize"))?,
                tips_airbrush_splat_count: as_number(dget(desc, "dtipsAirbrushSplatCount")),
            })
        }
        other => Err(ReadError::StrictViolation(format!(
            "Unknown brush classId: {}",
            other
        ))),
    }
}

fn shape_name(table: &[&str], index: f64) -> String {
    table.get(index as usize).copied().unwrap_or("").to_string()
}

const TO_BRUSH_TYPE: &[(&str, ToolType)] = &[
    ("_", ToolType::Brush),
    ("MixB", ToolType::MixerBrush),
    ("SmTl", ToolType::SmudgeBrush),
];

fn to_brush_type(class_id: &str) -> ToolType {
    TO_BRUSH_TYPE
        .iter()
        .find(|(k, _)| *k == class_id)
        .map(|(_, t)| *t)
        .unwrap_or(ToolType::Brush)
}

// ===========================================================================
// Brush descriptor -> Brush
// ===========================================================================

fn parse_brush(brush: &Descriptor) -> ReadResult<Brush> {
    let shape_desc = as_descriptor(dget(brush, "Brsh"))
        .ok_or_else(|| ReadError::StrictViolation("Missing brush shape descriptor".to_string()))?;

    let mut b = Brush {
        name: to_text(dget(brush, "Nm  ")),
        shape: parse_brush_shape(shape_desc)?,
        spacing: parse_percent(dget(brush, "Spcn"))?,
        wet_edges: as_bool(dget(brush, "Wtdg")),
        noise: as_bool(dget(brush, "Nose")),
        use_brush_size: as_bool(dget(brush, "useBrushSize")),
        shape_dynamics: None,
        scatter: None,
        texture: None,
        dual_brush: None,
        color_dynamics: None,
        transfer: None,
        brush_pose: None,
        protect_texture: None,
        interpretation: None,
        tool_options: None,
    };

    if let Some(v) = as_opt_bool(dget(brush, "interpretation")) {
        b.interpretation = Some(v);
    }
    if let Some(v) = as_opt_bool(dget(brush, "protectTexture")) {
        b.protect_texture = Some(v);
    }

    if as_bool(dget(brush, "useTipDynamics")) {
        b.shape_dynamics = Some(ShapeDynamics {
            tilt_scale: parse_percent(dget(brush, "tiltScale"))?,
            size_dynamics: parse_dynamics_desc(brush, "szVr")?,
            angle_dynamics: parse_dynamics_desc(brush, "angleDynamics")?,
            roundness_dynamics: parse_dynamics_desc(brush, "roundnessDynamics")?,
            flip_x: as_bool(dget(brush, "flipX")),
            flip_y: as_bool(dget(brush, "flipY")),
            brush_projection: as_bool(dget(brush, "brushProjection")),
            minimum_diameter: parse_percent(dget(brush, "minimumDiameter"))?,
            minimum_roundness: parse_percent(dget(brush, "minimumRoundness"))?,
        });
    }

    if as_bool(dget(brush, "useScatter")) {
        b.scatter = Some(Scatter {
            count: as_number(dget(brush, "Cnt ")),
            both_axes: as_bool(dget(brush, "bothAxes")),
            count_dynamics: parse_dynamics_desc(brush, "countDynamics")?,
            scatter_dynamics: parse_dynamics_desc(brush, "scatterDynamics")?,
        });
    }

    if as_bool(dget(brush, "useTexture")) {
        if let Some(txtr) = as_descriptor(dget(brush, "Txtr")) {
            b.texture = Some(Texture {
                id: to_text(dget(txtr, "Idnt")),
                name: to_text(dget(txtr, "Nm  ")),
                blend_mode: blnm_decode(&to_text(dget(brush, "textureBlendMode"))),
                depth: parse_percent(dget(brush, "textureDepth"))?,
                depth_minimum: parse_percent(dget(brush, "minimumDepth"))?,
                depth_dynamics: parse_dynamics_desc(brush, "textureDepthDynamics")?,
                scale: parse_percent(dget(brush, "textureScale"))?,
                invert: as_bool(dget(brush, "InvT")),
                brightness: as_number(dget(brush, "textureBrightness")),
                contrast: as_number(dget(brush, "textureContrast")),
                texture_each_tip: as_bool(dget(brush, "TxtC")),
            });
        }
    }

    if let Some(db) = as_descriptor(dget(brush, "dualBrush")) {
        if as_bool(dget(db, "useDualBrush")) {
            let db_shape = as_descriptor(dget(db, "Brsh")).ok_or_else(|| {
                ReadError::StrictViolation("Missing dual brush shape".to_string())
            })?;
            b.dual_brush = Some(DualBrush {
                flip: as_bool(dget(db, "Flip")),
                shape: parse_brush_shape(db_shape)?,
                blend_mode: blnm_decode(&to_text(dget(db, "BlnM"))),
                use_scatter: as_bool(dget(db, "useScatter")),
                spacing: parse_percent(dget(db, "Spcn"))?,
                count: as_number(dget(db, "Cnt ")),
                both_axes: as_bool(dget(db, "bothAxes")),
                count_dynamics: parse_dynamics_desc(db, "countDynamics")?,
                scatter_dynamics: parse_dynamics_desc(db, "scatterDynamics")?,
            });
        }
    }

    if as_bool(dget(brush, "useColorDynamics")) {
        b.color_dynamics = Some(ColorDynamics {
            foreground_background: parse_dynamics_desc(brush, "clVr")?,
            hue: parse_percent(dget(brush, "H   "))?,
            saturation: parse_percent(dget(brush, "Strt"))?,
            brightness: parse_percent(dget(brush, "Brgh"))?,
            purity: parse_percent(dget(brush, "purity"))?,
            per_tip: as_bool(dget(brush, "colorDynamicsPerTip")),
        });
    }

    if as_bool(dget(brush, "usePaintDynamics")) {
        b.transfer = Some(Transfer {
            flow_dynamics: parse_dynamics_desc(brush, "prVr")?,
            opacity_dynamics: parse_dynamics_desc(brush, "opVr")?,
            wetness_dynamics: parse_dynamics_desc(brush, "wtVr")?,
            mix_dynamics: parse_dynamics_desc(brush, "mxVr")?,
        });
    }

    if as_bool(dget(brush, "useBrushPose")) {
        b.brush_pose = Some(BrushPose {
            override_angle: as_bool(dget(brush, "overridePoseAngle")),
            override_tilt_x: as_bool(dget(brush, "overridePoseTiltX")),
            override_tilt_y: as_bool(dget(brush, "overridePoseTiltY")),
            override_pressure: as_bool(dget(brush, "overridePosePressure")),
            pressure: parse_percent(dget(brush, "brushPosePressure"))?,
            tilt_x: as_number(dget(brush, "brushPoseTiltX")),
            tilt_y: as_number(dget(brush, "brushPoseTiltY")),
            angle: as_number(dget(brush, "brushPoseAngle")),
        });
    }

    if let Some(to) = as_descriptor(dget(brush, "toolOptions")) {
        let mut opts = ToolOptions {
            type_: to_brush_type(&to.class_id),
            brush_preset: as_bool(dget(to, "brushPreset")),
            flow: as_opt_number(dget(to, "flow")).unwrap_or(100.0),
            smooth: as_opt_number(dget(to, "Smoo")).unwrap_or(0.0),
            mode: blnm_decode(&{
                let m = to_text(dget(to, "Md  "));
                if m.is_empty() {
                    "BlnM.Nrml".to_string()
                } else {
                    m
                }
            }),
            opacity: as_opt_number(dget(to, "Opct")).unwrap_or(100.0),
            smoothing: as_bool(dget(to, "smoothing")),
            smoothing_value: as_opt_number(dget(to, "smoothingValue")).unwrap_or(0.0),
            smoothing_radius_mode: as_bool(dget(to, "smoothingRadiusMode")),
            smoothing_catchup: as_bool(dget(to, "smoothingCatchup")),
            smoothing_catchup_at_end: as_bool(dget(to, "smoothingCatchupAtEnd")),
            smoothing_zoom_compensation: as_bool(dget(to, "smoothingZoomCompensation")),
            pressure_smoothing: as_bool(dget(to, "pressureSmoothing")),
            use_pressure_overrides_size: as_bool(dget(to, "usePressureOverridesSize")),
            use_pressure_overrides_opacity: as_bool(dget(to, "usePressureOverridesOpacity")),
            use_legacy: as_bool(dget(to, "useLegacy")),
            wetness: None,
            dryness: None,
            mix: None,
            auto_fill: None,
            auto_clean: None,
            load_solid_color_only: None,
            sample_all_layers: None,
            flow_dynamics: None,
            opacity_dynamics: None,
            size_dynamics: None,
            smudge_finger_painting: None,
            smudge_sample_all_layers: None,
            strength: None,
        };

        opts.flow_dynamics = parse_dynamics_opt(dget(to, "prVr"))?;
        opts.opacity_dynamics = parse_dynamics_opt(dget(to, "opVr"))?;
        opts.size_dynamics = parse_dynamics_opt(dget(to, "szVr"))?;
        if let Some(v) = as_opt_number(dget(to, "wetness")) {
            opts.wetness = Some(v);
        }
        if let Some(v) = as_opt_number(dget(to, "dryness")) {
            opts.dryness = Some(v);
        }
        if let Some(v) = as_opt_number(dget(to, "mix")) {
            opts.mix = Some(v);
        }
        if let Some(v) = as_opt_bool(dget(to, "autoFill")) {
            opts.auto_fill = Some(v);
        }
        if let Some(v) = as_opt_bool(dget(to, "autoClean")) {
            opts.auto_clean = Some(v);
        }
        if let Some(v) = as_opt_bool(dget(to, "loadSolidColorOnly")) {
            opts.load_solid_color_only = Some(v);
        }
        if let Some(v) = as_opt_bool(dget(to, "sampleAllLayers")) {
            opts.sample_all_layers = Some(v);
        }
        if let Some(v) = as_opt_bool(dget(to, "SmdF")) {
            opts.smudge_finger_painting = Some(v);
        }
        if let Some(v) = as_opt_bool(dget(to, "SmdS")) {
            opts.smudge_sample_all_layers = Some(v);
        }
        if let Some(v) = as_opt_number(dget(to, "Prs ")) {
            opts.strength = Some(v);
        }

        b.tool_options = Some(opts);
    }

    Ok(b)
}

fn parse_dynamics_desc(parent: &Descriptor, key: &str) -> ReadResult<BrushDynamics> {
    match as_descriptor(dget(parent, key)) {
        Some(d) => parse_dynamics(d),
        None => Err(ReadError::StrictViolation(format!(
            "Missing dynamics descriptor: {}",
            key
        ))),
    }
}

// ===========================================================================
// Main reader
// ===========================================================================

/// Options for `readAbr`.
#[derive(Debug, Clone, Default)]
pub struct ReadAbrOptions {
    pub log_missing_features: bool,
}

/// Port of `readAbr(buffer, options)`.
pub fn read_abr(buffer: &[u8], _options: &ReadAbrOptions) -> ReadResult<Abr> {
    let reader = &mut PsdReader::new(buffer, None, None);
    let version = read_int16(reader)?;
    let mut samples: Vec<SampleInfo> = Vec::new();
    let mut brushes: Vec<Brush> = Vec::new();
    let mut patterns: Vec<PatternInfo> = Vec::new();

    if version == 1 || version == 2 {
        return Err(ReadError::StrictViolation(format!(
            "Unsupported ABR version ({})",
            version
        )));
    } else if version == 6 || version == 7 || version == 9 || version == 10 {
        let minor_version = read_int16(reader)?;
        if minor_version != 1 && minor_version != 2 {
            return Err(ReadError::StrictViolation(
                "Unsupported ABR minor version".to_string(),
            ));
        }

        while reader.offset < reader.len() {
            check_signature(reader, "8BIM", None)?;
            let type_ = read_signature(reader)?;
            let mut size = read_uint32(reader)? as usize;
            let end = reader.offset + size;

            match type_.as_str() {
                "samp" => {
                    while reader.offset < end {
                        let mut brush_length = read_uint32(reader)? as usize;
                        while brush_length & 0b11 != 0 {
                            brush_length += 1; // pad to 4 byte alignment
                        }
                        let brush_end = reader.offset + brush_length;

                        let id = read_pascal_string(reader, 1)?;

                        // v1 - skip Int16 bounds + unknown Int16 (10 bytes)
                        // v2 - skip unknown 264 bytes
                        skip_bytes(reader, if minor_version == 1 { 10 } else { 264 });

                        let y = read_int32(reader)?;
                        let x = read_int32(reader)?;
                        // Bounds come from the file and are attacker-chosen:
                        // plain subtraction/product wraps in release builds
                        // (overflow checks are off), and a wrapped value can
                        // slip past the `<= 0` check straight into a huge
                        // `vec![0u8; …]` that aborts the process. Fail typed.
                        let h = read_int32(reader)?.checked_sub(y).ok_or_else(|| {
                            ReadError::StrictViolation("Invalid bounds".to_string())
                        })?;
                        let w = read_int32(reader)?.checked_sub(x).ok_or_else(|| {
                            ReadError::StrictViolation("Invalid bounds".to_string())
                        })?;
                        if w <= 0 || h <= 0 {
                            return Err(ReadError::StrictViolation("Invalid bounds".to_string()));
                        }

                        let bit_depth = read_int16(reader)?;
                        let compression = read_uint8(reader)?; // 0 - raw, 1 - RLE
                        let pixels = u64::from(w as u32) * u64::from(h as u32);
                        let pixels =
                            usize::try_from(pixels).map_err(|_| ReadError::SizeTooLarge)?;
                        // The sample buffer is a parse-time temporary: charge
                        // it to the ledger so a hostile w×h meets the memory
                        // ceiling instead of an unbounded allocation.
                        let _lease =
                            reader.reserve_allocation(AllocationCategory::Channel, pixels)?;
                        let mut alpha = Vec::new();
                        alpha.try_reserve_exact(pixels).map_err(|_| {
                            ReadError::AllocationFailed {
                                requested: pixels,
                                category: AllocationCategory::Channel,
                            }
                        })?;
                        alpha.resize(pixels, 0);

                        if bit_depth == 8 {
                            if compression == 0 {
                                let bytes = read_bytes(reader, alpha.len())?;
                                alpha.copy_from_slice(&bytes);
                            } else if compression == 1 {
                                let mut target = DecodeTarget {
                                    width: w as usize,
                                    height: h as usize,
                                    data: std::mem::take(&mut alpha),
                                    channels: 1,
                                    depth: 8,
                                };
                                read_data_rle(
                                    reader,
                                    Some(&mut target),
                                    w as usize,
                                    h as usize,
                                    8,
                                    1,
                                    &[0],
                                    false,
                                )?;
                                alpha = target.data;
                            } else {
                                return Err(ReadError::StrictViolation(
                                    "Invalid compression".to_string(),
                                ));
                            }
                        } else if bit_depth == 16 {
                            if compression == 0 {
                                for i in 0..alpha.len() {
                                    alpha[i] = (read_uint16(reader)? >> 8) as u8;
                                    // -> 8bit
                                }
                            } else if compression == 1 {
                                return Err(ReadError::StrictViolation(
                                    "not implemented (16bit RLE)".to_string(),
                                ));
                            } else {
                                return Err(ReadError::StrictViolation(
                                    "Invalid compression".to_string(),
                                ));
                            }
                        } else {
                            return Err(ReadError::StrictViolation("Invalid depth".to_string()));
                        }

                        samples.push(SampleInfo {
                            id,
                            bounds: SampleBounds { x, y, w, h },
                            alpha,
                        });
                        reader.offset = brush_end;
                    }
                }
                "desc" => {
                    let desc = crate::descriptor::read_version_and_descriptor(reader)?;
                    if let Some(DescriptorValue::List(list)) = dget(&desc, "Brsh") {
                        for item in list {
                            if let DescriptorValue::Descriptor(brush) = item {
                                brushes.push(parse_brush(brush)?);
                            }
                        }
                    }
                }
                "patt" => {
                    while reader.offset < end {
                        patterns.push(read_pattern(reader)?);
                    }
                    reader.offset = end;
                }
                "phry" => {
                    // TODO: what is this ? — read the descriptor and ignore it.
                    let _desc = crate::descriptor::read_version_and_descriptor(reader)?;
                }
                other => {
                    return Err(ReadError::StrictViolation(format!(
                        "Invalid brush type: {}",
                        other
                    )));
                }
            }

            // align to 4 bytes
            while size % 4 != 0 {
                reader.offset += 1;
                size += 1;
            }
        }
    } else {
        return Err(ReadError::StrictViolation(format!(
            "Unsupported ABR version ({})",
            version
        )));
    }

    Ok(Abr {
        samples,
        patterns,
        brushes,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn abr_rejects_v1() {
        let bytes = [0u8, 1u8];
        assert!(read_abr(&bytes, &ReadAbrOptions::default()).is_err());
    }

    #[test]
    fn abr_rejects_unknown_version() {
        let bytes = [0u8, 99u8];
        assert!(read_abr(&bytes, &ReadAbrOptions::default()).is_err());
    }
}
