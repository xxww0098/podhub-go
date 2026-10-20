#![no_main]
use libfuzzer_sys::fuzz_target;
use psdx::psd::ReadOptions;
use psdx::read_psd;

fuzz_target!(|data: &[u8]| {
    let _ = read_psd(data, &ReadOptions::default());
});
