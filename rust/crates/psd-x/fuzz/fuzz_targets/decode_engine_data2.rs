#![no_main]
use libfuzzer_sys::fuzz_target;
use psdx::{decode_engine_data2, parse_engine_data};

fuzz_target!(|data: &[u8]| {
    if let Ok(v) = parse_engine_data(data) {
        let _ = decode_engine_data2(&v);
    }
});
