//! Row lifecycle state machine, slice 1: the invalidation overlay.
//!
//! A row carries three orthogonal state columns (content, media, submission).
//! Edits raise [`InvalidationTrigger`] events; [`transition`] folds one event
//! into the pending column overlay. `None` keeps the stored column,
//! `Some(..)` resets it. The table is pure (no SQL, no clock) and shared by
//! the browser (WASM) and Cloud, which applies the overlay to the stored row.

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum InvalidationTrigger {
    Prompt,
    Category,
    Psd,
    Source,
    Video,
    ManualField,
    Store,
}

/// Column overlay accumulated from one or more triggers.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct InvalidationPatch {
    pub content_state: Option<&'static str>,
    pub media_state: Option<&'static str>,
    pub submission_state: Option<&'static str>,
}

/// Overlay a single event writes: (content, media, submission).
const fn event_overlay(
    event: InvalidationTrigger,
) -> (
    Option<&'static str>,
    Option<&'static str>,
    Option<&'static str>,
) {
    use InvalidationTrigger::*;
    match event {
        Prompt => (Some("draft"), None, Some("none")),
        Category | Store => (Some("draft"), Some("pending"), Some("none")),
        Source => (Some("draft"), Some("pending"), None),
        Psd | Video => (None, Some("pending"), None),
        ManualField => (None, None, None),
    }
}

/// Fold one event into the overlay. Only columns the event resets are written.
pub fn transition(state: InvalidationPatch, event: InvalidationTrigger) -> InvalidationPatch {
    let (content, media, submission) = event_overlay(event);
    InvalidationPatch {
        content_state: content.or(state.content_state),
        media_state: media.or(state.media_state),
        submission_state: submission.or(state.submission_state),
    }
}

impl InvalidationPatch {
    pub fn from_triggers(triggers: &[InvalidationTrigger]) -> Self {
        triggers.iter().copied().fold(Self::default(), transition)
    }
}

#[cfg(test)]
mod tests {
    use super::InvalidationTrigger::*;
    use super::*;

    const ALL: [InvalidationTrigger; 7] =
        [Prompt, Category, Psd, Source, Video, ManualField, Store];

    fn p(
        c: Option<&'static str>,
        m: Option<&'static str>,
        s: Option<&'static str>,
    ) -> InvalidationPatch {
        InvalidationPatch {
            content_state: c,
            media_state: m,
            submission_state: s,
        }
    }

    #[test]
    fn every_event_keeps_the_existing_column_contract() {
        let d = Some("draft");
        let pe = Some("pending");
        let n = Some("none");
        let expected = [
            (Prompt, p(d, None, n)),
            (Category, p(d, pe, n)),
            (Psd, p(None, pe, None)),
            (Source, p(d, pe, None)),
            (Video, p(None, pe, None)),
            (ManualField, p(None, None, None)),
            (Store, p(d, pe, n)),
        ];
        for (event, want) in expected {
            assert_eq!(
                transition(InvalidationPatch::default(), event),
                want,
                "{event:?}"
            );
            assert_eq!(
                InvalidationPatch::from_triggers(&[event]),
                want,
                "{event:?}"
            );
        }
    }

    #[test]
    fn empty_event_list_does_not_write_any_dimension() {
        assert_eq!(
            InvalidationPatch::from_triggers(&[]),
            InvalidationPatch::default()
        );
    }

    #[test]
    fn omitted_dimensions_preserve_existing_values() {
        let prior = p(Some("x-content"), Some("x-media"), Some("unknown"));
        assert_eq!(transition(prior, ManualField), prior);
        assert_eq!(
            transition(prior, Psd),
            p(Some("x-content"), Some("pending"), Some("unknown"))
        );
        assert_eq!(transition(prior, Source).submission_state, Some("unknown"));
        assert_eq!(transition(prior, Prompt).submission_state, Some("none"));
    }

    #[test]
    fn events_are_idempotent_and_order_independent() {
        let values = [None, Some("draft"), Some("legacy")];
        for c in values {
            for m in values {
                for s in values {
                    let start = p(c, m, s);
                    for a in ALL {
                        let once = transition(start, a);
                        assert_eq!(transition(once, a), once, "idempotent {a:?}");
                        for b in ALL {
                            assert_eq!(
                                transition(transition(start, a), b),
                                transition(transition(start, b), a),
                                "commutes {a:?} {b:?}"
                            );
                        }
                    }
                }
            }
        }
    }
}
