use super::*;
fn queue(state: &mut State, owner: u32, key: &str) -> oneshot::Receiver<Admission> {
    state.acquire(owner, key.into()).unwrap()
}
fn granted(state: &mut State, owner: u32, key: &str) -> u32 {
    queue(state, owner, key)
        .try_recv()
        .unwrap()
        .unwrap()
        .unwrap()
}
fn parsed() -> Arc<ParsedTemplate> {
    let bytes = include_bytes!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../../fixtures/psd/synthetic/tiny-smart-mask-warp-groups.psd"
    ));
    Arc::new(ParsedTemplate::parse(bytes, &render::ProductResourcePolicy::default()).unwrap())
}
/// A peak whose bytes are all paid again by every extra lane.
fn exclusive(total: u64) -> Peak {
    Peak::new(total, 0)
}
fn known(state: &mut State, key: &str, peak: u64) {
    state.templates.insert(key.into(), (99, parsed()));
    state.record_peak(key, exclusive(peak));
}
fn known_split(state: &mut State, key: &str, total: u64, shared: u64) {
    state.templates.insert(key.into(), (99, parsed()));
    state.record_peak(key, Peak::new(total, shared));
}

#[test]
fn admission_observes_exact_budget_external_bytes_and_fifo() {
    let mut state = State::new(3, 1000);
    known(&mut state, "A", 400);
    state.set_external_bytes(200);
    let a = granted(&mut state, 1, "A");
    let b = granted(&mut state, 2, "A");
    let mut c = queue(&mut state, 3, "A");
    assert_eq!(state.leases.len(), 2);
    assert!(c.try_recv().unwrap().is_none());
    state.set_external_bytes(201);
    state.release(a);
    assert!(c.try_recv().unwrap().is_none());
    state.set_external_bytes(200);
    assert!(c.try_recv().unwrap().is_some());
    let mut unknown = queue(&mut state, 4, "B");
    let mut behind = queue(&mut state, 5, "A");
    state.release(b);
    assert!(unknown.try_recv().unwrap().is_none());
    assert!(behind.try_recv().unwrap().is_none());
}
#[test]
fn unknown_and_evicted_templates_measure_alone_even_with_historical_peaks() {
    let mut state = State::new(3, 1000);
    state.record_peak("evicted", exclusive(100));
    let first = granted(&mut state, 1, "evicted");
    let mut second = queue(&mut state, 2, "evicted");
    assert!(second.try_recv().unwrap().is_none());
    assert_eq!(state.leases.len(), 1);
    state.set_external_bytes(9999);
    state.release(first);
    assert!(second.try_recv().unwrap().is_some());
    assert_eq!(state.leases.len(), 1);
}
#[test]
fn cancelling_busy_owner_keeps_lease_until_compute_finishes() {
    let mut state = State::new(1, 1000);
    let id = granted(&mut state, 1, "A");
    state.start(id).unwrap();
    let mut cancelled = queue(&mut state, 1, "A");
    let mut waiting = queue(&mut state, 2, "B");
    state.dispose_owner(1);
    state.release(id);
    assert_eq!(
        cancelled.try_recv().unwrap(),
        Some(Err(RuntimeError::Cancelled))
    );
    assert!(waiting.try_recv().unwrap().is_none());
    assert_eq!(state.leases.len(), 1);
    assert!(!state.finish(id, None));
    assert!(waiting.try_recv().unwrap().is_some());
    assert_eq!(state.leases.len(), 1);
    assert_eq!(
        state.acquire(1, "A".into()).unwrap_err(),
        RuntimeError::Cancelled
    );
}
#[test]
fn template_key_accepts_opfs_digest_and_rejects_different_bytes() {
    let mut state = State::new(1, 1000);
    let template = parsed();
    let fingerprint = template.fingerprint().to_string();
    let digest = fingerprint.strip_prefix("sha256:").unwrap();
    assert!(
        state
            .retain_template(digest.into(), template.clone())
            .is_ok()
    );
    assert!(state.retain_template(fingerprint, template.clone()).is_ok());
    assert_eq!(
        state.retain_template("b".repeat(64), template),
        Err(RuntimeError::TemplateFingerprint)
    );
}
#[test]
fn parsed_template_can_render_on_the_same_lease() {
    let mut state = State::new(1, 1000);
    let template = parsed();
    let key = template.fingerprint().to_string();
    let lease = granted(&mut state, 1, &key);
    assert_eq!(state.start(lease).unwrap(), key);
    assert!(state.finish(lease, None));
    let id = state.retain_template(key.clone(), template).unwrap();
    assert!(matches!(
        state.begin_render(lease, id + 1),
        Err(RuntimeError::TemplateMissing)
    ));
    let (render_key, _, unknown) = state.begin_render(lease, id).unwrap();
    assert_eq!(render_key, key);
    assert!(unknown);
    assert!(state.finish(lease, None));
    state.release(lease);
    assert!(state.leases.is_empty());
}
#[test]
fn cancelled_receiver_does_not_block_fifo_or_evict_templates() {
    let mut state = State::new(3, 1000);
    known(&mut state, "A", 100);
    let active = granted(&mut state, 1, "A");
    let cancelled = queue(&mut state, 2, "unknown");
    let mut behind = queue(&mut state, 3, "A");
    assert!(behind.try_recv().unwrap().is_none());
    drop(cancelled);
    state.set_external_bytes(0);
    assert!(behind.try_recv().unwrap().is_some());
    assert!(state.acquired(active, 1));
    assert!(state.template_id("A").is_some());
}
#[test]
fn queue_is_bounded_and_busy_leases_cannot_be_started_twice() {
    let mut state = State::new(1, 1000);
    let id = granted(&mut state, 1, "A");
    assert!(!state.acquired(id, 2));
    state.start(id).unwrap();
    assert_eq!(state.start(id), Err(RuntimeError::LeaseBusy));
    let waiting: Vec<_> = (0..MAX_WAITERS)
        .map(|_| queue(&mut state, 2, "A"))
        .collect();
    assert_eq!(
        state.acquire(2, "A".into()).unwrap_err(),
        RuntimeError::QueueFull
    );
    assert_eq!(state.waiters.len(), MAX_WAITERS);
    drop(waiting);
    state.release(id);
    assert!(!state.finish(id, None));
    assert_eq!(state.start(id), Err(RuntimeError::LeaseExpired));
}
#[test]
fn peaks_never_decrease_and_byte_sums_saturate_without_panicking() {
    let mut state = State::new(3, u64::MAX);
    known(&mut state, "A", u64::MAX);
    let id = granted(&mut state, 1, "A");
    state.record_peak("A", exclusive(1));
    assert_eq!(state.peaks["A"].total, u64::MAX);
    state.set_external_bytes(1);
    let mut waiting = queue(&mut state, 2, "A");
    // Saturation is conservative: overflow must not compare equal to the budget.
    assert!(waiting.try_recv().unwrap().is_none());
    assert!(state.measure().contains(&u64::MAX.to_string()));
    state.release(id);
}
#[test]
fn exhausted_ids_reject_without_overwriting_a_live_lease() {
    let mut state = State::new(2, 1000);
    known(&mut state, "A", 100);
    state.next = u32::MAX - 1;
    let id = granted(&mut state, 1, "A");
    assert_eq!(id, u32::MAX);
    assert_eq!(
        queue(&mut state, 2, "A").try_recv().unwrap(),
        Some(Err(RuntimeError::IdsExhausted))
    );
    assert!(state.acquired(id, 1));
}

