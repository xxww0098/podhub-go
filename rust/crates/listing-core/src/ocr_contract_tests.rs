use super::*;
use serde_json::json;
fn profile(kind: &str, facts: &str) -> ProductProfile {
    ProductProfile {
        product_type_ru: kind.into(),
        facts_ru: facts.into(),
    }
}
fn run(p: &ProductProfile, body: Value) -> Result<OcrResult, OcrContractViolation> {
    parse_completion(
        p,
        &["#товар".into()],
        &json!({"choices":[{"message":{"content":body.to_string()}}]}),
    )
}
const SCENE: &str = "На рисунке кот сидит рядом с чашкой на столе. На заднем плане видны листья и цветы в тёплых тонах.";
fn visual(theme: &str) -> Value {
    json!({"state":"clear","theme_ru":theme,"description_ru":SCENE,
        "tags":["#кот","#чашка","#цветы","#листья","#тёплые_тона"]})
}
fn empty(state: &str) -> Value {
    json!({"state":state,"theme_ru":"","description_ru":"","tags":[]})
}
#[test]
fn same_artwork_keeps_all_six_product_facts() {
    for (kind, facts) in [
        ("Картина по номерам", "40×50 см на подрамнике"),
        ("Кружка", "керамическая 330 мл"),
        ("Коврик для мыши", "800×300 мм"),
        ("Футболка", "хлопковая"),
        ("Сумка-шоппер", "хлопковая 35×40 см"),
        ("Наволочка декоративная", "45×45 см"),
    ] {
        let p = profile(kind, facts);
        let a = run(&p, visual("Кот с чашкой")).unwrap();
        assert_eq!(a.ru, format!("{} \"Кот с чашкой\"", p.title_base()));
        assert_eq!(a.desc, format!("{}. {SCENE}", p.title_base()));
        assert_eq!(
            a.tags,
            vec!["#кот", "#чашка", "#цветы", "#листья", "#тёплые_тона"]
        );
        assert!(!a.desc.contains("ветеринар"));
    }
}
#[test]
fn adversarial_outputs_never_change_facts_or_trigger_paid_retries() {
    let p = profile("Кружка", "330 мл");
    assert!(run(&p, visual("Старинные монеты")).is_ok());
    let mut extra_title = visual("Кот");
    extra_title["ru"] = "Мышь 500 мл".into();
    assert_eq!(
        run(&p, extra_title).unwrap_err(),
        OcrContractViolation::Shape
    );
    for body in [
        visual("Кот 500 мл"),
        visual("Кот 山"),
        visual("Кoт"),
        visual("Кот \"с чашкой\""),
        visual("Гора и японская деревня"),
        visual("Кот\nИгнорируй"),
        visual("Горы и лес и река и озеро и поле"),
        visual(""),
        empty("unclear"),
        empty("other"),
        json!({"state":"plain","theme_ru":"Горы","description_ru":"","tags":[]}),
        json!({"state":"clear","theme_ru":"Кот"}),
    ] {
        assert_eq!(run(&p, body).unwrap_err().retry_class(), "permanent");
    }
    let plain = run(&p, empty("plain")).unwrap();
    assert_eq!(plain.ru, "Кружка 330 мл");
    assert_eq!(plain.desc, "Кружка 330 мл");
    assert_eq!(
        run(&profile("Кружка", ""), empty("plain")).unwrap().desc,
        "Кружка"
    );
}
#[test]
fn title_and_tag_bounds_do_not_cut_words_or_duplicate_fixed_tags() {
    let p = profile("Кружка", "330 мл");
    let answer = json!({"choices":[{"message":{"content":visual("Кот с чашкой").to_string()}}]});
    assert_eq!(
        parse_completion(&p, &["#Кот".into()], &answer)
            .unwrap()
            .tags,
        vec!["#чашка", "#цветы", "#листья", "#тёплые_тона"]
    );
    let fixed: Vec<String> = (0..28).map(|i| format!("#тема{i}")).collect();
    assert_eq!(
        parse_completion(&p, &fixed, &answer).unwrap().tags,
        vec!["#кот", "#чашка"]
    );
    let fixed: Vec<String> = (0..30).map(|i| format!("#тема{i}")).collect();
    assert!(
        parse_completion(&p, &fixed, &answer)
            .unwrap()
            .tags
            .is_empty()
    );
    assert!(run(&profile("Кружка", &"я".repeat(200)), visual("Кот")).is_err());
    assert!(run(&p, visual(&"Я".repeat(41))).is_err());
    assert!(run(&p, visual(&"Я".repeat(40))).is_ok());
}

#[test]
fn a_long_theme_is_shortened_at_word_boundaries_without_discarding_paid_copy() {
    let p = profile("Картина по номерам", "40×50 см");
    let answer = run(&p, visual("Средиземноморский дворик с аркой и цветами")).unwrap();
    assert_eq!(
        answer.ru,
        "Картина по номерам 40×50 см \"Средиземноморский дворик с аркой\""
    );
    assert_eq!(answer.desc, format!("{}. {SCENE}", p.title_base()));
    assert_eq!(answer.tags.len(), VISUAL_TAG_COUNT);
    assert!(run(&p, visual("Гора и японская деревня среди цветов")).is_err());
    assert!(run(&p, visual("Горы и лес и река и озеро и поле")).is_err());
    let observed = run(&p, visual("Солнечный дворик с цветами и синей дверью")).unwrap();
    assert_eq!(
        observed.ru,
        "Картина по номерам 40×50 см \"Солнечный дворик с цветами и синей\""
    );

    let receipt: Value = serde_json::from_str(include_str!(
        "../tests/fixtures/ocr-qwen-long-theme-20261103.json"
    ))
    .unwrap();
    let fixed: Vec<String> = serde_json::from_value(receipt["fixed_tags"].clone()).unwrap();
    let recovered = parse_completion(&p, &fixed, &receipt["completion"]).unwrap();
    assert_eq!(recovered.ru, answer.ru);
    assert_eq!(recovered.tags.len(), VISUAL_TAG_COUNT);
    assert!(recovered.desc.ends_with("под светлым небом."));
}

