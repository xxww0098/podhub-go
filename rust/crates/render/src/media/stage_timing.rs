//! Per-render stage accounting.
//!
//! Each render runs on one compute thread; its counters must not include or
//! drain a sibling render's stages. On native
//! targets it is off unless `PODHUB_RENDER_STAGE_LOG=1`; on wasm it is always
//! on, with a monotonic clock callback supplied by the JS boundary.
//! [`drain`] hands the totals to the manifest.

use std::cell::Cell;

#[cfg(not(target_family = "wasm"))]
pub(crate) type Clock = std::time::Instant;
#[cfg(target_family = "wasm")]
pub(crate) type Clock = Option<f64>;

#[cfg(target_family = "wasm")]
thread_local! {
    static CLOCK: std::cell::Cell<Option<fn() -> f64>> = const { std::cell::Cell::new(None) };
}

#[cfg(target_family = "wasm")]
pub fn set_clock(clock: fn() -> f64) {
    // A reused compute thread may contain counters from a failed job or a
    // template parse. Neither belongs to the next render's manifest.
    let _ = drain();
    CLOCK.with(|slot| slot.set(Some(clock)));
}

#[derive(Clone, Copy)]
pub(crate) enum Stage {
    /// Template parse into a `ParsedTemplate`.
    PsdParse,
    /// Replacement design decode + fit resample.
    DesignDecode,
    /// Placed layer / mesh warp preparation per group.
    PlacedPrep,
    /// Pass 1 slab composites + alpha bounds union.
    Pass1Bounds,
    /// Pass 2 slab composites triggered by encode row reads.
    Pass2Composite,
    /// Output row production (window reads + resample) excluding slab
    /// composites, which report as `Pass2Composite`.
    RowRead,
    /// Whole streamed JPEG encode including row production.
    EncodeTotal,
    /// Collecting the encoded slices out of the delivery sink.
    AtomicCommit,
}

const STAGE_COUNT: usize = 8;
const STAGE_NAMES: [&str; STAGE_COUNT] = [
    "psdParse",
    "designDecode",
    "placedPrep",
    "pass1Bounds",
    "pass2Composite",
    "rowRead",
    "encodeTotal",
    "atomicCommit",
];

thread_local! {
    static STAGE_NANOS: [Cell<u64>; STAGE_COUNT] = const { [const { Cell::new(0) }; STAGE_COUNT] };
    static STAGE_COUNTS: [Cell<u64>; STAGE_COUNT] = const { [const { Cell::new(0) }; STAGE_COUNT] };
    #[cfg(target_family = "wasm")]
    static STAGE_UNMEASURED: [Cell<u64>; STAGE_COUNT] = const { [const { Cell::new(0) }; STAGE_COUNT] };
}

#[cfg(not(target_family = "wasm"))]
pub(crate) fn enabled() -> bool {
    static ENABLED: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    *ENABLED
        .get_or_init(|| std::env::var("PODHUB_RENDER_STAGE_LOG").is_ok_and(|value| value == "1"))
}

#[cfg(target_family = "wasm")]
pub(crate) fn enabled() -> bool {
    true
}

/// Adds the elapsed time since `started` to `stage`. No-op unless enabled.
pub(crate) fn record(stage: Stage, started: Clock) {
    if !enabled() {
        return;
    }
    let index = stage as usize;
    STAGE_COUNTS.with(|counts| counts[index].set(counts[index].get().saturating_add(1)));
    #[cfg(not(target_family = "wasm"))]
    STAGE_NANOS.with(|nanos| {
        nanos[index].set(
            nanos[index]
                .get()
                .saturating_add(u64::try_from(started.elapsed().as_nanos()).unwrap_or(u64::MAX)),
        );
    });
    #[cfg(target_family = "wasm")]
    match started.and_then(|start| CLOCK.with(|clock| clock.get()).map(|now| now() - start)) {
        Some(elapsed) if elapsed.is_finite() && elapsed >= 0.0 => {
            STAGE_NANOS.with(|nanos| {
                nanos[index].set(
                    nanos[index]
                        .get()
                        .saturating_add((elapsed * 1_000_000.0).min(u64::MAX as f64) as u64),
                );
            });
        }
        _ => {
            STAGE_UNMEASURED
                .with(|counts| counts[index].set(counts[index].get().saturating_add(1)));
        }
    }
}

/// Starts a stage clock. Callers pass the instant back to [`record`].
#[cfg(not(target_family = "wasm"))]
pub(crate) fn start() -> Clock {
    Clock::now()
}

#[cfg(target_family = "wasm")]
pub(crate) fn start() -> Clock {
    CLOCK.with(|clock| clock.get().map(|clock| clock()))
}

/// Milliseconds since [`start`], or 0 when the wasm clock was not supplied.
/// The instant is `Copy`, so callers can still [`record`] it afterwards.
pub(crate) fn elapsed_ms(started: Clock) -> u32 {
    #[cfg(not(target_family = "wasm"))]
    {
        u32::try_from(started.elapsed().as_millis()).unwrap_or(u32::MAX)
    }
    #[cfg(target_family = "wasm")]
    {
        let Some(start) = started else {
            return 0;
        };
        let Some(now) = CLOCK.with(|clock| clock.get()).map(|now| now()) else {
            return 0;
        };
        let elapsed = now - start;
        if !elapsed.is_finite() || elapsed < 0.0 {
            return 0;
        }
        elapsed.min(u32::MAX as f64) as u32
    }
}

/// Same totals `drain` would put on a manifest, for a step that has no manifest yet.
pub fn take_stage_timings() -> serde_json::Value {
    drain()
}

/// Drains the per-stage totals for the render that just finished.
///
/// Returns `null` while disabled. A wasm boundary that has not supplied a
/// usable clock still gets stage counts, with `ms` left null.
pub(crate) fn drain() -> serde_json::Value {
    if !enabled() {
        return serde_json::Value::Null;
    }
    let mut stages = serde_json::Map::new();
    for (index, stage_name) in STAGE_NAMES.iter().enumerate() {
        let nanos = STAGE_NANOS.with(|nanos| nanos[index].replace(0));
        let count = STAGE_COUNTS.with(|counts| counts[index].replace(0));
        #[cfg(not(target_family = "wasm"))]
        let ms = serde_json::json!(nanos as f64 / 1_000_000.0);
        #[cfg(target_family = "wasm")]
        let ms = if STAGE_UNMEASURED.with(|counts| counts[index].replace(0)) == 0 {
            serde_json::json!(nanos as f64 / 1_000_000.0)
        } else {
            serde_json::Value::Null
        };
        stages.insert(
            (*stage_name).to_owned(),
            serde_json::json!({ "ms": ms, "count": count }),
        );
    }
    serde_json::Value::Object(stages)
}
