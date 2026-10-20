/*
File: rust/crates/psd-x/src/text_edit/style.rs

Purpose:
Whole-layer text style setters: write base style and
clear the same field on every style run so base⊕run encoding cannot leave
stale per-run overrides. Effective-style query matches that merge rule.
No upstream counterpart.

Source compatibility:
- no-upstream-counterpart
*/

use super::{TextEditError, TextLayer, layer_at_path};
use crate::psd::{Color, Font, LayerTextData, TextStyle};
use crate::text::merge_style;

impl TextLayer<'_> {
    /// Number of style runs in the effective-run view.
    ///
    /// When `style_runs` is missing, the whole string is one run (the base
    /// style). Empty lists remain observable in read-only/no-op sessions and
    /// are normalized only in a successfully prepared mutation.
    pub fn style_run_count(&self) -> Result<usize, TextEditError> {
        let text = self.text_data()?;
        Ok(effective_run_count(text))
    }

    /// Base⊕run merged style for `run_index` (run wins). Matches the values
    /// that survive write→reread for fields present on the model.
    pub fn effective_style(&self, run_index: usize) -> Result<TextStyle, TextEditError> {
        let text = self.text_data()?;
        effective_style_at(text, run_index)
    }

    /// Set the layer font: write base style and clear `font` on every run.
    ///
    /// No-op (byte-identical) when every run's effective font already equals
    /// `font`.
    pub fn set_font(&mut self, font: Font) -> Result<(), TextEditError> {
        if all_effective_fonts_eq(self.text_data()?, &font) {
            return Ok(());
        }
        let mut prepared = self.prepare_style_mutation()?;
        {
            let text = prepared.text_mut();
            let base = text.style.get_or_insert_with(TextStyle::default);
            base.font = Some(font);
            clear_run_field(text, |s| s.font = None);
        }
        prepared.apply(self)
    }

    /// Set the layer font size: write base and clear `font_size` on every run.
    pub fn set_font_size(&mut self, size: f64) -> Result<(), TextEditError> {
        if all_effective_font_sizes_eq(self.text_data()?, size) {
            return Ok(());
        }
        let mut prepared = self.prepare_style_mutation()?;
        {
            let text = prepared.text_mut();
            let base = text.style.get_or_insert_with(TextStyle::default);
            base.font_size = Some(size);
            clear_run_field(text, |s| s.font_size = None);
        }
        prepared.apply(self)
    }

    /// Set the layer fill color: write base and clear `fill_color` on every run.
    ///
    /// Rejects color kinds that EngineData encode would silently degrade to
    /// transparent black (FRGB / HSB / LAB).
    pub fn set_fill_color(&mut self, color: Color) -> Result<(), TextEditError> {
        if !is_supported_text_color(color) {
            return Err(TextEditError::UnsupportedTextColor);
        }
        if all_effective_fill_colors_eq(self.text_data()?, &color) {
            return Ok(());
        }
        let mut prepared = self.prepare_style_mutation()?;
        {
            let text = prepared.text_mut();
            let base = text.style.get_or_insert_with(TextStyle::default);
            base.fill_color = Some(color);
            clear_run_field(text, |s| s.fill_color = None);
        }
        prepared.apply(self)
    }
}

impl TextLayer<'_> {
    fn text_data(&self) -> Result<&LayerTextData, TextEditError> {
        let layer = layer_at_path(self.psd, &self.path).ok_or(TextEditError::LayerNotFound)?;
        layer
            .additional_info
            .text
            .as_ref()
            .ok_or(TextEditError::NotATextLayer)
    }
}

/// Colors EngineData can encode without silent transparent-black fallback.
pub(super) fn is_supported_text_color(color: Color) -> bool {
    matches!(
        color,
        Color::Rgb(_) | Color::Rgba(_) | Color::Cmyk(_) | Color::Grayscale(_)
    )
}