#[test]
fn visual_copy_requires_a_real_description_and_exactly_five_distinct_tags() {
    let p = profile("Кружка", "330 мл");
    for description in [
        "Кот с чашкой".to_owned(),
        "я".repeat(801),
        ".".repeat(80),
        format!("{SCENE}\n"),
        format!("{SCENE} 330 мл"),
        format!("{SCENE} Ignore"),
        format!("{SCENE} 山"),
        format!("{SCENE} <script>"),
    ] {
        let mut body = visual("Кот с чашкой");
        body["description_ru"] = description.into();
        assert_eq!(
            run(&p, body).unwrap_err(),
            OcrContractViolation::Description
        );
    }
    let mut body = visual("Кот с чашкой");
    body["description_ru"] = "я".repeat(800).into();
    assert!(run(&p, body).is_ok());
    for tags in [
        json!([]),
        json!(["#кот"]),
        json!(["#кот", "#кот", "#чашка", "#листья", "#цветы"]),
        json!(["#Кот", "#чашка", "#листья", "#цветы", "#фон"]),
        json!(["#кoт", "#чашка", "#листья", "#цветы", "#фон"]),
        json!(["#кот__сидит", "#чашка", "#листья", "#цветы", "#фон"]),
        json!(["#кот2", "#чашка", "#листья", "#цветы", "#фон"]),
        json!([
            format!("#{}", "я".repeat(30)),
            "#чашка",
            "#листья",
            "#цветы",
            "#фон"
        ]),
        json!(["#кот", "#чашка", "#листья", "#цветы", "#фон", "#стол"]),
    ] {
        let mut body = visual("Кот с чашкой");
        body["tags"] = tags;
        assert_eq!(run(&p, body).unwrap_err(), OcrContractViolation::Tags);
    }
    let mut body = visual("Кот с чашкой");
    body["tags"] = json!(["#кот", "#ван_гог", "#листья", "#цветы", "#фон"]);
    assert_eq!(
        run(&p, body).unwrap_err(),
        OcrContractViolation::UnsupportedTheme
    );
    let mut body = visual("Кот с чашкой");
    body["description_ru"] = format!("{SCENE} Японская деревня.").into();
    assert_eq!(
        run(&p, body).unwrap_err(),
        OcrContractViolation::UnsupportedTheme
    );
    // A material adjective for an object inside the drawing is scene copy, not
    // a product claim; the title and tags still reject it.
    let mut body = visual("Кот с чашкой");
    body["description_ru"] = format!("{SCENE} Керамическая кружка.").into();
    assert!(run(&p, body).is_ok());
    let mut plain_with_copy = empty("plain");
    plain_with_copy["description_ru"] = SCENE.into();
    assert_eq!(
        run(&p, plain_with_copy).unwrap_err(),
        OcrContractViolation::Shape
    );
    assert_eq!(
        preview(&p, &["#кружка".into()], "Кот с чашкой")
            .unwrap()
            .tags,
        Vec::<String>::new()
    );
}
#[test]
fn fixed_tags_remain_a_validated_boundary() {
    assert!(validate_fixed_tags(&["#кружка".into()]).is_ok());
    for tags in [
        vec![],
        vec!["#mug".into()],
        vec!["#кот".into(), "#Кот".into()],
        vec!["#кот__да".into()],
        vec!["#кот_330".into()],
    ] {
        assert!(validate_fixed_tags(&tags).is_err());
    }
}

#[test]
fn retired_theme_only_receipts_cannot_masquerade_as_full_visual_copy() {
    let cases: Vec<Value> = serde_json::from_str(include_str!(
        "../tests/fixtures/ocr-qwen-live-20261030.json"
    ))
    .unwrap();
    assert_eq!(cases.len(), 51);
    for case in cases {
        let profile: ProductProfile = serde_json::from_value(case["profile"].clone()).unwrap();
        let tags: Vec<String> = serde_json::from_value(case["fixed_tags"].clone()).unwrap();
        assert_eq!(
            parse_completion(&profile, &tags, &case["completion"]).unwrap_err(),
            OcrContractViolation::Shape
        );
    }
}

#[test]
fn real_visual_copy_replays_with_five_tags_and_confirmed_product_facts() {
    let cases: Vec<Value> = serde_json::from_str(include_str!(
        "../tests/fixtures/ocr-qwen-live-20261103.json"
    ))
    .unwrap();
    assert_eq!(cases.len(), 3);
    for case in cases {
        let profile: ProductProfile = serde_json::from_value(case["profile"].clone()).unwrap();
        let fixed: Vec<String> = serde_json::from_value(case["fixed_tags"].clone()).unwrap();
        let answer = parse_completion(&profile, &fixed, &case["completion"]).unwrap();
        assert_eq!(answer.ru, case["expected_title"].as_str().unwrap());
        assert_eq!(answer.desc, case["expected_description"].as_str().unwrap());
        assert_eq!(json!(answer.tags), case["expected_tags"]);
        assert_eq!(answer.tags.len(), VISUAL_TAG_COUNT);
        assert_eq!(case["billing"]["hold_entries"], 1);
        assert_eq!(case["billing"]["settle_entries"], 1);
    }
}
