//! Codec unit tests — BlendMode strings + Color flat-object probe order.

#![cfg(feature = "serde")]

use psdx::psd::{BLEND_MODE_JSON, BlendMode, Cmyk, Color, Frgb, Grayscale, Hsb, Lab, Rgb, Rgba};

#[test]
fn blend_mode_json_round_trips_all_31() {
    assert_eq!(BLEND_MODE_JSON.len(), 31);
    for &(name, mode) in BLEND_MODE_JSON {
        let json = serde_json::to_string(&mode).unwrap();
        assert_eq!(json, format!("\"{name}\""));
        let back: BlendMode = serde_json::from_str(&json).unwrap();
        assert_eq!(back, mode);
    }
}

#[test]
fn blend_mode_includes_abr_variants() {
    assert_eq!(
        BlendMode::from_json_str("linear height"),
        Some(BlendMode::LinearHeight)
    );
    assert_eq!(BlendMode::from_json_str("height"), Some(BlendMode::Height));
    assert_eq!(
        BlendMode::from_json_str("subtraction"),
        Some(BlendMode::Subtraction)
    );
    assert_ne!(
        BlendMode::from_json_str("subtract"),
        BlendMode::from_json_str("subtraction")
    );
}

#[test]
fn color_rgba_vs_rgb_distinguished_by_a_key() {
    let rgba: Color = serde_json::from_str(r#"{"r":1,"g":2,"b":3,"a":4}"#).unwrap();
    assert_eq!(
        rgba,
        Color::Rgba(Rgba {
            r: 1.0,
            g: 2.0,
            b: 3.0,
            a: 4.0
        })
    );
    let rgb: Color = serde_json::from_str(r#"{"r":1,"g":2,"b":3}"#).unwrap();
    assert_eq!(
        rgb,
        Color::Rgb(Rgb {
            r: 1.0,
            g: 2.0,
            b: 3.0
        })
    );
    // Untagged would wrongly pick RGB and drop alpha — serialized form must keep `a`.
    let out = serde_json::to_value(&rgba).unwrap();
    assert_eq!(out["a"], 4.0);
}

#[test]
fn color_probe_order_fr_h_c_l_k() {
    assert_eq!(
        serde_json::from_str::<Color>(r#"{"fr":0.1,"fg":0.2,"fb":0.3}"#).unwrap(),
        Color::Frgb(Frgb {
            fr: 0.1,
            fg: 0.2,
            fb: 0.3
        })
    );
    assert_eq!(
        serde_json::from_str::<Color>(r#"{"h":0.1,"s":0.2,"b":0.3}"#).unwrap(),
        Color::Hsb(Hsb {
            h: 0.1,
            s: 0.2,
            b: 0.3
        })
    );
    assert_eq!(
        serde_json::from_str::<Color>(r#"{"c":1,"m":2,"y":3,"k":4}"#).unwrap(),
        Color::Cmyk(Cmyk {
            c: 1.0,
            m: 2.0,
            y: 3.0,
            k: 4.0
        })
    );
    assert_eq!(
        serde_json::from_str::<Color>(r#"{"l":0.5,"a":-0.1,"b":0.2}"#).unwrap(),
        Color::Lab(Lab {
            l: 0.5,
            a: -0.1,
            b: 0.2
        })
    );
    assert_eq!(
        serde_json::from_str::<Color>(r#"{"k":128}"#).unwrap(),
        Color::Grayscale(Grayscale { k: 128.0 })
    );
}
