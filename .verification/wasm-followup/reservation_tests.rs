use super::*;

fn template() -> Arc<ParsedTemplate> {
    let bytes = include_bytes!(concat!(env!("CARGO_MANIFEST_DIR"), "/../../../fixtures/psd/synthetic/tiny-smart-mask-warp-groups.psd"));
    Arc::new(ParsedTemplate::parse(bytes, &render::ProductResourcePolicy::default()).unwrap())
}
fn known(state: &mut State, key: &str, total: u64, shared: u64, template: &Arc<ParsedTemplate>) {
    state.templates.insert(key.into(), (99, template.clone()));
    state.record_peak(key, Peak::new(total, shared));
}
fn grant(state: &mut State, owner: u32, key: &str) -> u32 {
    state.acquire(owner, key.into()).unwrap().try_recv().unwrap().unwrap().unwrap()
}

#[test]
fn distinct_template_shared_reservation_is_checked_at_the_exact_boundary() {
    let parsed = template();
    for external in [0, 100] {
        for budget in [599 + external, 600 + external] {
            let mut state = State::new(2, budget);
            known(&mut state, "A", 300, 100, &parsed);
            state.set_external_bytes(external);
            let a = grant(&mut state, 1, "A");
            // Supply another retained key while A is live. This exercises the
            // admission invariant, not a claim about normal cache hit frequency.
            known(&mut state, "B", 300, 100, &parsed);
            let mut b = state.acquire(2, "B".into()).unwrap();
            let result = b.try_recv().unwrap();
            if budget < 600 + external {
                assert!(result.is_none(), "missing shared reservation for the newly active template");
                assert_eq!(state.reserved_bytes(), Some(300));
                state.release(a);
                assert!(b.try_recv().unwrap().is_some());
            } else {
                assert!(result.is_some());
                assert_eq!(state.reserved_bytes(), Some(600));
            }
        }
    }
}

#[test]
fn same_template_adds_only_its_exclusive_working_set() {
    let parsed = template();
    let mut state = State::new(3, 500);
    known(&mut state, "A", 300, 100, &parsed);
    let a = grant(&mut state, 1, "A");
    let b = grant(&mut state, 2, "A");
    assert_eq!(state.reserved_bytes(), Some(500));
    let mut third = state.acquire(3, "A".into()).unwrap();
    assert!(third.try_recv().unwrap().is_none());
    state.release(a);
    assert!(third.try_recv().unwrap().is_some());
    assert!(state.acquired(b, 2));
    assert_eq!(state.reserved_bytes(), Some(500));
}

#[test]
fn new_template_shared_bytes_cannot_hide_reservation_overflow() {
    let parsed = template();
    let mut state = State::new(2, u64::MAX);
    known(&mut state, "A", 1, 0, &parsed);
    let a = grant(&mut state, 1, "A");
    known(&mut state, "B", u64::MAX, 1, &parsed);
    let mut b = state.acquire(2, "B".into()).unwrap();
    assert!(b.try_recv().unwrap().is_none(), "shared reservation overflow must fail closed");
    assert_eq!(state.reserved_bytes(), Some(1));
    state.release(a);
    assert!(b.try_recv().unwrap().is_some(), "the existing idle single-job progress exception remains");
}
