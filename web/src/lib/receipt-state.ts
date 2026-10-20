/**
 * The state vocabulary. Every status string the Rust host can hand the renderer
 * resolves to exactly one of six tones, and the renderer never invents a seventh.
 *
 *   idle     nothing has been claimed yet
 *   flight   in motion; the outcome is not yet observable
 *   good     a truthful terminal success
 *   bad      a truthful terminal failure or a live conflict
 *   unknown  Result Unknown — not an outcome and not an error
 *   attest   a human asserted the outcome; the ledger did not prove it
 *
 * `unknown` is deliberately not a warning tone. It is the only tone that also
 * carries a drawn hatch, because a state that forbids blind redispatch must not
 * be mistakable for a mild problem.
 */
export type StateTone = "idle" | "flight" | "good" | "bad" | "unknown" | "attest"

const TONES: Record<string, StateTone> = {
  // OperationStatus / ReceiptStatus
  queued: "idle",
  dispatching: "flight",
  succeeded: "good",
  reconciled: "good",
  failed: "bad",
  conflict: "bad",
  result_unknown: "unknown",
  still_unknown: "unknown",
  unknown: "unknown",
  operator_attested: "attest",

  // ListingLifecycleState
  draft: "idle",
  validated: "flight",
  planned: "flight",

  // SecretRefStatus
  present: "good",
  absent: "idle",
  unavailable: "bad",
  missing: "bad",

  // StoreStatus
  healthy: "good",
  unhealthy: "bad",

  // ImportPhase
  inspected: "idle",
  executed: "flight",
  verified: "good",
  verification_failed: "bad",
  committed: "good",

  // ReconcileEntryOutcome
  skipped: "idle",

  // FBS posting status (发货)
  awaiting_packaging: "flight",
  awaiting_deliver: "flight",
  awaiting_registration: "flight",
  awaiting_approve: "flight",
  delivering: "flight",
  driver_pickup: "flight",
  sent_by_seller: "flight",
  delivered: "good",
  cancelled: "bad",
  not_accepted: "bad",
  arbitration: "unknown",
  client_arbitration: "unknown",

  // 发货 deadline / packing / label projections. Colours stay inside the six
  // tones; these keys exist so a screen never switches on a status string.
  deadline_overdue: "bad",
  deadline_approaching: "attest",
  deadline_ok: "idle",
  deadline_unknown: "unknown",
  unpacked: "idle",
  packed: "good",
  label_not_ready: "idle",
  label_ready: "flight",
  label_unknown: "unknown",

  // plain booleans projected as words
  yes: "good",
  no: "idle",

  // Ozon FBO/FBS return visual.status.sys_name
  WaitingConfirmation: "flight",
  MovingToReturnPlace: "flight",
  ArrivedAtReturnPlace: "flight",
  WaitingForSeller: "flight",
  ReceivedBySeller: "good",
  ReturnedToSeller: "good",
  PartialCompensation: "attest",
  Compensated: "good",
  CompensationPaid: "good",
  Utilization: "attest",
  Utilized: "good",
  Cancelled: "bad",
  CancelledWithCompensation: "attest",
  DisputeOpened: "unknown",

  // Ozon rFBS cancellation state.state
  ON_APPROVAL: "flight",
  APPROVED: "good",
  REJECTED: "bad",

  // Inbound supply-order states (Ozon short form; Rust strips ORDER_STATE_)
  DATA_FILLING: "flight",
  READY_TO_SUPPLY: "idle",
  ACCEPTED_AT_SUPPLY_WAREHOUSE: "flight",
  IN_TRANSIT: "flight",
  ACCEPTANCE_AT_STORAGE_WAREHOUSE: "flight",
  REPORTS_CONFIRMATION_AWAITING: "attest",
  REPORT_REJECTED: "bad",
  COMPLETED: "good",
  REJECTED_AT_SUPPLY_WAREHOUSE: "bad",
  CANCELLED: "idle",
  OVERDUE: "bad",
  UNSPECIFIED: "unknown",

  // Ozon 口碑 statuses. These are Seller facts, not Receipt states; they still
  // resolve through this table so a screen cannot invent a seventh tone.
  UNPROCESSED: "idle",
  unprocessed: "idle",
  PROCESSED: "good",
  processed: "good",
  NEW: "flight",
  VIEWED: "idle",
  Opened: "flight",
  Closed: "idle",

  // Redeem-code ledger (one-shot credentials). unused is inventory that has
  // not been claimed; redeemed is the only truthful success; expired is time
  // running out, not an operator error; revoked is an explicit kill.
  unused: "idle",
  redeemed: "good",
  expired: "unknown",
  revoked: "bad",
}

export function toneFor(status: string): StateTone {
  return TONES[status] ?? "idle"
}

/** Tailwind classes per tone. Soft fill, tinted ink, hairline of the same hue. */
export const TONE_CHIP: Record<StateTone, string> = {
  idle: "bg-st-idle-soft text-st-idle-ink border-st-idle/25",
  flight: "bg-st-flight-soft text-st-flight-ink border-st-flight/30",
  good: "bg-st-good-soft text-st-good-ink border-st-good/30",
  bad: "bg-st-bad-soft text-st-bad-ink border-st-bad/30",
  unknown: "bg-st-unknown-soft text-st-unknown-ink border-st-unknown/35 hatch-unknown",
  attest: "bg-st-attest-soft text-st-attest-ink border-st-attest/30",
}

/** The solid dot / tile fill, for identity tiles and rail nodes. */
export const TONE_SOLID: Record<StateTone, string> = {
  idle: "bg-st-idle",
  flight: "bg-st-flight",
  good: "bg-st-good",
  bad: "bg-st-bad",
  unknown: "bg-st-unknown",
  attest: "bg-st-attest",
}

/**
 * Prose tint for a row's own message. A Result Unknown row's message must never
 * be red: the tone that owns the row owns everything said about it, or the chip
 * says "not a failure" while the sentence beside it says "failure".
 */
export const TONE_INK: Record<StateTone, string> = {
  idle: "text-muted-foreground",
  flight: "text-st-flight-ink",
  good: "text-st-good-ink",
  bad: "text-st-bad-ink",
  unknown: "text-st-unknown-ink",
  attest: "text-st-attest-ink",
}

export const TONE_TILE: Record<StateTone, string> = {
  idle: "bg-st-idle-soft text-st-idle-ink",
  flight: "bg-st-flight-soft text-st-flight-ink",
  good: "bg-st-good-soft text-st-good-ink",
  bad: "bg-st-bad-soft text-st-bad-ink",
  unknown: "bg-st-unknown-soft text-st-unknown-ink",
  attest: "bg-st-attest-soft text-st-attest-ink",
}
