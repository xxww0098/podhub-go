//! The `call()` error contract (slice 03 "契约与缝"): every failure is
//! `{"code": ..., "message": ...}`, written to the `last_error_*` buffer.
//! OCR refusals also carry the contract's `reason_code` and `retry_class`.

use listing_core::ocr_contract::OcrContractViolation;

/// One of the three codes slice 03 pins: `CORE_DECODE` (the call's JSON body
/// did not decode into the op's input shape), `CORE_SCHEMA_HANDLE` (`h` names
/// no resident schema — unknown or already `schema_drop`ped), `CORE_REFUSED`
/// (the op itself said no — a `listing_core::ops` business-rule error).
pub(crate) struct CoreError {
    code: &'static str,
    message: String,
    ocr_violation: Option<OcrContractViolation>,
}

impl CoreError {
    pub(crate) fn decode(error: impl std::fmt::Display) -> Self {
        Self {
            code: "CORE_DECODE",
            message: error.to_string(),
            ocr_violation: None,
        }
    }

    pub(crate) fn schema_handle(message: impl Into<String>) -> Self {
        Self {
            code: "CORE_SCHEMA_HANDLE",
            message: message.into(),
            ocr_violation: None,
        }
    }

    pub(crate) fn refused(message: impl Into<String>) -> Self {
        Self {
            code: "CORE_REFUSED",
            message: message.into(),
            ocr_violation: None,
        }
    }

    pub(crate) fn ocr_refused(error: OcrContractViolation) -> Self {
        Self {
            code: "CORE_REFUSED",
            message: error.to_string(),
            ocr_violation: Some(error),
        }
    }

    /// The bytes `call()` hands `last_error_ptr`/`last_error_len`. Falls back
    /// to a fixed, always-valid message on the (unreachable in practice)
    /// case that `serde_json` itself cannot encode two strings.
    pub(crate) fn to_json_bytes(&self) -> Vec<u8> {
        let mut value = serde_json::json!({"code": self.code, "message": self.message});
        if let Some(error) = &self.ocr_violation {
            value["reason_code"] = error.reason_code().into();
            value["retry_class"] = serde_json::json!(error.retry_class());
        }
        serde_json::to_vec(&value).unwrap_or_else(|_| {
            br#"{"code":"CORE_DECODE","message":"error message failed to encode"}"#.to_vec()
        })
    }
}
