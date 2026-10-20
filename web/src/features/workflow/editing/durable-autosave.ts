import { reportError } from "@/lib/diag-log"

export type DurableAutosavePhase = "idle" | "dirty" | "saving" | "saved" | "error"

/**
 * Serializes durable writes and keeps the visible phase tied to the newest
 * requested revision. A successful older write can never mark newer edits as
 * saved; the drain immediately persists the latest snapshot instead.
 */
export class DurableAutosave<Payload, Result> {
  private latest: Payload | undefined
  private requestedRevision = 0
  private persistedRevision = 0
  private tail: Promise<unknown> = Promise.resolve()
  private generation = 0
  private disposed = false

  constructor(
    private readonly save: (payload: Payload) => Promise<Result>,
    private readonly onSaved: (result: Result) => void,
    private readonly onPhaseChange: (phase: DurableAutosavePhase) => void,
  ) {}

  reset(payload?: Payload, phase: "idle" | "saved" = "idle") {
    this.generation += 1
    this.latest = payload
    this.requestedRevision = 0
    this.persistedRevision = 0
    this.onPhaseChange(phase)
  }

  /**
   * The row/draft is gone for good: queued saves must not fire. A save already
   * in flight cannot be recalled, but its counters and phase stay fenced off
   * by the generation bump.
   */
  dispose() {
    this.disposed = true
    this.generation += 1
  }

  markDirty(payload: Payload) {
    if (this.disposed) return
    this.latest = payload
    this.requestedRevision += 1
    this.onPhaseChange("dirty")
  }

  /** Update host-assigned coordinates without inventing a new user edit. */
  rebaseLatest(update: (payload: Payload) => Payload) {
    if (this.latest) this.latest = update(this.latest)
  }

  hasPendingChanges() {
    return !this.disposed && this.persistedRevision < this.requestedRevision
  }

  /**
   * Serialised drain queue. The generation is read when the drain starts, not
   * when `flush()` was called: a reset between the two must not let a stale
   * drain report the new generation's edits as saved.
   */
  flush(): Promise<boolean> {
    if (this.disposed) return Promise.resolve(false)
    const result = this.tail.then(() => this.drain(this.generation))
    this.tail = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }

  private async drain(generation: number): Promise<boolean> {
    // The generation argument is read when the queued thunk finally runs, so a
    // drain that only starts after `dispose()` sees the post-dispose value and
    // clears the fences below. Disposal is the one fact that must stop a write
    // that never started.
    if (this.disposed) return false
    while (this.generation === generation && this.persistedRevision < this.requestedRevision) {
      const payload = this.latest
      if (!payload) return true
      const revision = this.requestedRevision
      this.onPhaseChange("saving")
      try {
        const result = await this.save(payload)
        // The server did persist that payload, so the receipt still lands —
        // `onSaved` carries its own edit/scope guards and adopts host-assigned
        // ids via `rebaseLatest`. But a stale generation never touches this
        // generation's counters or phase: newer edits stay unsaved until their
        // own save returns.
        if (this.generation !== generation) {
          this.onSaved(result)
          return false
        }
        this.persistedRevision = revision
        this.onSaved(result)
      } catch (reason) {
        if (this.generation !== generation) return false
        reportError("[durable-autosave]", reason)
        this.onPhaseChange("error")
        return false
      }
    }
    if (this.generation !== generation) return false
    this.onPhaseChange("saved")
    return true
  }
}
