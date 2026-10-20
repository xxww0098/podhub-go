export type DiagnosticTimer = ReturnType<typeof setTimeout>
export type DiagnosticClock = {
  now: () => number
  setTimer: (callback: () => void, ms: number) => DiagnosticTimer
  clearTimer: (timer: DiagnosticTimer) => void
}
export type DiagnosticBatch = Readonly<{ ids: readonly string[]; attempt: number }>
declare const diagnosticActionBrand: unique symbol
/** Mint once per explicit gesture; retaining the label alone cannot reopen its window. */
export type DiagnosticPublishAction = Readonly<{ actionId: string; [diagnosticActionBrand]: true }>

/** One action, at most 100 unique IDs / five batches / three attempts per batch / 120 seconds. */
export function createDiagnosticWindow(
  actionId: string, signal: AbortSignal, clock: DiagnosticClock, onClose: () => void, timeoutMs = 120_000,
) {
  const controller = new AbortController()
  const deadline = clock.now() + Math.min(120_000, Math.max(0, Number.isFinite(timeoutMs) ? timeoutMs : 0))
  const claimed = new Set<string>()
  const batches: { ids: string[]; attempts: number }[] = []
  let timer: DiagnosticTimer | undefined
  const close = () => {
    if (controller.signal.aborted) return
    controller.abort()
    signal.removeEventListener("abort", close)
    if (timer !== undefined) clock.clearTimer(timer)
    onClose()
  }
  const isOpen = () => {
    if (clock.now() >= deadline) close()
    return !controller.signal.aborted
  }
  const nextBatch = (eligible: readonly string[]): DiagnosticBatch | null => {
    if (!isOpen()) return null
    const pending = new Set(eligible)
    let batch = batches.find((candidate) => candidate.attempts < 3 && candidate.ids.some((id) => pending.has(id)))
    if (!batch && batches.length < 5) {
      const ids = [...pending].filter((id) => !claimed.has(id)).slice(0, Math.min(20, 100 - claimed.size))
      if (ids.length) {
        batch = { ids, attempts: 0 }
        ids.forEach((id) => claimed.add(id))
        batches.push(batch)
      }
    }
    if (!batch) return null
    batch.attempts++
    return { ids: batch.ids.filter((id) => pending.has(id)), attempt: batch.attempts }
  }
  signal.addEventListener("abort", close, { once: true })
  timer = clock.setTimer(close, Math.max(0, deadline - clock.now()))
  if (signal.aborted) close()
  return { actionId, deadline, signal: controller.signal, close, isOpen, nextBatch }
}
