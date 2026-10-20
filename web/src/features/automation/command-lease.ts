/**
 * Command-lease keeper for the automation runtime.
 *
 * A claim lease is execution ownership, not tab liveness: the runtime
 * heartbeat keeps `automation_runtimes` live, while this loop keeps the
 * command's `claim_expires_at` ahead of the clock and turns the renewal reply
 * into a control signal (`continue` | `cancel` | `lost`). Renewal silence is
 * never permission: if the local deadline passes without a confirmed
 * extension, the lease is treated as lost so the executor stops starting new
 * side effects while in-flight paid work settles normally.
 */

import { createLeaseScheduler, tabLeaseScheduler, type LeaseScheduler } from "./lease-scheduler"

export type LeaseControl = "continue" | "cancel" | "lost"

export type LeaseClaim = { operationId: string; claimEpoch: number }

export type LeaseReply = { operationId: string; control: LeaseControl; leaseSeconds: number }

export type CommandLease = {
  /** The last control verdict the server confirmed. */
  control: () => LeaseControl
  stop: () => void
}

type Renew = (runtimeId: string, claims: LeaseClaim[]) => Promise<LeaseReply[]>

type BucketItem = {
  claim: LeaseClaim
  renew: Renew
  resolve: (replies: LeaseReply[]) => void
  reject: (reason: unknown) => void
}

const renewBuckets = new Map<string, BucketItem[]>()

/** Same-turn renewals for one runtime become one request. */
function renewTogether(runtimeId: string, claim: LeaseClaim, renew: Renew): Promise<LeaseReply[]> {
  return new Promise((resolve, reject) => {
    const bucket = renewBuckets.get(runtimeId) ?? []
    bucket.push({ claim, renew, resolve, reject })
    renewBuckets.set(runtimeId, bucket)
    if (bucket.length > 1) return
    queueMicrotask(() => {
      const waiting = renewBuckets.get(runtimeId) ?? []
      renewBuckets.delete(runtimeId)
      if (waiting.length === 0) return
      waiting[0]!.renew(runtimeId, waiting.map((item) => item.claim)).then(
        (replies) => { for (const item of waiting) item.resolve(replies) },
        (reason) => { for (const item of waiting) item.reject(reason) },
      )
    })
  })
}

export function keepCommandLease(input: {
  runtimeId: string
  operationId: string
  claimEpoch: number
  leaseSeconds: number
  renew: Renew
  onControl: (control: "cancel" | "lost") => void
  /** Injectable timer for tests. Production uses the tab scheduler. */
  schedule?: (run: () => void, ms: number) => () => void
  /** Share a scheduler across leases. Overrides `schedule` when set. */
  scheduler?: LeaseScheduler
  now?: () => number
}): CommandLease {
  const now = input.now ?? (() => Date.now())
  const scheduler = input.scheduler
    ?? (input.schedule ? createLeaseScheduler(input.schedule) : tabLeaseScheduler())
  const intervalMs = Math.max(1, (input.leaseSeconds * 1000) / 3)
  let state: LeaseControl = "continue"
  let until = now() + input.leaseSeconds * 1000
  let active = true
  const stopRenew = scheduler.keep(
    `command:${input.runtimeId}:${input.operationId}`,
    intervalMs,
    () => tick(),
  )
  const stop = () => {
    active = false
    stopRenew()
  }
  const report = (control: "cancel" | "lost") => {
    if (state !== "continue") return
    state = control
    if (control === "lost") stop()
    input.onControl(control)
  }
  const tick = async () => {
    if (!active) return
    try {
      const replies = await renewTogether(input.runtimeId, {
        operationId: input.operationId,
        claimEpoch: input.claimEpoch,
      }, input.renew)
      if (!active) return
      const reply = replies.find((item) => item.operationId === input.operationId)
      if (!reply || reply.control === "lost") {
        report("lost")
        return
      }
      if (reply.control === "cancel") {
        report("cancel")
        return
      }
      until = now() + (reply.leaseSeconds > 0 ? reply.leaseSeconds : input.leaseSeconds) * 1000
    } catch {
      // Bounded retry: the last confirmed deadline still fences ownership.
      if (active && now() >= until) report("lost")
    }
  }
  return { control: () => state, stop }
}
