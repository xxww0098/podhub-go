//! Portable admission and completion logic; browser adaptation needs `threads`.
mod admission;
mod compute;
mod error;

#[cfg(feature = "threads")]
mod bindings;
