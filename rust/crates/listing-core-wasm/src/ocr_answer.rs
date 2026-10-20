//! Op 17. Parses one settled OCR completion with `listing_core::ocr_contract`.
//!
//! No provider call, no quota, no row write. A contract refusal is
//! `CORE_REFUSED` carrying the operator sentence, reason code and retry class.

use listing_core::ocr_contract;
use serde_json::{Value as JsonValue, json};

use crate::error::CoreError;

pub(crate) const OP_PARSE_OCR_ANSWER: u32 = 17;

pub(crate) fn parse_answer(bytes: &[u8]) -> Result<Vec<u8>, CoreError> {
    let completion: JsonValue = serde_json::from_slice(bytes).map_err(CoreError::decode)?;
    let answer = ocr_contract::parse_completion(&completion).map_err(CoreError::ocr_refused)?;
    serde_json::to_vec(&json!({
        "ru": answer.ru,
        "tags": answer.tags,
        "description": answer.desc,
        "candidates": answer.candidates,
    }))
    .map_err(CoreError::decode)
}

#[cfg(test)]
mod tests {
    use super::*;

    const FIVE: &str = "#горы #озеро #закат #сосны #отражение";

    fn completion(content: &str) -> Vec<u8> {
        serde_json::to_vec(&json!({"choices": [{"message": {"content": content}}]})).unwrap()
    }

    fn refusal(content: &str) -> JsonValue {
        let Err(error) = parse_answer(&completion(content)) else {
            panic!("the answer must be refused");
        };
        serde_json::from_slice(&error.to_json_bytes()).unwrap()
    }

    #[test]
    fn success_returns_folded_fields_and_preserves_candidates() {
        let tags = FIVE.replace("#горы", "#гopы");
        let input = json!({
            "ru": "Чехол кипaрис iPhone",
            "desc": "Сюжет кипapис.",
            "tags": tags,
            "candidates": [{"value": "кипaрис"}],
        });
        let output = match parse_answer(&completion(&input.to_string())) {
            Ok(bytes) => serde_json::from_slice::<JsonValue>(&bytes).unwrap(),
            Err(error) => panic!("{}", String::from_utf8_lossy(&error.to_json_bytes())),
        };
        assert_eq!(output["ru"], "Чехол кипарис iPhone");
        assert_eq!(output["description"], "Сюжет кипарис.");
        assert_eq!(output["tags"][0], "#горы");
        assert_eq!(output["candidates"], input["candidates"]);
    }

    #[test]
    fn search_tags_are_canonical_before_accept_and_a_bad_count_retries_once() {
        let input = json!({
            "ru": "Чехол",
            "tags": "#горы, #озеро, #закат, #сосны, #отражение.",
            "desc": "Сюжет.",
        });
        let output = match parse_answer(&completion(&input.to_string())) {
            Ok(bytes) => serde_json::from_slice::<JsonValue>(&bytes).unwrap(),
            Err(error) => panic!("{}", String::from_utf8_lossy(&error.to_json_bytes())),
        };
        assert_eq!(output["tags"][0], "#горы");
        assert_eq!(output["tags"].as_array().unwrap().len(), 5);
        let short = json!({"ru": "Чехол", "tags": "#горы #озеро", "desc": "Сюжет."});
        let error = refusal(&short.to_string());
        assert_eq!(error["reason_code"], "empty");
        assert_eq!(error["retry_class"], "corrective");
    }

    #[test]
    fn refusals_expose_all_retry_classes_from_the_shared_contract() {
        for (ru, tags, reason, retry_class) in [
            ("Картина 山", FIVE, "han", "corrective"),
            ("Чехол кипiрис", FIVE, "mixed_script", "corrective"),
            (
                "Чехол",
                "#iPhone #озеро #закат #сосны #отражение",
                "configured_tags",
                "corrective",
            ),
            ("", FIVE, "empty", "blind"),
        ] {
            let input = json!({"ru": ru, "tags": tags, "desc": "Сюжет."});
            let error = refusal(&input.to_string());
            assert_eq!(error["code"], "CORE_REFUSED");
            assert!(!error["message"].as_str().unwrap().is_empty());
            assert_eq!(error["reason_code"], reason);
            assert_eq!(error["retry_class"], retry_class);
        }
        assert_eq!(refusal("not json")["retry_class"], "blind");
    }

    #[test]
    fn non_ocr_errors_keep_the_existing_error_shape() {
        for error in [
            CoreError::decode("bad json"),
            CoreError::schema_handle("missing schema"),
            CoreError::refused("refused"),
        ] {
            let value: JsonValue = serde_json::from_slice(&error.to_json_bytes()).unwrap();
            assert_eq!(value.as_object().unwrap().len(), 2);
            assert!(value["code"].is_string());
            assert!(value["message"].is_string());
        }
    }
}
