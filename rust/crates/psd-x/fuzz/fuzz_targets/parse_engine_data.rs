#![no_main]
use libfuzzer_sys::fuzz_target;
use psdx::parse_engine_data;

fuzz_target!(|data: &[u8]| {
    let _ = parse_engine_data(data);
});
