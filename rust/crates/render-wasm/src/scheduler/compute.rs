//! One Rayon/oneshot adapter for all three compute jobs.
//! Completion releases busy state even when the reply channel closes. A WASM
//! trap still requires the host to destroy the entire shared runtime.
#![forbid(unsafe_code)]
use super::{
    admission::{Peak, State},
    error::RuntimeError,
};
#[cfg(feature = "threads")]
use {futures_channel::oneshot, std::cell::RefCell};

pub(super) struct Computed<T> {
    pub value: T,
    pub peak: Option<Peak>,
}

#[cfg(feature = "threads")]
pub(super) async fn run<T: Send + 'static>(
    state: &RefCell<State>,
    lease: u32,
    task: impl FnOnce() -> Result<Computed<T>, String> + Send + 'static,
) -> Result<T, RuntimeError> {
    let (send, receive) = oneshot::channel();
    rayon::spawn_fifo(move || {
        crate::clock::initialize_stage_clock();
        let _ = send.send(task());
    });
    let result = receive
        .await
        .map_err(|_| RuntimeError::Closed)
        .and_then(|result| result.map_err(RuntimeError::Compute));
    complete(&mut state.borrow_mut(), lease, result)
}

fn complete<T>(
    state: &mut State,
    lease: u32,
    result: Result<Computed<T>, RuntimeError>,
) -> Result<T, RuntimeError> {
    let peak = result.as_ref().ok().and_then(|reply| reply.peak);
    if !state.finish(lease, peak) {
        return Err(RuntimeError::Cancelled);
    }
    result.map(|reply| reply.value)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn active(state: &mut State) -> u32 {
        state.register_owner(1).unwrap();
        let id = state
            .acquire(1, "A".into())
            .unwrap()
            .try_recv()
            .unwrap()
            .unwrap()
            .unwrap();
        state.start(id).unwrap();
        id
    }
    #[test]
    fn closed_reply_and_compute_error_both_clear_busy_state() {
        let mut state = State::new(1, 1000);
        let id = active(&mut state);
        assert_eq!(
            complete::<()>(&mut state, id, Err(RuntimeError::Closed)),
            Err(RuntimeError::Closed)
        );
        assert!(state.start(id).is_ok());
        assert_eq!(
            complete::<()>(
                &mut state,
                id,
                Err(RuntimeError::Compute("bad image".into()))
            ),
            Err(RuntimeError::Compute("bad image".into()))
        );
        assert!(state.start(id).is_ok());
    }
    #[test]
    fn cancelled_compute_releases_lane_only_on_completion() {
        let mut state = State::new(1, 1000);
        let id = active(&mut state);
        state.register_owner(2).unwrap();
        let mut waiting = state.acquire(2, "B".into()).unwrap();
        state.dispose_owner(1);
        state.release(id);
        assert!(waiting.try_recv().unwrap().is_none());
        let reply = Ok(Computed {
            value: vec![7],
            peak: Some(Peak {
                total: 200,
                shared: 0,
            }),
        });
        assert_eq!(
            complete(&mut state, id, reply),
            Err(RuntimeError::Cancelled)
        );
        assert!(waiting.try_recv().unwrap().is_some());
    }

    #[test]
    fn duplicate_completion_neither_delivers_nor_reprices_the_lease() {
        let mut state = State::new(1, 1000);
        let id = active(&mut state);
        let reply = |value, total| {
            Ok(Computed {
                value,
                peak: Some(Peak::new(total, 0)),
            })
        };
        assert_eq!(complete(&mut state, id, reply(7, 100)), Ok(7));
        assert_eq!(
            complete(&mut state, id, reply(8, 900)),
            Err(RuntimeError::Cancelled)
        );
        let measured: serde_json::Value = serde_json::from_str(&state.measure()).unwrap();
        assert_eq!(measured["peaks"]["A"], 100);
    }
}
