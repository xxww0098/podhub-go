use super::*;
use serde_json::json;

const FIVE: &str = "#горы #озеро #закат #сосны #отражение";

fn completion(content: &str) -> Value {
    json!({ "choices": [{ "message": { "role": "assistant", "content": content } }] })
}

#[test]
fn search_tags_match_the_required_form_before_accept() {
    let punctuated = "#горы, #озеро, #закат, #сосны, #отражение.";
    let parsed = parse_completion(&completion(&format!(
        r#"{{"ru":"Чехол","tags":"{punctuated}","desc":"Сюжет."}}"#
    )))
    .unwrap();
    assert_eq!(parsed.tags.join(" "), FIVE);
    let hyphen = "#чёрно-белый #озеро #закат #сосны #отражение";
    let parsed = parse_completion(&completion(&format!(
        r#"{{"ru":"Чехол","tags":"{hyphen}","desc":"Сюжет."}}"#
    )))
    .unwrap();
    assert_eq!(parsed.tags[0], "#чёрно_белый");
    let bare = "горы озеро закат сосны отражение";
    let parsed = parse_completion(&completion(&format!(
        r#"{{"ru":"Чехол","tags":"{bare}","desc":"Сюжет."}}"#
    )))
    .unwrap();
    assert_eq!(parsed.tags.join(" "), FIVE);

    let short = parse_completion(&completion(
        r##"{"ru":"Чехол","tags":"#горы #озеро","desc":"Сюжет."}"##,
    ))
    .unwrap_err();
    assert!(short.tag_format());
    assert_eq!(short.retry_class(), RetryClass::Corrective);
    let extra = "#горы #озеро #закат #сосны #отражение #лишний";
    let extra = parse_completion(&completion(&format!(
        r#"{{"ru":"Чехол","tags":"{extra}","desc":"Сюжет."}}"#
    )))
    .unwrap_err();
    assert!(extra.tag_format());
    assert_eq!(extra.retry_class(), RetryClass::Corrective);
}

