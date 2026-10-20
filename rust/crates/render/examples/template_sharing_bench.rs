//! Native feasibility probe, not a browser/WASM-thread benchmark.
//! cargo run -p render --release --example template_sharing_bench --
//!   shared|isolated THREADS JOBS TEMPLATE DESIGN...
//! Run each case in a fresh process under /usr/bin/time -l for peak RSS.
use render::{ParsedTemplate, ProductResourcePolicy, RenderIntent, render_product};
use sha2::{Digest, Sha256};
use std::{sync::Barrier, thread, time::Instant};

fn main() {
    // A failed lane must fail the probe instead of stranding peers at a barrier.
    let report_panic = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        report_panic(info);
        std::process::exit(1);
    }));
    let args: Vec<_> = std::env::args().skip(1).collect();
    assert!(args.len() >= 5, "mode threads jobs template design...");
    let shared = match args[0].as_str() {
        "shared" => true,
        "isolated" => false,
        _ => panic!("expected shared or isolated"),
    };
    let threads: usize = args[1].parse().unwrap();
    let jobs: usize = args[2].parse().unwrap();
    assert!(threads > 0 && jobs >= threads && jobs.is_multiple_of(threads));
    assert_ne!(std::env::var("PODHUB_RENDER_STAGE_LOG").as_deref(), Ok("1"));
    let bytes = std::fs::read(&args[3]).unwrap();
    let designs: Vec<_> = args[4..]
        .iter()
        .map(|p| std::fs::read(p).unwrap())
        .collect();
    let policy = ProductResourcePolicy::default();
    let intent = RenderIntent::default();
    let start = Instant::now();
    let template = shared.then(|| ParsedTemplate::parse(&bytes, &policy).unwrap());
    let barrier = Barrier::new(threads + 1);
    let (setup_ms, render_ms, results) = thread::scope(|scope| {
        let handles: Vec<_> = (0..threads)
            .map(|lane| {
                let (bytes, designs, template, barrier, policy, intent) =
                    (&bytes, &designs, &template, &barrier, &policy, &intent);
                scope.spawn(move || {
                    let own = (!shared).then(|| ParsedTemplate::parse(bytes, policy).unwrap());
                    let template = template.as_ref().or(own.as_ref()).unwrap();
                    barrier.wait();
                    barrier.wait();
                    let mut results = Vec::new();
                    for job in (lane..jobs).step_by(threads) {
                        let outcome = render_product(
                            template,
                            &designs[job % designs.len()],
                            "bench.png",
                            intent,
                            policy,
                        )
                        .unwrap();
                        assert!(!outcome.slices.is_empty());
                        let hashes: Vec<_> = outcome
                            .slices
                            .iter()
                            .map(|slice| {
                                let hash = format!("sha256:{:x}", Sha256::digest(&slice.bytes));
                                assert_eq!(hash, slice.content_hash);
                                (slice.width, slice.height, hash)
                            })
                            .collect();
                        results.push(serde_json::json!({"job": job, "slices": hashes,
                        "documentBytes": outcome.resource_observations.document_resident_bytes}));
                    }
                    // Keep every lane's template alive through the measured batch.
                    barrier.wait();
                    results
                })
            })
            .collect();
        barrier.wait();
        let setup_ms = start.elapsed().as_secs_f64() * 1000.0;
        let rendering = Instant::now();
        barrier.wait();
        barrier.wait();
        let render_ms = rendering.elapsed().as_secs_f64() * 1000.0;
        let results: Vec<_> = handles
            .into_iter()
            .flat_map(|h| h.join().unwrap())
            .collect();
        (setup_ms, render_ms, results)
    });
    println!(
        "{}",
        serde_json::json!({"mode":args[0], "threads":threads, "jobs":jobs,
        "templateBytes":bytes.len(), "setupMs":setup_ms, "renderMs":render_ms,
        "totalMs":setup_ms + render_ms, "results":results})
    );
}
