use super::*;

fn grant(state: &mut State, owner: u32) -> u32 {
    state.acquire(owner, "A".into()).unwrap().try_recv().unwrap().unwrap().unwrap()
}

#[test]
fn completion_requires_running_and_is_not_delivered_twice() {
    let mut state = State::new(1, 1000);
    let id = grant(&mut state, 1);
    assert!(!state.finish(id), "a reservation is not a completed computation");
    assert!(state.start(id).is_ok());
    assert!(state.finish(id));
    assert!(!state.finish(id), "the same completion must not be accepted twice");
    // Parsing and rendering intentionally reuse the same admitted lease.
    assert!(state.start(id).is_ok());
    assert!(state.finish(id));
    state.release(id);
    assert!(!state.finish(id));
}

#[test]
fn repeated_cancellation_drains_without_early_or_duplicate_handoff() {
    let mut state = State::new(1, 1000);
    let id = grant(&mut state, 1);
    state.start(id).unwrap();
    let mut waiting = state.acquire(2, "B".into()).unwrap();
    for _ in 0..4 { state.dispose_owner(1); state.release(id); }
    assert_eq!(state.leases.len(), 1);
    assert!(waiting.try_recv().unwrap().is_none());
    assert_eq!(state.start(id), Err(RuntimeError::Cancelled));
    assert!(!state.finish(id));
    let other = waiting.try_recv().unwrap().unwrap().unwrap();
    assert!(state.acquired(other, 2));
    assert!(!state.finish(id));
    state.release(id);
    assert_eq!(state.leases.len(), 1);
    assert!(state.acquired(other, 2));
}

#[test]
fn every_six_event_lifecycle_sequence_matches_an_independent_model() {
    #[derive(Clone, Copy, PartialEq, Eq)]
    enum Model { Reserved, Running, Draining, Absent }
    // Exhaust all 4^6 sequences: start, finish, release, owner cancellation.
    for sequence in 0..4096_u32 {
        let mut state = State::new(1, 1000);
        let id = grant(&mut state, 1);
        let mut model = Model::Reserved;
        let mut closed = false;
        let mut encoded = sequence;
        for step in 0..6 {
            let event = encoded % 4;
            encoded /= 4;
            match event {
                0 => {
                    let expected = match model {
                        Model::Absent => Err(RuntimeError::LeaseExpired),
                        Model::Draining => Err(RuntimeError::Cancelled),
                        Model::Running => Err(RuntimeError::LeaseBusy),
                        Model::Reserved => { model = Model::Running; Ok("A".to_owned()) }
                    };
                    assert_eq!(state.start(id), expected, "sequence={sequence} step={step}");
                }
                1 => {
                    let valid = model == Model::Running;
                    model = match model { Model::Running => Model::Reserved, Model::Draining => Model::Absent, other => other };
                    assert_eq!(state.finish(id), valid, "sequence={sequence} step={step}");
                }
                2 | 3 => {
                    model = match model { Model::Reserved => Model::Absent, Model::Running => Model::Draining, other => other };
                    if event == 2 { state.release(id); }
                    else { closed = true; state.dispose_owner(1); }
                }
                _ => unreachable!(),
            }
            assert_eq!(state.leases.len(), usize::from(model != Model::Absent));
            assert_eq!(state.acquired(id, 1), !closed && matches!(model, Model::Reserved | Model::Running));
        }
    }
}

#[test]
fn a_different_template_pays_its_shared_bytes_before_admission() {
    let bytes = include_bytes!(concat!(env!("CARGO_MANIFEST_DIR"), "/../../../fixtures/psd/synthetic/tiny-smart-mask-warp-groups.psd"));
    let template = Arc::new(ParsedTemplate::parse(bytes, &render::ProductResourcePolicy::default()).unwrap());
    for budget in [599, 600] {
        let mut state = State::new(2, budget);
        state.templates.insert("A".into(), (11, template.clone()));
        state.record_peak("A", Peak::new(300, 100));
        let first = grant(&mut state, 1);
        // Keep A live while introducing independently shared template B.
        state.templates.insert("B".into(), (12, template.clone()));
        state.record_peak("B", Peak::new(300, 100));
        let mut second = state.acquire(2, "B".into()).unwrap();
        let ready = second.try_recv().unwrap();
        if budget < 600 {
            assert!(ready.is_none(), "a new template must pay its shared bytes");
            assert_eq!(state.reserved_bytes(), Some(300));
            state.release(first);
            assert!(second.try_recv().unwrap().is_some());
        } else {
            assert!(ready.is_some());
            assert_eq!(state.reserved_bytes(), Some(600));
        }
    }
}
