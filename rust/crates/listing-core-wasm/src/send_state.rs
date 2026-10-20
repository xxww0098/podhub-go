//! Browser send permission. The page keeps the API key in JS memory.
//! This function never sees that key, a socket, or IndexedDB.
//!
//! `allow_post` is true only for `(queued, key_present)`: the key is in
//! memory and this row has not entered `fetch_started`. After
//! `fetch_started`, `allow_post` stays false. `submitting`, `unknown`,
//! and `accepted` also refuse another POST. `rejected` does not re-arm
//! the same row; a new send starts again at `queued`.

/// One step of the browser send machine.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct SendStep {
    pub state: &'static str,
    pub allow_post: bool,
}

/// Applies one named edge. An edge that is not in the table is an error
/// and must not be written.
pub(crate) fn apply_send(state: &str, event: &str) -> Result<SendStep, &'static str> {
    let step = match (state, event) {
        ("queued", "key_present") => SendStep { state: "queued", allow_post: true },
        ("queued", "fetch_started") => SendStep { state: "fetch_started", allow_post: false },

        ("submitting", "key_present") => SendStep { state: "submitting", allow_post: false },
        ("submitting", "fetch_started") => SendStep { state: "fetch_started", allow_post: false },
        ("submitting", "task_accepted") => SendStep { state: "accepted", allow_post: false },
        ("submitting", "http_4xx") => SendStep { state: "rejected", allow_post: false },
        ("submitting", "no_status") => SendStep { state: "unknown", allow_post: false },
        ("submitting", "report_failed") => SendStep { state: "submitting", allow_post: false },

        ("fetch_started", "key_present") | ("fetch_started", "fetch_started") => {
            SendStep { state: "fetch_started", allow_post: false }
        }
        ("fetch_started", "task_accepted") => SendStep { state: "accepted", allow_post: false },
        ("fetch_started", "http_4xx") => SendStep { state: "rejected", allow_post: false },
        ("fetch_started", "no_status") => SendStep { state: "unknown", allow_post: false },
        ("fetch_started", "report_failed") => SendStep { state: "submitting", allow_post: false },

        ("unknown", "key_present") => SendStep { state: "unknown", allow_post: false },
        ("unknown", "task_accepted") => SendStep { state: "accepted", allow_post: false },
        ("unknown", "http_4xx") => SendStep { state: "rejected", allow_post: false },
        ("unknown", "no_status") | ("unknown", "report_failed") => {
            SendStep { state: "unknown", allow_post: false }
        }

        ("accepted", "key_present") | ("accepted", "task_accepted") => {
            SendStep { state: "accepted", allow_post: false }
        }

        ("rejected", "key_present") | ("rejected", "http_4xx") => {
            SendStep { state: "rejected", allow_post: false }
        }

        _ => return Err("illegal send transition"),
    };
    if step.allow_post && (state == "fetch_started" || step.state == "fetch_started") {
        return Err("illegal send transition");
    }
    Ok(step)
}

#[cfg(test)]
mod tests {
    use super::apply_send;

    const STATES: [&str; 6] = [
        "queued",
        "submitting",
        "fetch_started",
        "unknown",
        "accepted",
        "rejected",
    ];
    const EVENTS: [&str; 6] = [
        "key_present",
        "fetch_started",
        "task_accepted",
        "http_4xx",
        "no_status",
        "report_failed",
    ];

    fn legal(state: &str, event: &str) -> Option<(&'static str, bool)> {
        match (state, event) {
            ("queued", "key_present") => Some(("queued", true)),
            ("queued", "fetch_started") => Some(("fetch_started", false)),
            ("submitting", "key_present") => Some(("submitting", false)),
            ("submitting", "fetch_started") => Some(("fetch_started", false)),
            ("submitting", "task_accepted") => Some(("accepted", false)),
            ("submitting", "http_4xx") => Some(("rejected", false)),
            ("submitting", "no_status") => Some(("unknown", false)),
            ("submitting", "report_failed") => Some(("submitting", false)),
            ("fetch_started", "key_present") | ("fetch_started", "fetch_started") => {
                Some(("fetch_started", false))
            }
            ("fetch_started", "task_accepted") => Some(("accepted", false)),
            ("fetch_started", "http_4xx") => Some(("rejected", false)),
            ("fetch_started", "no_status") => Some(("unknown", false)),
            ("fetch_started", "report_failed") => Some(("submitting", false)),
            ("unknown", "key_present") => Some(("unknown", false)),
            ("unknown", "task_accepted") => Some(("accepted", false)),
            ("unknown", "http_4xx") => Some(("rejected", false)),
            ("unknown", "no_status") | ("unknown", "report_failed") => Some(("unknown", false)),
            ("accepted", "key_present") | ("accepted", "task_accepted") => Some(("accepted", false)),
            ("rejected", "key_present") | ("rejected", "http_4xx") => Some(("rejected", false)),
            _ => None,
        }
    }

    #[test]
    fn transition_table_allows_named_edges_and_rejects_the_rest() {
        for state in STATES {
            for event in EVENTS {
                let got = apply_send(state, event);
                match legal(state, event) {
                    Some((next, allow)) => {
                        let step = got.unwrap_or_else(|_| panic!("{state} {event}"));
                        assert_eq!(step.state, next, "{state} {event}");
                        assert_eq!(step.allow_post, allow, "{state} {event}");
                        if state == "fetch_started" || next == "fetch_started" || matches!(next, "submitting" | "unknown" | "accepted") {
                            assert!(!step.allow_post, "{state} {event}");
                        }
                    }
                    None => assert!(got.is_err(), "{state} {event} must fail"),
                }
            }
        }
        assert!(apply_send("queued", "task_accepted").is_err());
        assert!(apply_send("nope", "key_present").is_err());
        assert!(apply_send("fetch_started", "bogus").is_err());
        let armed = apply_send("queued", "key_present").unwrap();
        assert!(armed.allow_post);
        let started = apply_send(armed.state, "fetch_started").unwrap();
        assert_eq!(started.state, "fetch_started");
        assert!(!started.allow_post);
        assert!(!apply_send("fetch_started", "key_present").unwrap().allow_post);
        assert!(!apply_send("submitting", "key_present").unwrap().allow_post);
        assert!(!apply_send("unknown", "key_present").unwrap().allow_post);
        assert!(!apply_send("accepted", "key_present").unwrap().allow_post);
    }
}
