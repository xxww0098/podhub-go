#![no_main]
use libfuzzer_sys::fuzz_target;
use psdx::{read_abr, ReadAbrOptions};

fuzz_target!(|data: &[u8]| {
    let _ = read_abr(data, &ReadAbrOptions::default());
});
