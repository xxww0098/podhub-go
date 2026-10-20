
#[cfg(test)]
mod completion_guard_tests {
    use super::*;
    fn running(state: &mut State) -> u32 {
        let id = state.acquire(1, "A".into()).unwrap().try_recv().unwrap().unwrap().unwrap();
        state.start(id).unwrap();
        id
    }
    #[test]
    fn duplicate_completion_cannot_change_historical_reservation() {
        let mut state = State::new(1, 1000);
        let id = running(&mut state);
        assert_eq!(complete(&mut state, id, "A", Ok(Computed { value: 7, peak: Some(Peak::new(100, 0)) })), Ok(7));
        let before = state.measure();
        assert_eq!(complete(&mut state, id, "A", Ok(Computed { value: 8, peak: Some(Peak::new(999, 0)) })), Err(RuntimeError::Cancelled));
        assert_eq!(state.measure(), before, "duplicate completion must not update peaks");
        assert!(state.start(id).is_ok());
    }
    #[test]
    fn foreign_template_completion_cannot_finish_a_running_lease() {
        let mut state = State::new(1, 1000);
        let id = running(&mut state);
        assert_eq!(complete(&mut state, id, "B", Ok(Computed { value: 1, peak: Some(Peak::new(900, 0)) })), Err(RuntimeError::Cancelled), "foreign completion must not claim the lease");
        assert_eq!(state.start(id), Err(RuntimeError::LeaseBusy));
        assert_eq!(complete(&mut state, id, "A", Ok(Computed { value: 7, peak: Some(Peak::new(100, 0)) })), Ok(7));
    }
}