#[test]
fn latin_in_a_russian_title_is_allowed_and_latin_in_a_tag_is_not() {
    assert!(!contains_han("Чехол iPhone 17 Pro Max, 40х50"));
    let ok = format!(r#"{{"ru":"Чехол iPhone 17 Pro Max","tags":"{FIVE}","desc":"Сюжет."}}"#);
    assert!(parse_completion(&completion(&ok)).is_ok());
    let latin_tag = FIVE.replacen("#горы", "#iPhone", 1);
    let refused = format!(r#"{{"ru":"Чехол","tags":"{latin_tag}","desc":"Сюжет."}}"#);
    assert_eq!(
        parse_completion(&completion(&refused)),
        Err(OcrContractViolation::ConfiguredTags(
            "每个标签须为不超过 30 字符的俄语词或下划线标签"
        ))
    );
}

#[test]
fn han_is_refused_and_an_empty_answer_is_not_json() {
    assert!(contains_han("画"));
    assert!(!contains_han("Ёж"));
    assert_eq!(
        parse_completion(&completion("не json")),
        Err(OcrContractViolation::NotJson)
    );
}

#[test]
fn han_in_each_field_is_refused_and_allows_one_text_correction() {
    let tags: Vec<String> = FIVE.split_whitespace().map(str::to_owned).collect();
    for (ru, desc, mut candidate_tags, field) in [
        ("Картина 山", "Сюжет.", tags.clone(), "俄语标题"),
        ("Картина", "Сюжет 山.", tags.clone(), "商品描述"),
        ("Картина", "Сюжет.", tags.clone(), "商品标签"),
    ] {
        if field == "商品标签" {
            candidate_tags[0] = "#山".into();
        }
        let body = json!({"ru": ru, "tags": candidate_tags, "desc": desc});
        let error = parse_completion(&completion(&body.to_string())).unwrap_err();
        assert_eq!(error, OcrContractViolation::Han(field));
        assert_eq!(error.retry_class(), RetryClass::Corrective);
    }
}

#[test]
fn answer_fields_fold_title_description_and_both_tag_shapes_before_validation() {
    let tag_list = vec![" #гopы ", "#озеро", "#закат", "#сосны", "#отражение"];
    for tags in [json!(tag_list), json!(tag_list.join(" "))] {
        let body = json!({
            "ru": " Чeхол кипaрис iPhone ",
            "desc": " Вид oзepa. ",
            "tags": tags,
            "candidates": [{"value": "кипaрис"}],
        });
        let original = completion(&body.to_string());
        let parsed = parse_completion(&original).unwrap();
        assert_eq!(parsed.ru, "Чехол кипарис iPhone");
        assert_eq!(parsed.desc, "Вид озера.");
        assert_eq!(parsed.tags.join(" "), FIVE);
        assert_eq!(
            parsed.candidates,
            body["candidates"].as_array().unwrap().clone()
        );
        assert_eq!(
            answer_fields(&original),
            Some((parsed.ru, parsed.tags, parsed.desc))
        );
    }
}

#[test]
fn completed_lookalikes_are_accepted_without_a_retry() {
    let ru = format!(
        "Чехол {} {} {} iPh{}ne",
        format!("r{}", "\u{043e}\u{0440}\u{044b}"),
        format!("\u{043a}\u{043e}w\u{043a}\u{0430}"),
        format!("\u{0434}\u{0435}\u{043d}b"),
        '\u{043e}'
    );
    let parsed = parse_completion(&completion(&format!(
        r#"{{"ru":"{ru}","tags":"{FIVE}","desc":"Сюжет."}}"#
    )))
    .unwrap();
    assert_eq!(parsed.ru, "Чехол горы кошка денЬ iPhone");
    let poster = format!("Чехол Post{}r", '\u{0435}');
    let parsed = parse_completion(&completion(&format!(
        r#"{{"ru":"{poster}","tags":"{FIVE}","desc":"Сюжет."}}"#
    )))
    .unwrap();
    assert_eq!(parsed.ru, "Чехол Poster");
}

#[test]
fn remaining_mixed_script_is_corrective_in_every_field() {
    let tags: Vec<String> = FIVE.split_whitespace().map(str::to_owned).collect();
    for (ru, desc, mut candidate_tags, field) in [
        ("Чехол кипiрис", "Сюжет.", tags.clone(), "俄语标题"),
        ("Чехол", "Сюжет кипiрис.", tags.clone(), "商品描述"),
        ("Чехол", "Сюжет.", tags.clone(), "商品标签"),
    ] {
        if field == "商品标签" {
            candidate_tags[0] = "#cipресс".into();
        }
        let body = json!({"ru": ru, "tags": candidate_tags, "desc": desc});
        let completion = completion(&body.to_string());
        let error = parse_completion(&completion).unwrap_err();
        assert_eq!(error, OcrContractViolation::MixedScript(field));
        assert_eq!(error.reason_code(), "mixed_script");
        assert_eq!(error.retry_class(), RetryClass::Corrective);
        let (ru, tags, desc) = answer_fields(&completion).unwrap();
        assert_eq!(check(&ru, &tags, &desc), Err(error));
    }
}

#[test]
fn retry_classes_serialize_as_stable_machine_tokens() {
    for (error, reason, class) in [
        (OcrContractViolation::Han("俄语标题"), "han", "corrective"),
        (
            OcrContractViolation::MixedScript("商品描述"),
            "mixed_script",
            "corrective",
        ),
        (
            OcrContractViolation::ConfiguredTags("必须恰好 5 个"),
            "configured_tags",
            "corrective",
        ),
        (OcrContractViolation::NoText, "no_text", "blind"),
        (OcrContractViolation::NotJson, "not_json", "blind"),
        (OcrContractViolation::Empty("俄语标题"), "empty", "blind"),
        (
            OcrContractViolation::TitleTooLong,
            "title_too_long",
            "blind",
        ),
    ] {
        assert_eq!(error.reason_code(), reason);
        assert_eq!(
            serde_json::to_value(error.retry_class()).unwrap(),
            json!(class)
        );
    }
}

#[test]
fn returned_completion_folds_the_same_as_parse_and_is_idempotent() {
    let body = json!({
        "ru": "Чeхол кипaрис",
        "tags": FIVE.replace("#горы", "#гopы"),
        "desc": "Вид oзepa.",
        "candidates": [{"value": "кипaрис"}],
    })
    .to_string();
    for message in [
        json!({"content": body}),
        json!({"content": [{"type": "text", "text": body}]}),
        json!({"content": "", "reasoning_content": body}),
    ] {
        let mut returned = json!({"choices": [{"message": message}]});
        let stored = returned.clone();
        assert!(fold_completion(&mut returned));
        assert!(returned["choices"][0]["message"]["content"].is_string());
        assert_eq!(parse_completion(&returned), parse_completion(&stored));
        let once = returned.clone();
        assert!(!fold_completion(&mut returned));
        assert_eq!(returned, once);
    }
    for mut returned in [json!({}), completion("not json"), completion("[]")] {
        let original = returned.clone();
        assert!(!fold_completion(&mut returned));
        assert_eq!(returned, original);
    }
}
