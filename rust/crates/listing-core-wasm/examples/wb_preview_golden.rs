//! Explicit native-only exporter. Tests never invoke this or write a golden.
use std::io::{self, Write};
use std::path::Path;

use listing_core::wb::{Issue, Material, Preview, WbProductConfig, build_preview, metadata_issues};
use serde::{Deserialize, Serialize};

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct InputCase {
    id: String,
    material: Material,
    config: WbProductConfig,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ExpectedCase {
    id: String,
    metadata_issues: Vec<Issue>,
    preview: Preview,
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let path =
        Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/ambient/wb-preview-input.json");
    let cases: Vec<InputCase> = serde_json::from_slice(&std::fs::read(path)?)?;
    // The expected bytes come directly from native listing-core, never the
    // host ABI, a WASM instance, or a JavaScript JSON serialization.
    let expected: Vec<_> = cases
        .into_iter()
        .map(|case| ExpectedCase {
            id: case.id,
            metadata_issues: metadata_issues(&case.material),
            preview: build_preview(&case.material, &case.config),
        })
        .collect();
    let mut stdout = io::stdout().lock();
    writeln!(stdout, "[")?;
    for (index, case) in expected.iter().enumerate() {
        // One complete case per line keeps full byte arrays compact.
        write!(stdout, "  {}", serde_json::to_string(case)?)?;
        writeln!(
            stdout,
            "{}",
            if index + 1 == expected.len() { "" } else { "," }
        )?;
    }
    writeln!(stdout, "]")?;
    Ok(())
}
