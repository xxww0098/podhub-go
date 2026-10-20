//! Typed coordinator failures; JS conversion happens only at the bindgen seam.
#![forbid(unsafe_code)]
#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub(super) enum RuntimeError {
    #[error("RENDER_RUNTIME_CONFIG")]
    Config,
    #[error("RENDER_IDS_EXHAUSTED")]
    IdsExhausted,
    #[error("RENDER_CANCELLED")]
    Cancelled,
    #[error("RENDER_QUEUE_FULL")]
    QueueFull,
    #[error("RENDER_RUNTIME_CLOSED")]
    Closed,
    #[error("RENDER_LEASE_EXPIRED")]
    LeaseExpired,
    #[error("RENDER_LEASE_BUSY")]
    LeaseBusy,
    #[error("RENDER_TEMPLATE_MISSING")]
    TemplateMissing,
    #[error("RENDER_TEMPLATE_FINGERPRINT")]
    TemplateFingerprint,
    #[error("{0}")]
    Compute(String),
}

#[cfg(feature = "threads")]
pub(super) fn js_error(error: impl std::fmt::Display) -> wasm_bindgen::JsValue {
    wasm_bindgen::JsValue::from_str(&error.to_string())
}

/// JS counters must be whole, exactly representable byte counts, not a
/// saturating float-to-integer cast that silently accepts Infinity/fractions.
pub(super) fn byte_count(value: f64) -> Result<u64, RuntimeError> {
    const MAX_SAFE_INTEGER: f64 = 9_007_199_254_740_991.0;
    if !value.is_finite() || !(0.0..=MAX_SAFE_INTEGER).contains(&value) || value.fract() != 0.0 {
        return Err(RuntimeError::Config);
    }
    Ok(value as u64)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn byte_counts_reject_nonfinite_negative_fractional_and_lossy_values() {
        for value in [f64::NAN, f64::INFINITY, -1.0, 0.5, 9_007_199_254_740_992.0] {
            assert_eq!(byte_count(value).unwrap_err(), RuntimeError::Config);
        }
        assert_eq!(byte_count(0.0).unwrap(), 0);
        assert_eq!(byte_count(1024.0).unwrap(), 1024);
    }
}
