use super::*;

fn grant(state: &mut State) -> u32 {
    state.acquire(42, "template".into()).unwrap().try_recv().unwrap().unwrap().unwrap()
}

#[test]
fn idle_finish_is_not_a_completion() {
    let mut state = State::new(1, 1000);
    let id = grant(&mut state);
    assert!(!state.finish(id), "idle lease has no computation to finish");
    assert!(state.acquired(id, 42));
    state.start(id).unwrap();
    assert!(state.finish(id));
    assert!(!state.finish(id), "completed work must not deliver twice while idle");
    assert!(state.start(id).is_ok(), "one lease supports consecutive parse/render work");
    assert!(state.finish(id));
    state.release(id);
    assert!(!state.finish(id));
}

#[test]
fn repeated_release_does_not_free_busy_work_or_corrupt_the_next_lease() {
    let mut state = State::new(1, 1000);
    let id = grant(&mut state);
    state.start(id).unwrap();
    let mut waiting = state.acquire(7, "next".into()).unwrap();
    state.release(id);
    state.release(id);
    assert_eq!(state.start(id), Err(RuntimeError::Cancelled));
    assert!(waiting.try_recv().unwrap().is_none());
    assert_eq!(state.leases.len(), 1);
    assert!(!state.finish(id));
    let next = waiting.try_recv().unwrap().unwrap().unwrap();
    assert!(state.acquired(next, 7));
    assert!(!state.finish(id));
    state.release(id);
    assert!(state.acquired(next, 7));
    assert_eq!(state.leases.len(), 1);
}

#[test]
fn a_reserved_lease_can_parse_then_render_the_same_retained_template() {
    let mut state = State::new(1, 1000);
    let bytes = include_bytes!(concat!(env!("CARGO_MANIFEST_DIR"), "/../../../fixtures/psd/synthetic/tiny-smart-mask-warp-groups.psd"));
    let template = Arc::new(ParsedTemplate::parse(bytes, &render::ProductResourcePolicy::default()).unwrap());
    let key = template.fingerprint().to_string();
    let id = state.acquire(42, key.clone()).unwrap().try_recv().unwrap().unwrap().unwrap();
    state.start(id).unwrap();
    assert!(state.finish(id));
    let template_id = state.retain_template(key.clone(), template).unwrap();
    let (actual, _, _) = state.begin_render(id, template_id).unwrap();
    assert_eq!(actual, key);
    assert_eq!(state.start(id), Err(RuntimeError::LeaseBusy));
    assert!(state.finish(id));
    assert!(state.acquired(id, 42));
    state.release(id);
    assert!(!state.acquired(id, 42));
}

#[test]
fn every_seven_event_lifecycle_sequence_matches_the_reference_model() {
    // Independent observable model; no production phase enum or transitions
    // are used to derive the expectations. 4^7 deterministic sequences.
    #[derive(Clone, Copy)]
    enum Model { Reserved, Running, Draining, Gone }
    for word in 0..(1_u32 << 14) {
        let mut state = State::new(1, 1000);
        let id = grant(&mut state);
        let mut model = Model::Reserved;
        for step in 0..7 {
            match (word >> (2 * step)) & 3 {
                0 => {
                    let expected = match model {
                        Model::Reserved => { model = Model::Running; Ok("template".to_string()) }
                        Model::Running => Err(RuntimeError::LeaseBusy),
                        Model::Draining => Err(RuntimeError::Cancelled),
                        Model::Gone => Err(RuntimeError::LeaseExpired),
                    };
                    assert_eq!(state.start(id), expected, "start word={word}, step={step}");
                }
                1 => {
                    let expected = match model {
                        Model::Running => { model = Model::Reserved; true }
                        Model::Draining => { model = Model::Gone; false }
                        _ => false,
                    };
                    assert_eq!(state.finish(id), expected, "finish word={word}, step={step}");
                }
                op => {
                    model = match model {
                        Model::Reserved => Model::Gone,
                        Model::Running | Model::Draining => Model::Draining,
                        Model::Gone => Model::Gone,
                    };
                    if op == 2 { state.release(id); } else { state.dispose_owner(42); }
                }
            }
            assert_eq!(state.leases.len(), usize::from(!matches!(model, Model::Gone)));
            assert_eq!(state.acquired(id, 42), matches!(model, Model::Reserved | Model::Running));
            assert!(!state.acquired(id, 7));
        }
    }
}
