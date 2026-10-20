//! One state model, exercised natively without enabling the browser adapter.
mod admission;
mod compute;
mod error;

#[cfg(feature = "threads")]
mod runtime;
