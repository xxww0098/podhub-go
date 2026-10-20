#![no_main]
use libfuzzer_sys::fuzz_target;
use psdx::read_csh;

fuzz_target!(|data: &[u8]| {
    let _ = read_csh(data);
});
