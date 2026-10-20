//! Where encoded slices land while a render is in flight.
//!
//! There is no filesystem on wasm32-unknown-unknown and no directory to stage
//! into in a browser worker, so slices collect in memory and the caller decides
//! where they go (OPFS, an upload, a Cloud object). Groups render one at a time
//! on the caller's stack; this buffer is sequential.

use crate::media::error::MediaError;
use std::io::Write;

#[derive(Default)]
pub(crate) struct MemoryDelivery {
    slices: Vec<(String, Vec<u8>)>,
}

impl MemoryDelivery {
    pub(crate) fn begin() -> Self {
        Self::default()
    }

    pub(crate) fn write_streamed_slice<T>(
        &mut self,
        file_name: &str,
        write: impl FnOnce(&mut dyn Write) -> Result<T, MediaError>,
    ) -> Result<T, MediaError> {
        let mut buffer = Vec::new();
        let value = write(&mut buffer)?;
        self.slices.push((file_name.to_owned(), buffer));
        Ok(value)
    }

    pub(crate) fn commit(self) -> Vec<(String, Vec<u8>)> {
        self.slices
    }
}

pub(crate) fn safe_segment(value: &str, fallback: &str) -> String {
    let cleaned = value
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_') {
                ch
            } else {
                '_'
            }
        })
        .collect::<String>()
        .trim_matches(|ch: char| ch == '.' || ch == '_' || ch.is_whitespace())
        .chars()
        .take(40)
        .collect::<String>();
    if cleaned.is_empty() {
        fallback.to_owned()
    } else {
        cleaned
    }
}
