use super::*;
use std::fmt::Write;

#[test]
fn repeated_keys_cannot_bypass_the_parser_token_budget() {
    let data = " /A 0".repeat(MAX_ENGINE_DATA_TOKENS / 2 + 1);
    let error = parse_engine_data_with_limit(data.as_bytes(), 1).expect_err("token limit");
    assert!(error.0.contains("token limit"));
}

#[test]
fn wide_shallow_dictionaries_keep_insertion_order() {
    let mut data = String::new();
    for index in 0..50_000 {
        write!(data, " /Key{index} {index}").unwrap();
    }
    for data in [data.clone(), format!("<<{data} >>")] {
        let EngineValue::Dict(pairs) = parse_engine_data_with_limit(data.as_bytes(), 1).unwrap()
        else {
            panic!("dictionary");
        };
        assert_eq!(pairs.len(), 50_000);
        for (index, (key, value)) in pairs.iter().enumerate() {
            assert_eq!(key, &format!("Key{index}"));
            assert_eq!(value, &EngineValue::Number(index as f64));
        }
    }
}

#[test]
fn wide_dictionary_token_limit_is_exact() {
    let count = (MAX_ENGINE_DATA_TOKENS - 2) / 2;
    let mut data = String::from("<< ");
    for index in 0..count {
        write!(data, "/Key{index} 0 ").unwrap();
    }
    data.push_str(">>");
    let EngineValue::Dict(pairs) = parse_engine_data_with_limit(data.as_bytes(), 1).unwrap() else {
        panic!("dictionary");
    };
    assert_eq!(pairs.len(), count);
    drop(pairs);

    data.truncate(data.len() - 2);
    data.push_str("/Extra 0 >>");
    let error = parse_engine_data_with_limit(data.as_bytes(), 1).expect_err("one over");
    assert!(error.0.contains("token limit"));
}

#[test]
fn shallow_arrays_share_the_parser_token_budget() {
    let data = format!("[ {}]", "0 ".repeat(MAX_ENGINE_DATA_TOKENS - 1));
    let error = parse_engine_data_with_limit(data.as_bytes(), 1).expect_err("one over");
    assert!(error.0.contains("token limit"));
}

#[test]
fn duplicate_keys_preserve_position_and_nested_values() {
    let data =
        b" /A 1 /B << /A true /Nested [ << /A 2 /A 3 >> null ] /A false >> /A [ 4 5 ] /C /Name";
    let expected = EngineValue::Dict(vec![
        (
            "A".into(),
            EngineValue::Array(vec![EngineValue::Number(4.0), EngineValue::Number(5.0)]),
        ),
        (
            "B".into(),
            EngineValue::Dict(vec![
                ("A".into(), EngineValue::Bool(false)),
                (
                    "Nested".into(),
                    EngineValue::Array(vec![
                        EngineValue::Dict(vec![("A".into(), EngineValue::Number(3.0))]),
                        EngineValue::Null,
                    ]),
                ),
            ]),
        ),
        ("C".into(), EngineValue::Str("/Name".into())),
    ]);
    assert_eq!(parse_engine_data_with_limit(data, 4).unwrap(), expected);
    let wrapped = [b"<<".as_slice(), data, b" >>".as_slice()].concat();
    assert_eq!(parse_engine_data_with_limit(&wrapped, 4).unwrap(), expected);
}
