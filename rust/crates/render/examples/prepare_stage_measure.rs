//! Cold parse / hot reuse stage clock for one PSD and one design.
//!
//! `cargo run -p render --profile profiling --example prepare_stage_measure`
//! stdout is one JSON document. Diagnostics go to stderr.
//! Cargo's `PROFILE` for this inherited profile is `release`, so the report
//! names `profiling` itself — that is the only optimization level this
//! measurement is allowed to claim.

use render::{
    ParsedTemplate, ProductResourcePolicy, RenderIntent, render_product, take_stage_timings,
};
use std::process::ExitCode;
use std::time::Instant;

const STAGES: [&str; 8] = [
    "psdParse",
    "designDecode",
    "placedPrep",
    "pass1Bounds",
    "pass2Composite",
    "rowRead",
    "encodeTotal",
    "atomicCommit",
];
const HOT_N: usize = 10;

fn main() -> ExitCode {
    match report() {
        Ok(json) => {
            println!("{json}");
            ExitCode::SUCCESS
        }
        Err(message) => {
            eprintln!("{message}");
            ExitCode::from(1)
        }
    }
}

fn report() -> Result<String, String> {
    let mut args = std::env::args().skip(1);
    let psd_path = args
        .next()
        .ok_or_else(|| "usage: prepare_stage_measure <psd> <design>".to_owned())?;
    let design_path = args
        .next()
        .ok_or_else(|| "usage: prepare_stage_measure <psd> <design>".to_owned())?;
    let psd = std::fs::read(&psd_path).map_err(|error| format!("read {psd_path}: {error}"))?;
    let design =
        std::fs::read(&design_path).map_err(|error| format!("read {design_path}: {error}"))?;
    let git_sha = git_sha()?;
    let policy = ProductResourcePolicy::default();
    let intent = RenderIntent::default();

    // The stage ledger only fills when PODHUB_RENDER_STAGE_LOG=1 (native
    // default off) — the documented invocation without it reported all-zero
    // stages with no hint.
    if std::env::var("PODHUB_RENDER_STAGE_LOG").ok().as_deref() != Some("1") {
        eprintln!("note: PODHUB_RENDER_STAGE_LOG is not 1 — stage timings will read as null/zero");
    }
    let started = Instant::now();
    let template = ParsedTemplate::parse(&psd, &policy).map_err(|error| error.to_string())?;
    let cold_wall_ms = elapsed_ms(started);
    let cold_stages = stage_object(&take_stage_timings());

    let mut hot_wall_ms = 0.0;
    let mut ms_sum = [0.0_f64; STAGES.len()];
    let mut count_sum = [0.0_f64; STAGES.len()];
    for _ in 0..HOT_N {
        let started = Instant::now();
        let outcome = render_product(&template, &design, &design_path, &intent, &policy)
            .map_err(|error| error.to_string())?;
        hot_wall_ms += elapsed_ms(started);
        let manifest: serde_json::Value = serde_json::from_slice(&outcome.manifest_json)
            .map_err(|error| format!("manifest json: {error}"))?;
        let timings = manifest
            .get("stageTimings")
            .cloned()
            .unwrap_or(serde_json::Value::Null);
        add_stages(&timings, &mut ms_sum, &mut count_sum);
    }

    let report = serde_json::json!({
        "schema": 1,
        "gitSha": git_sha,
        "profile": "profiling",
        "psdPath": psd_path,
        "psdBytes": psd.len(),
        "designPath": design_path,
        "designBytes": design.len(),
        "cold": { "wallMs": cold_wall_ms, "stages": cold_stages },
        "hot": {
            "n": HOT_N,
            "wallMs": hot_wall_ms,
            "stagesMean": mean_stages(&ms_sum, &count_sum),
        },
        "notes": "stages nest; do not sum",
    });
    serde_json::to_string_pretty(&report).map_err(|error| error.to_string())
}

fn git_sha() -> Result<String, String> {
    let output = std::process::Command::new("git")
        .args(["rev-parse", "HEAD"])
        .output()
        .map_err(|error| format!("git rev-parse HEAD: {error}"))?;
    if !output.status.success() {
        return Err(format!(
            "git rev-parse HEAD failed: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    let sha = String::from_utf8_lossy(&output.stdout).trim().to_owned();
    if sha.is_empty() {
        return Err("git rev-parse HEAD returned an empty sha".to_owned());
    }
    Ok(sha)
}

fn elapsed_ms(started: Instant) -> f64 {
    started.elapsed().as_secs_f64() * 1000.0
}

fn stage_number(stage: Option<&serde_json::Value>, field: &str) -> f64 {
    stage
        .and_then(|stage| stage.get(field))
        .and_then(serde_json::Value::as_f64)
        .unwrap_or(0.0)
}

fn stage_object(value: &serde_json::Value) -> serde_json::Value {
    let mut stages = serde_json::Map::new();
    for name in STAGES {
        stages.insert(
            name.to_owned(),
            serde_json::json!({
                "ms": stage_number(value.get(name), "ms"),
                "count": stage_number(value.get(name), "count"),
            }),
        );
    }
    serde_json::Value::Object(stages)
}

fn add_stages(value: &serde_json::Value, ms_sum: &mut [f64], count_sum: &mut [f64]) {
    for (index, name) in STAGES.iter().enumerate() {
        ms_sum[index] += stage_number(value.get(name), "ms");
        count_sum[index] += stage_number(value.get(name), "count");
    }
}

fn mean_stages(ms_sum: &[f64], count_sum: &[f64]) -> serde_json::Value {
    let mut stages = serde_json::Map::new();
    let n = HOT_N as f64;
    for (index, name) in STAGES.iter().enumerate() {
        stages.insert(
            (*name).to_owned(),
            serde_json::json!({
                "ms": ms_sum[index] / n,
                "count": count_sum[index] / n,
            }),
        );
    }
    serde_json::Value::Object(stages)
}
