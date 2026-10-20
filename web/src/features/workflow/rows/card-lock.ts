// One write tab per plan (I6). See specs/browser-owned-listing/slices/09-row-store.md.
//
// A tab first tries to grab `listing-card:{workspaceUuid}:{cardId}` via the
// Web Locks API without waiting (`ifAvailable: true`). Whoever gets it stays
// the writer until `release()`. Everyone else is read-only from the start,
// and a second, blocking request is queued in the background so that tab is
// promoted automatically the moment the writer releases — no polling, no
// BroadcastChannel needed for the handoff itself.

export type CardLockScope = { workspaceUuid: string; cardId: string }

export type CardLock = {
  readonly writable: boolean
  /** A queued request failed; the instance remains read-only until reopened. */
  readonly error?: unknown
  /** Fires when a queued reader gains write access or its request fails. No immediate callback for an already held lock. */
  onChange(fn: () => void): () => void
  /** Releases the held lock, or cancels the queued background request if still read-only. Idempotent. */
  release(): void
}

function lockName(scope: CardLockScope): string {
  return `listing-card:${scope.workspaceUuid}:${scope.cardId}`
}

export function acquireCardLock(
  scope: CardLockScope,
  locks: Pick<LockManager, "request"> | null = globalThis.navigator?.locks ?? null,
): Promise<CardLock> {
  if (!locks) {
    return Promise.reject(new Error("Web Locks API is unavailable: local listing rows cannot be opened for writing"))
  }

  const name = lockName(scope)
  return new Promise<CardLock>((resolveAcquire, rejectAcquire) => {
    let writable = false
    let error: unknown
    let releaseHeldLock: () => void = () => {}
    let closed = false
    const backgroundAbort = new AbortController()
    const waiters = new Set<() => void>()

    function becomeWritable(release: () => void) {
      if (closed) {
        release()
        return
      }
      writable = true
      releaseHeldLock = release
      const fns = [...waiters]
      waiters.clear()
      for (const fn of fns) fn()
    }

    const lock: CardLock = {
      get writable() {
        return writable
      },
      get error() {
        return error
      },
      onChange(fn) {
        if (writable) return () => {} // already writable; no queued outcome to observe
        waiters.add(fn)
        return () => waiters.delete(fn)
      },
      release() {
        if (closed) return
        closed = true
        writable = false
        waiters.clear()
        backgroundAbort.abort()
        releaseHeldLock()
      },
    }

    locks
      .request(name, { ifAvailable: true }, (granted) => {
        if (granted) {
          return new Promise<void>((resolveRelease) => {
            becomeWritable(resolveRelease)
            resolveAcquire(lock)
          })
        }
        // Not free right now: this tab starts read-only. Queue a blocking
        // request in the background; it resolves once the current writer
        // releases, at which point this instance flips to writable.
        resolveAcquire(lock)
        locks
          .request(
            name,
            { signal: backgroundAbort.signal },
            () => new Promise<void>((resolveRelease) => becomeWritable(resolveRelease)),
          )
          .catch((cause: unknown) => {
            if (closed) return
            error = cause // fail closed; reopening is the explicit retry
            writable = false
            releaseHeldLock()
            const fns = [...waiters]
            waiters.clear()
            for (const fn of fns) fn()
          })
        return undefined
      })
      .catch(rejectAcquire)
  })
}
