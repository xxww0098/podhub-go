use super::*;
use crate::engine_data::parse_engine_data_with_limit;
use std::{fmt::Write, sync::mpsc, time::Duration};

#[test]
fn wide_txt2_dictionaries_decode_without_quadratic_work() {
    let mut data = String::new();
    for index in 0..200_000 {
        write!(data, " /Key{index} {index}").unwrap();
    }
    let parsed = parse_engine_data_with_limit(data.as_bytes(), 2).unwrap();
    let (send, receive) = mpsc::channel();
    std::thread::spawn(move || {
        let _ = send.send(decode_engine_data2_with_limit(&parsed, 2));
    });
    // Wide Txt2 input fits the token cap but previously caused 20 billion
    // comparisons. The generous ceiling detects that work, not normal jitter.
    let decoded = receive
        .recv_timeout(Duration::from_secs(5))
        .expect("wide Txt2 dictionary must complete within the work ceiling")
        .unwrap();
    let EngineValue::Dict(pairs) = decoded else {
        panic!("dictionary");
    };
    assert_eq!(pairs.len(), 200_000);
    for (index, (key, value)) in pairs.iter().enumerate() {
        assert_eq!(key, &format!("Key{index}"));
        assert_eq!(value, &EngineValue::Number(index as f64));
    }
}

#[test]
fn renamed_keys_and_uprooted_type_keep_first_position_and_last_value() {
    let child = EngineValue::Dict(vec![
        ("A".into(), EngineValue::Number(1.0)),
        ("_type".into(), EngineValue::Number(2.0)),
        ("B".into(), EngineValue::Number(3.0)),
    ]);
    let input = EngineValue::Dict(vec![
        ("ResourceDict".into(), EngineValue::Null),
        ("0".into(), child.clone()),
        ("Other".into(), EngineValue::Number(4.0)),
        ("_type".into(), EngineValue::Number(5.0)),
        ("99".into(), EngineValue::Number(6.0)),
    ]);
    assert_eq!(
        decode_engine_data2_with_limit(&input, 3).unwrap(),
        EngineValue::Dict(vec![
            ("ResourceDict".into(), child.clone()),
            ("Other".into(), EngineValue::Number(4.0)),
            ("_type".into(), EngineValue::Number(6.0)),
        ])
    );

    let input = EngineValue::Dict(vec![
        ("child".into(), child),
        ("99".into(), EngineValue::Number(7.0)),
    ]);
    let keys = dict(vec![("child", entry(None, true, None))]);
    assert_eq!(
        decode_obj(&input, &keys, 0, 3).unwrap(),
        EngineValue::Dict(vec![
            ("A".into(), EngineValue::Number(1.0)),
            ("_type".into(), EngineValue::Number(7.0)),
            ("B".into(), EngineValue::Number(3.0)),
        ])
    );
}