fn effective_run_count(text: &LayerTextData) -> usize {
    match text.style_runs.as_deref() {
        Some(runs) if !runs.is_empty() => runs.len(),
        Some(_) | None => 1,
    }
}

fn effective_style_at(text: &LayerTextData, run_index: usize) -> Result<TextStyle, TextEditError> {
    let base = text.style.clone().unwrap_or_default();
    match text.style_runs.as_deref() {
        None | Some([]) => {
            if run_index != 0 {
                return Err(TextEditError::StyleRunOutOfBounds {
                    index: run_index,
                    count: 1,
                });
            }
            Ok(base)
        }
        Some(runs) => {
            let run = runs
                .get(run_index)
                .ok_or(TextEditError::StyleRunOutOfBounds {
                    index: run_index,
                    count: runs.len(),
                })?;
            Ok(merge_style(&base, &run.style))
        }
    }
}

fn clear_run_field(text: &mut LayerTextData, clear: impl Fn(&mut TextStyle)) {
    if let Some(runs) = text.style_runs.as_mut() {
        for run in runs.iter_mut() {
            clear(&mut run.style);
        }
    }
}

fn fonts_eq(a: &Font, b: &Font) -> bool {
    a.name == b.name
        && a.script == b.script
        && a.font_type == b.font_type
        && a.synthetic == b.synthetic
}

fn all_effective_fonts_eq(text: &LayerTextData, font: &Font) -> bool {
    let n = effective_run_count(text);
    (0..n).all(|i| {
        effective_style_at(text, i)
            .ok()
            .and_then(|s| s.font)
            .is_some_and(|f| fonts_eq(&f, font))
    })
}

fn all_effective_font_sizes_eq(text: &LayerTextData, size: f64) -> bool {
    let n = effective_run_count(text);
    (0..n).all(|i| {
        effective_style_at(text, i)
            .ok()
            .and_then(|s| s.font_size)
            .is_some_and(|s| s == size)
    })
}