#[test]
fn overflowed_reservations_do_not_admit_a_zero_peak_template() {
    let mut state = State::new(4, u64::MAX);
    known(&mut state, "A", 1);
    let _a = granted(&mut state, 1, "A");
    let _b = granted(&mut state, 2, "A");
    // Two running jobs increase the historical peak after their admission.
    state.record_peak("A", exclusive(u64::MAX));
    known(&mut state, "C", 0);
    let mut waiting = queue(&mut state, 3, "C");
    assert!(state.reserved_bytes().is_none());
    assert!(waiting.try_recv().unwrap().is_none());
    assert!(state.measure().contains(&u64::MAX.to_string()));
}

#[test]
fn lanes_of_one_template_charge_the_shared_slice_once() {
    const MIB: u64 = 1024 * 1024;
    // One job peaks at 550 MiB of which 100 MiB is the parsed template, so a
    // second lane adds only the 450 MiB working set and not the whole peak.
    let mut state = State::new(4, 1000 * MIB);
    known_split(&mut state, "A", 550 * MIB, 100 * MIB);
    let first = granted(&mut state, 1, "A");
    let second = granted(&mut state, 2, "A");
    let mut third = queue(&mut state, 3, "A");
    assert_eq!(state.reserved_bytes(), Some(1000 * MIB));
    assert!(third.try_recv().unwrap().is_none());
    state.release(second);
    assert!(third.try_recv().unwrap().is_some());
    assert!(state.acquired(first, 1));
}

