
#[test]
fn completion_without_running_work_does_not_settle_a_reservation() {
    let mut state = State::new(1, 1000);
    let id = granted(&mut state, 1, "A");
    let mut waiting = queue(&mut state, 2, "B");
    assert!(!state.finish(id));
    assert!(state.acquired(id, 1));
    assert!(waiting.try_recv().unwrap().is_none());
    state.start(id).unwrap();
    assert!(state.finish(id));
    assert!(!state.finish(id), "one computation has one completion");
    // A lease covers parse followed by render; completion does not release it.
    state.start(id).unwrap();
    assert!(state.finish(id));
    assert!(waiting.try_recv().unwrap().is_none());
    state.release(id);
    assert!(waiting.try_recv().unwrap().is_some());
}

#[test]
fn release_and_dispose_drain_once_without_delivering_or_freeing_busy_work() {
    let mut state = State::new(1, 1000);
    let id = granted(&mut state, 1, "A");
    state.start(id).unwrap();
    let mut waiting = queue(&mut state, 2, "B");
    state.release(id);
    state.release(id);
    state.dispose_owner(1);
    state.dispose_owner(1);
    assert!(!state.acquired(id, 1));
    assert_eq!(state.start(id), Err(RuntimeError::Cancelled));
    assert!(waiting.try_recv().unwrap().is_none());
    assert!(!state.finish(id));
    let next = waiting.try_recv().unwrap().unwrap().unwrap();
    assert!(state.acquired(next, 2));
    assert!(!state.finish(id));
    state.release(id);
    assert!(state.acquired(next, 2), "late completion cannot release another lease");
}

#[test]
fn exhaustive_lease_event_sequences_preserve_ownership_and_drain_boundaries() {
    // Independent model: four events to depth six = 4096 sequences. There is
    // one unknown job and one follower, so each event checks actual FIFO
    // delivery as well as lifecycle state. No RNG or extra test framework.
    #[derive(Clone, Copy, PartialEq, Eq)]
    enum Model { Held, Computing, Abandoned, Gone }
    use Model::*;
    for sequence in 0..4096u32 {
        let mut events = sequence;
        let mut state = State::new(1, 1000);
        let id = granted(&mut state, 1, "A");
        let mut follower = queue(&mut state, 2, "B");
        let mut model = Held;
        let mut disposed = false;
        let mut delivered = false;
        for step in 0..6 {
            let event = events % 4;
            events /= 4;
            match event {
                0 => {
                    let expected = match model {
                        Gone => Err(RuntimeError::LeaseExpired),
                        Abandoned => Err(RuntimeError::Cancelled),
                        Computing => Err(RuntimeError::LeaseBusy),
                        Held => Ok("A".to_string()),
                    };
                    assert_eq!(state.start(id), expected, "sequence={sequence} step={step}");
                    if model == Held { model = Computing; }
                }
                1 => {
                    assert_eq!(state.finish(id), model == Computing, "sequence={sequence} step={step}");
                    model = match model { Computing => Held, Abandoned => Gone, other => other };
                }
                2 => {
                    state.release(id);
                    model = match model { Held => Gone, Computing => Abandoned, other => other };
                }
                _ => {
                    disposed = true;
                    state.dispose_owner(1);
                    model = match model { Held => Gone, Computing => Abandoned, other => other };
                }
            }
            assert_eq!(state.leases.contains_key(&id), model != Gone);
            assert_eq!(state.acquired(id, 1), !disposed && matches!(model, Held | Computing));
            assert!(!state.acquired(id, 2));
            assert_eq!(state.leases.len(), 1, "running or follower, never both");
            if !delivered {
                let grant = follower.try_recv().unwrap();
                assert_eq!(grant.is_some(), model == Gone, "sequence={sequence} step={step}");
                if let Some(result) = grant {
                    assert!(state.acquired(result.unwrap(), 2));
                    delivered = true;
                }
            }
        }
    }
}
