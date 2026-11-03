//! Op 17 validates visual copy or previews a title with immutable product facts.
use crate::error::CoreError;
use listing_core::ocr_contract::{self, ProductProfile};
use serde::Deserialize;
use serde_json::{Value, json};
pub(crate) const OP_PARSE_OCR_ANSWER: u32 = 17;
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct CompletionInput {
    profile: ProductProfile,
    fixed_tags: Vec<String>,
    completion: Value,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct PreviewInput {
    profile: ProductProfile,
    fixed_tags: Vec<String>,
    preview_theme: String,
}
#[derive(Deserialize)]
#[serde(untagged)]
enum Input {
    Completion(CompletionInput),
    Preview(PreviewInput),
}
pub(crate) fn parse_answer(bytes: &[u8]) -> Result<Vec<u8>, CoreError> {
    let input: Input = serde_json::from_slice(bytes).map_err(CoreError::decode)?;
    let answer = match input {
        Input::Completion(input) => {
            ocr_contract::parse_completion(&input.profile, &input.fixed_tags, &input.completion)
        }
        Input::Preview(input) => {
            ocr_contract::preview(&input.profile, &input.fixed_tags, &input.preview_theme)
        }
    }
    .map_err(CoreError::ocr_refused)?;
    serde_json::to_vec(&json!({"ru":answer.ru,"tags":answer.tags,"description":answer.desc,"candidates":answer.candidates})).map_err(CoreError::decode)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn envelope_and_permanent_refusal() {
        let scene = "На рисунке кот сидит рядом с чашкой на столе. На заднем плане видны листья и цветы в тёплых тонах.";
        let copy = json!({"state":"clear","theme_ru":"Кот с чашкой","description_ru":scene,"tags":["#кот","#чашка","#цветы","#листья","#тёплые_тона"]});
        let mut input = json!({"profile":{"product_type_ru":"Кружка","facts_ru":"330 мл"},"fixed_tags":["#кружка"],"completion":{"choices":[{"message":{"content":copy.to_string()}}]}});
        let output: Value = serde_json::from_slice(
            &parse_answer(&serde_json::to_vec(&input).unwrap())
                .unwrap_or_else(|e| panic!("{}", String::from_utf8_lossy(&e.to_json_bytes()))),
        )
        .unwrap();
        assert_eq!(output["ru"], "Кружка 330 мл \"Кот с чашкой\"");
        assert_eq!(output["description"], format!("Кружка 330 мл. {scene}"));
        assert_eq!(output["tags"].as_array().unwrap().len(), 5);
        input["completion"]["choices"][0]["message"]["content"] =
            json!({"state":"unclear","theme_ru":"","description_ru":"","tags":[]})
                .to_string()
                .into();
        let err = parse_answer(&serde_json::to_vec(&input).unwrap())
            .err()
            .unwrap();
        let err: Value = serde_json::from_slice(&err.to_json_bytes()).unwrap();
        assert_eq!(err["retry_class"], "permanent");
        assert_eq!(err["reason_code"], "unclear_image");
    }

    #[test]
    fn formula_preview_does_not_fabricate_visual_copy() {
        let input = json!({"profile":{"product_type_ru":"Кружка","facts_ru":"330 мл"},"fixed_tags":["#кружка"],"preview_theme":"Кот с чашкой"});
        let output: Value = serde_json::from_slice(
            &parse_answer(&serde_json::to_vec(&input).unwrap())
                .unwrap_or_else(|e| panic!("{}", String::from_utf8_lossy(&e.to_json_bytes()))),
        )
        .unwrap();
        assert_eq!(output["ru"], "Кружка 330 мл \"Кот с чашкой\"");
        assert_eq!(output["tags"], json!([]));
        let mut ambiguous = input;
        ambiguous["completion"] = json!({});
        assert!(parse_answer(&serde_json::to_vec(&ambiguous).unwrap()).is_err());
    }
}