#[test]
fn distinct_templates_each_contribute_their_own_shared_slice() {
    const MIB: u64 = 1024 * 1024;
    let mut state = State::new(4, 800 * MIB);
    known_split(&mut state, "A", 300 * MIB, 100 * MIB);
    let a = granted(&mut state, 1, "A");
    // Admitting a job evicts every template no live lease names, so B is
    // retained by its own job and not before it.
    known_split(&mut state, "B", 300 * MIB, 100 * MIB);
    let _b = granted(&mut state, 2, "B");
    // 200 MiB of per-lane slices plus 100 MiB of each template held once.
    assert_eq!(state.reserved_bytes(), Some(600 * MIB));
    let mut third = queue(&mut state, 3, "A");
    assert!(third.try_recv().unwrap().is_some());
    assert_eq!(state.reserved_bytes(), Some(800 * MIB));
    state.release(a);
    // A still runs once, so the shared slice of A is still charged once.
    assert_eq!(state.reserved_bytes(), Some(600 * MIB));
    assert!(state.measure().contains("\"peaks\":{"), "flat peak map");
}

#[test]
fn a_shared_slice_is_clamped_to_the_peak_it_belongs_to() {
    // A mispriced template must not be able to claim negative lane bytes.
    assert_eq!(Peak::new(100, 250), Peak::new(100, 100));
    assert_eq!(Peak::new(100, 250).lane_bytes(), 0);
}

#[test]
fn measurement_reports_one_plain_number_per_template() {
    let mut state = State::new(2, 1000);
    known_split(&mut state, "A", 300, 100);
    let _a = granted(&mut state, 1, "A");
    let measured = state.measure();
    // The measurement exposes one byte count per template, not the split.
    assert!(measured.contains("\"peaks\":{\"A\":300}"), "{measured}");
    assert!(measured.contains("\"occupiedBytes\":300"), "{measured}");
}

#[test]
fn seeded_lifecycle_sequences_preserve_reservations_and_advance_waiters() {
    let mut seed = 0x5eed_u64;
    for _ in 0..256 {
        let mut state = State::new(1, 1000);
        known_split(&mut state, "A", 300, 100);
        let id = granted(&mut state, 1, "A");
        let mut waiting = queue(&mut state, 2, "A");
        let mut events = [0, 0, 1, 1, 2, 2, 3, 3];
        for i in (1..events.len()).rev() {
            seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1);
            events.swap(i, (seed >> 32) as usize % (i + 1));
        }
        let mut running = false;
        let mut abandoned = false;
        let mut starts = 0;
        let mut deliveries = 0;
        for event in events {
            match event {
                0 => {
                    if state.start(id).is_ok() {
                        assert!(!running && !abandoned);
                        running = true;
                        starts += 1;
                    }
                }
                1 => {
                    state.release(id);
                    abandoned = true;
                }
                2 => {
                    state.dispose_owner(1);
                    abandoned = true;
                }
                3 => {
                    let delivered = state.finish(id, Some(Peak::new(300, 100)));
                    assert_eq!(delivered, running && !abandoned);
                    deliveries += usize::from(delivered);
                    running = false;
                }
                _ => unreachable!(),
            }
            assert!(deliveries <= starts);
            assert_eq!(state.leases.len(), 1);
            assert_eq!(state.reserved_bytes(), Some(300));
            if running {
                assert!(state.leases.contains_key(&id));
                assert!(waiting.try_recv().unwrap().is_none());
            }
        }
        state.release(id);
        assert!(!state.finish(id, None));
        let next = waiting.try_recv().unwrap().unwrap().unwrap();
        assert!(state.acquired(next, 2));
        assert!(!state.acquired(id, 1));
        state.release(next);
        assert!(state.leases.is_empty() && state.waiters.is_empty());
        assert_eq!(state.reserved_bytes(), Some(0));
    }
}