fn all_effective_fill_colors_eq(text: &LayerTextData, color: &Color) -> bool {
    let n = effective_run_count(text);
    (0..n).all(|i| {
        effective_style_at(text, i)
            .ok()
            .and_then(|s| s.fill_color)
            .is_some_and(|c| c == *color)
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::psd::{ColorMode, Layer, Psd, Rgb, TextShapeType, TextStyleRun};
    use crate::text_edit::{FontResolution, RasterPolicy, TextEdit};

    fn multi_run_psd() -> Psd {
        let mut layer = Layer::default();
        layer.additional_info.name = Some("T".into());
        layer.additional_info.text = Some(LayerTextData {
            text: "abcdef".into(),
            shape_type: Some(TextShapeType::Box),
            style: Some(TextStyle {
                font: Some(Font {
                    name: "BaseFont".into(),
                    script: Some(0.0),
                    font_type: Some(0.0),
                    synthetic: Some(0.0),
                }),
                font_size: Some(12.0),
                fill_color: Some(Color::Rgb(Rgb {
                    r: 0.0,
                    g: 0.0,
                    b: 0.0,
                })),
                ..Default::default()
            }),
            style_runs: Some(vec![
                TextStyleRun {
                    length: 3.0,
                    style: TextStyle {
                        font: Some(Font {
                            name: "RunFontA".into(),
                            script: Some(0.0),
                            font_type: Some(0.0),
                            synthetic: Some(0.0),
                        }),
                        font_size: Some(20.0),
                        fill_color: Some(Color::Rgb(Rgb {
                            r: 255.0,
                            g: 0.0,
                            b: 0.0,
                        })),
                        ..Default::default()
                    },
                },
                TextStyleRun {
                    length: 3.0,
                    style: TextStyle {
                        font: Some(Font {
                            name: "RunFontB".into(),
                            script: Some(0.0),
                            font_type: Some(0.0),
                            synthetic: Some(0.0),
                        }),
                        font_size: Some(30.0),
                        fill_color: Some(Color::Rgb(Rgb {
                            r: 0.0,
                            g: 0.0,
                            b: 255.0,
                        })),
                        ..Default::default()
                    },
                },
            ]),
            ..Default::default()
        });
        Psd {
            width: 20.0,
            height: 10.0,
            color_mode: Some(ColorMode::Rgb),
            children: Some(vec![layer]),
            ..Default::default()
        }
    }

    #[test]
    fn set_font_writes_base_and_clears_run_fonts() {
        let mut psd = multi_run_psd();
        {
            let mut session =
                TextEdit::begin(&mut psd, RasterPolicy::Leave, FontResolution::Resolved).unwrap();
            let mut layer = session.layer_at(&[0]).unwrap();
            layer
                .set_font(Font {
                    name: "NewFont".into(),
                    script: Some(0.0),
                    font_type: Some(0.0),
                    synthetic: Some(0.0),
                })
                .unwrap();
            assert_eq!(layer.style_run_count().unwrap(), 2);
            for i in 0..2 {
                assert_eq!(
                    layer.effective_style(i).unwrap().font.unwrap().name,
                    "NewFont"
                );
            }
            let _ = session.finish();
        }
        let text = psd.children.as_ref().unwrap()[0]
            .additional_info
            .text
            .as_ref()
            .unwrap();
        assert_eq!(
            text.style.as_ref().unwrap().font.as_ref().unwrap().name,
            "NewFont"
        );
        for run in text.style_runs.as_ref().unwrap() {
            assert!(run.style.font.is_none());
        }
    }

    #[test]
    fn unsupported_color_rejected() {
        let mut psd = multi_run_psd();
        let mut session =
            TextEdit::begin(&mut psd, RasterPolicy::Leave, FontResolution::Resolved).unwrap();
        let err = session
            .layer_at(&[0])
            .unwrap()
            .set_fill_color(Color::Lab(crate::psd::Lab {
                l: 50.0,
                a: 0.0,
                b: 0.0,
            }))
            .unwrap_err();
        assert_eq!(err, TextEditError::UnsupportedTextColor);
    }

    #[test]
    fn set_font_noop_when_already_effective() {
        let mut psd = multi_run_psd();
        // Collapse to one effective font first.
        {
            let mut session =
                TextEdit::begin(&mut psd, RasterPolicy::Leave, FontResolution::Resolved).unwrap();
            session
                .layer_at(&[0])
                .unwrap()
                .set_font(Font {
                    name: "Same".into(),
                    script: Some(0.0),
                    font_type: Some(0.0),
                    synthetic: Some(0.0),
                })
                .unwrap();
            let _ = session.finish();
        }
        psd.additional_info.engine_data = Some("AAAA".into());
        {
            let mut session =
                TextEdit::begin(&mut psd, RasterPolicy::Leave, FontResolution::Resolved).unwrap();
            session
                .layer_at(&[0])
                .unwrap()
                .set_font(Font {
                    name: "Same".into(),
                    script: Some(0.0),
                    font_type: Some(0.0),
                    synthetic: Some(0.0),
                })
                .unwrap();
            let report = session.finish();
            assert_eq!(report.mutations, 0);
            assert!(!report.doc_text_blob_dropped);
        }
        assert!(psd.additional_info.engine_data.is_some());
    }

    #[test]
    fn supported_color_predicate() {
        assert!(is_supported_text_color(Color::Rgb(Rgb {
            r: 1.0,
            g: 2.0,
            b: 3.0
        })));
        assert!(!is_supported_text_color(Color::Hsb(crate::psd::Hsb {
            h: 0.0,
            s: 0.0,
            b: 0.0
        })));
        assert!(!is_supported_text_color(Color::Frgb(crate::psd::Frgb {
            fr: 0.0,
            fg: 0.0,
            fb: 0.0
        })));
    }
}
