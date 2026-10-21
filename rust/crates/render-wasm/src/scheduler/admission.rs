//! Metadata-only FIFO, lease lifecycle and immutable template ownership.
//! No JS values or compute tasks live here; tests cross the same interface.
#![forbid(unsafe_code)]
use super::error::RuntimeError;
use futures_channel::oneshot;
use render::ParsedTemplate;
use serde::Serialize;
use std::{
    collections::{HashMap, HashSet, VecDeque},
    sync::Arc,
};
const MAX_WAITERS: usize = 256;

type Admission = Result<u32, RuntimeError>;
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum LeasePhase {
    Reserved,
    Running,
    Draining,
}
struct Lease {
    owner: u32,
    key: String,
    phase: LeasePhase,
}
struct Waiter {
    owner: u32,
    key: String,
    reply: oneshot::Sender<Admission>,
}

/// Bytes one job adds to the runtime, split into the part every extra lane of
/// the same template pays again and the part those lanes hold once.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub(super) struct Peak {
    /// Peak bytes one job needs, as the runtime measures that job.
    pub total: u64,
    /// Slice of `total` a runtime keeps once however many lanes of the same
    /// template run concurrently. Never exceeds `total`.
    pub shared: u64,
}

impl Peak {
    /// Classifies one job. `shared` is clamped to `total` so a lane can never
    /// be credited bytes it does not hold.
    pub(super) fn new(total: u64, shared: u64) -> Self {
        Self {
            total,
            shared: shared.min(total),
        }
    }
    /// Bytes one more lane of this template adds on its own.
    fn lane_bytes(self) -> u64 {
        self.total - self.shared
    }
}

pub(super) struct State {
    threads: usize,
    budget: u64,
    external: u64,
    next: u32,
    leases: HashMap<u32, Lease>,
    waiters: VecDeque<Waiter>,
    closed: HashSet<u32>,
    templates: HashMap<String, (u32, Arc<ParsedTemplate>)>,
    peaks: HashMap<String, Peak>,
}

