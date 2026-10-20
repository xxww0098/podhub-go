/** Per-view volatile reads: no global/session cache and no Workspace mutation. */
export type ObservationReadState<T> = { data?: T; loading: boolean; failed: boolean }

export class ObservationResource<T> {
  private state: ObservationReadState<T> = { loading: false, failed: false }
  private version = 0
  private listeners = new Set<() => void>()
  readonly snapshot = () => this.state
  readonly subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  private publish(state: ObservationReadState<T>) {
    this.state = state
    for (const listener of this.listeners) listener()
  }

  /** Scope/filter changes invalidate reads and clear all previously painted data. */
  invalidate() {
    this.version += 1
    this.publish({ loading: false, failed: false })
  }

  async load(
    request: () => Promise<T>,
    feedback: { success: () => void; failure: (reason: unknown) => void },
    merge?: (previous: T | undefined, incoming: T) => T,
  ): Promise<void> {
    const version = ++this.version
    const previous = merge ? this.state.data : undefined
    this.publish({ data: previous, loading: true, failed: false })
    try {
      const next = await request()
      if (version !== this.version) return
      this.publish({ data: merge ? merge(previous, next) : next, loading: false, failed: false })
      feedback.success()
    } catch (reason) {
      if (version !== this.version) return
      this.publish({ data: previous, loading: false, failed: true })
      feedback.failure(reason)
    }
  }
}