#[cfg(target_family = "wasm")]
pub(super) fn memory_bytes() -> u64 {
    (core::arch::wasm32::memory_size(0) as u64) * 65536
}
#[cfg(not(target_family = "wasm"))]
pub(super) fn memory_bytes() -> u64 {
    0
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Measurement {
    memory_bytes: u64,
    active: usize,
    queued: usize,
    occupied_bytes: u64,
    templates: usize,
    /// One flat byte count per template; JS reads a `Record<string, number>`.
    peaks: HashMap<String, u64>,
    threads: usize,
}

impl State {
    pub(super) fn new(threads: usize, budget: u64) -> Self {
        Self {
            threads,
            budget,
            external: 0,
            next: 0,
            leases: HashMap::new(),
            waiters: VecDeque::new(),
            closed: HashSet::new(),
            templates: HashMap::new(),
            peaks: HashMap::new(),
        }
    }
    fn next_id(&mut self) -> Result<u32, RuntimeError> {
        self.next = self.next.checked_add(1).ok_or(RuntimeError::IdsExhausted)?;
        Ok(self.next)
    }
    /// Reserved bytes of every live lane: the per-lane slice of each lease,
    /// plus one shared slice per distinct template those leases name.
    fn reserved_bytes(&self) -> Option<u64> {
        let mut shared: HashMap<&str, u64> = HashMap::new();
        let mut reserved = self.leases.values().try_fold(0_u64, |sum, lease| {
            let Some(peak) = self.peaks.get(&lease.key).copied() else {
                return Some(sum);
            };
            shared
                .entry(lease.key.as_str())
                .and_modify(|known| *known = (*known).max(peak.shared))
                .or_insert(peak.shared);
            sum.checked_add(peak.lane_bytes())
        })?;
        for slice in shared.into_values() {
            reserved = reserved.checked_add(slice)?;
        }
        Some(reserved)
    }
    fn dispatch(&mut self) {
        while let Some(head) = self.waiters.front() {
            // A dropped receiver must not strand an unknown FIFO head behind
            // busy work, and must never evict a live cached template.
            if head.reply.is_canceled() {
                self.waiters.pop_front();
                continue;
            }
            if self.leases.len() >= self.threads {
                break;
            }
            let peak = self
                .peaks
                .get(&head.key)
                .copied()
                .filter(|_| self.templates.contains_key(&head.key));
            // Unknown/evicted templates measure alone. A quiet runtime retains
            // the documented single-job progress exception to the soft budget.
            if !self.leases.is_empty() {
                if peak.is_none()
                    || self.leases.values().any(|lease| {
                        !self.peaks.contains_key(&lease.key)
                            || !self.templates.contains_key(&lease.key)
                    })
                {
                    break;
                }
                let required = self
                    .reserved_bytes()
                    .and_then(|reserved| reserved.checked_add(peak.unwrap().lane_bytes()))
                    .map(|reserved| memory_bytes().max(reserved))
                    .and_then(|bytes| bytes.checked_add(self.external));
                if required.is_none_or(|bytes| bytes > self.budget) {
                    break;
                }
            }
            let waiter = self.waiters.pop_front().unwrap();
            let id = match self.next_id() {
                Ok(id) => id,
                Err(error) => {
                    let _ = waiter.reply.send(Err(error));
                    continue;
                }
            };
            self.templates.retain(|key, _| {
                key == &waiter.key || self.leases.values().any(|lease| &lease.key == key)
            });
            self.leases.insert(
                id,
                Lease {
                    owner: waiter.owner,
                    key: waiter.key,
                    phase: LeasePhase::Reserved,
                },
            );
            if waiter.reply.send(Ok(id)).is_err() {
                self.leases.remove(&id);
            }
        }
    }
    pub(super) fn acquire(
        &mut self,
        owner: u32,
        key: String,
    ) -> Result<oneshot::Receiver<Admission>, RuntimeError> {
        if self.closed.contains(&owner) {
            return Err(RuntimeError::Cancelled);
        }
        self.dispatch();
        if self.waiters.len() >= MAX_WAITERS {
            return Err(RuntimeError::QueueFull);
        }
        let (reply, receive) = oneshot::channel();
        self.waiters.push_back(Waiter { owner, key, reply });
        self.dispatch();
        Ok(receive)
    }
    pub(super) fn acquired(&self, id: u32, owner: u32) -> bool {
        self.leases
            .get(&id)
            .is_some_and(|lease| lease.owner == owner && lease.phase != LeasePhase::Draining)
    }
    pub(super) fn start(&mut self, id: u32) -> Result<String, RuntimeError> {
        let lease = self.leases.get_mut(&id).ok_or(RuntimeError::LeaseExpired)?;
        match lease.phase {
            LeasePhase::Reserved => lease.phase = LeasePhase::Running,
            LeasePhase::Running => return Err(RuntimeError::LeaseBusy),
            LeasePhase::Draining => return Err(RuntimeError::Cancelled),
        }
        Ok(lease.key.clone())
    }
    pub(super) fn finish(&mut self, id: u32, peak: Option<Peak>) -> bool {
        let Some(lease) = self.leases.get_mut(&id) else {
            return false;
        };
        let valid = match lease.phase {
            LeasePhase::Reserved => return false,
            LeasePhase::Running => true,
            LeasePhase::Draining => false,
        };
        lease.phase = LeasePhase::Reserved;
        if let Some(peak) = peak {
            let key = lease.key.clone();
            self.record_peak(&key, peak);
        }
        if !valid {
            self.leases.remove(&id);
        }
        self.dispatch();
        valid
    }
    pub(super) fn release(&mut self, id: u32) {
        if let Some(lease) = self.leases.get_mut(&id) {
            match lease.phase {
                LeasePhase::Reserved => {
                    self.leases.remove(&id);
                }
                LeasePhase::Running | LeasePhase::Draining => lease.phase = LeasePhase::Draining,
            }
        }
        self.dispatch();
    }
    pub(super) fn dispose_owner(&mut self, owner: u32) {
        self.closed.insert(owner);
        let mut retained = VecDeque::new();
        for waiter in self.waiters.drain(..) {
            if waiter.owner == owner {
                let _ = waiter.reply.send(Err(RuntimeError::Cancelled));
            } else {
                retained.push_back(waiter);
            }
        }
        self.waiters = retained;
        self.leases.retain(|_, lease| {
            if lease.owner != owner {
                return true;
            }
            if lease.phase == LeasePhase::Reserved {
                return false;
            }
            lease.phase = LeasePhase::Draining;
            true
        });
        self.dispatch();
    }
    pub(super) fn set_external_bytes(&mut self, bytes: u64) {
        self.external = bytes;
        self.dispatch();
    }
    pub(super) fn template_id(&self, key: &str) -> Option<u32> {
        self.templates.get(key).map(|(id, _)| *id)
    }
    pub(super) fn retain_template(
        &mut self,
        key: String,
        template: Arc<ParsedTemplate>,
    ) -> Result<u32, RuntimeError> {
        if template.fingerprint().strip_prefix("sha256:")
            != Some(key.strip_prefix("sha256:").unwrap_or(&key))
        {
            return Err(RuntimeError::TemplateFingerprint);
        }
        let id = self.next_id()?;
        self.templates.insert(key, (id, template));
        Ok(id)
    }
    pub(super) fn begin_render(
        &mut self,
        lease: u32,
        template_id: u32,
    ) -> Result<(String, Arc<ParsedTemplate>, bool), RuntimeError> {
        let key = self
            .leases
            .get(&lease)
            .ok_or(RuntimeError::LeaseExpired)?
            .key
            .clone();
        let template = self
            .templates
            .get(&key)
            .filter(|(id, _)| *id == template_id)
            .ok_or(RuntimeError::TemplateMissing)?
            .1
            .clone();
        self.start(lease)?;
        let unknown = !self.peaks.contains_key(&key);
        Ok((key, template, unknown))
    }
    pub(super) fn record_peak(&mut self, key: &str, peak: Peak) {
        self.peaks
            .entry(key.into())
            .and_modify(|known| {
                known.total = known.total.max(peak.total);
                known.shared = known.shared.max(peak.shared);
            })
            .or_insert(peak);
    }
    pub(super) fn measure(&self) -> String {
        let memory = memory_bytes();
        serde_json::to_string(&Measurement {
            memory_bytes: memory,
            active: self.leases.len(),
            queued: self.waiters.len(),
            occupied_bytes: memory.max(self.reserved_bytes().unwrap_or(u64::MAX)),
            templates: self.templates.len(),
            peaks: self
                .peaks
                .iter()
                .map(|(key, peak)| (key.clone(), peak.total))
                .collect(),
            threads: self.threads,
        })
        .expect("runtime measurement contains only finite integers and string keys")
    }
}

#[cfg(test)]
#[path = "admission_tests.rs"]
mod tests;
