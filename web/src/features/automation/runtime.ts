/**
 * The authorized browser execution endpoint (MCP-02).
 *
 * An external agent never drives this tab's APIs: it enqueues durable
 * commands through `/mcp`, and this loop — mounted once at the authenticated
 * shell — claims them through `/api/automation/commands/claim`. The claim is
 * a server-side lease (`claimEpoch` fences every write-back and the prepare
 * boundary), renewed while a command runs, so two tabs or a refresh can never
 * execute the same command twice.
 *
 * Scope rules the channel keeps:
 * - Commands are scoped by their Workspace + grant. The runtime only claims
 *   under runtimes it registered for the *current* Workspace; an account or
 *   Workspace switch `stop()`s this loop and every claim epoch dies with the
 *   old session.
 * - A paid boundary re-proves the command: `runRows` sends
 *   `X-Automation-Operation` on `/api/listing/rows/{id}/prepare`, and Cloud
 *   checks row coverage, claim liveness and the grant's live actions there —
 *   never trusting this process to have kept the truth.
 * - A local asset is verified against the staged bytes *before* any render
 *   quota is spent; a missing one settles `local_asset_unavailable`.
 * - Closing the browser ends execution. Nothing here pretends a closed tab
 *   keeps rendering: claimed commands simply time out and requeue.
 */

import { request } from "@/api/client"
import { route } from "@/api/routes"
import { notifyCommandError } from "@/lib/notify"
import { RENDERER_CONTRACT_VERSION } from "@/features/workflow/prepare/media-job"
import { requestStop } from "@/features/workflow/prepare/execution-context"
import { createActionLanes } from "./action-lane"
import { keepCommandLease, type LeaseClaim, type LeaseReply } from "./command-lease"
import { tabLeaseScheduler } from "./lease-scheduler"

const HEARTBEAT_MS = 20_000
const POLL_IDLE_MS = 3_000
const POLL_BUSY_MS = 8_000
const POLL_ERROR_MS = 15_000
// One poll can take a mix of actions. Each action has its own lane, so a long
// prepare does not hold an import (or the next poll) for its whole duration.
const CLAIM_LIMIT = 4
const MAX_OUTSTANDING = 4
const actionLanes = createActionLanes(2)
// All grant runtimes created by this tab share the identity used by the
// server's asset-holder check; a different tab gets a fresh nonce.
const TAB_ID = crypto.randomUUID()

type GrantView = {
  id: string
  actions: string[]
  expiresAtMs?: number
  revokedAtMs?: number
}

type ClaimedCommand = {
  operationId: string
  action: string
  clientRequestId: string
  claimEpoch: number
  payload: Record<string, unknown>
  cancelRequested: boolean
}

type Claimed = {
  commands: ClaimedCommand[]
  leaseSeconds: number
}

type RuntimeHandle = {
  runtimeId: string
  leaseSeconds: number
}

function isLiveGrant(grant: GrantView): boolean {
  if (grant.revokedAtMs) return false
  if (grant.expiresAtMs && grant.expiresAtMs <= Date.now()) return false
  return true
}

async function listGrants(): Promise<GrantView[]> {
  const data = await request<{ grants: GrantView[] }>(
    "GET",
    route("automationGrants"),
    undefined,
    {},
    10_000,
  )
  return data.grants
}

async function registerRuntime(grantId: string, label: string): Promise<RuntimeHandle> {
  const data = await request<{ runtime: { id: string }, claimLeaseSeconds: number }>(
    "POST",
    route("automationRuntimes"),
    { grantId, label, rendererContract: RENDERER_CONTRACT_VERSION },
    {},
    10_000,
  )
  return { runtimeId: data.runtime.id, leaseSeconds: data.claimLeaseSeconds }
}

async function heartbeat(runtimeId: string): Promise<void> {
  await request(
    "POST",
    route("automationRuntimesByIdHeartbeat", { id: runtimeId }),
    {},
    {},
    10_000,
  )
}

async function deregister(runtimeId: string): Promise<void> {
  await request(
    "POST",
    route("automationRuntimesByIdDeregister", { id: runtimeId }),
    {},
    {},
    5_000,
  )
}

async function claimCommands(runtimeId: string, limit: number): Promise<Claimed> {
  return request<Claimed>(
    "POST",
    route("automationCommandsClaim"),
    { runtimeId, limit },
    {},
    15_000,
  )
}

async function renewCommands(runtimeId: string, claims: LeaseClaim[]): Promise<LeaseReply[]> {
  const data = await request<{
    leases: Array<{ operationId: string, control: string, leaseSeconds: number }>
  }>(
    "POST",
    route("automationCommandsRenew"),
    { runtimeId, claims },
    {},
    10_000,
  )
  return data.leases.map((lease) => ({
    operationId: lease.operationId,
    control: lease.control === "cancel" ? "cancel" : lease.control === "lost" ? "lost" : "continue",
    leaseSeconds: lease.leaseSeconds,
  }))
}

async function settleCommand(
  operationId: string,
  claimEpoch: number,
  status: "completed" | "failed" | "canceled",
  result?: Record<string, unknown>,
  error?: Record<string, unknown>,
): Promise<{ accepted: boolean }> {
  return request(
    "POST",
    route("automationCommandsByIdSettle", { id: operationId }),
    { claimEpoch, status, result, error },
    {},
    10_000,
  )
}

/**
 * One claimed command's lifecycle: a lease keeper renews execution ownership
 * while the command runs, mid-run progress write-backs deliver late cancels,
 * and exactly one settle closes it. The lease — not the runtime heartbeat —
 * is what proves this tab may keep working: renewal replies `continue` |
 * `cancel` | `lost`, and anything else stops *new* side effects before the
 * next boundary while in-flight paid work still settles.
 */
async function runCommand(
  command: ClaimedCommand,
  stopped: () => boolean,
  runtimeId: string,
  leaseSeconds: number,
): Promise<void> {
  const { operationId, claimEpoch } = command
  const rowIds = commandActionRows(command)
  let lost = false
  let cancelled = command.cancelRequested
  const stopRows = () => {
    if (rowIds.length > 0) requestStop(rowIds)
  }
  const lease = keepCommandLease({
    runtimeId,
    operationId,
    claimEpoch,
    leaseSeconds,
    renew: renewCommands,
    onControl: (control) => {
      if (control === "lost") lost = true
      if (control === "cancel") cancelled = true
      stopRows()
    },
  })
  let laneHeld = false
  if (cancelled || stopped()) {
    lease.stop()
    // A rejected early settle must not become an unhandled rejection — the
    // cancellation itself already succeeded locally.
    await settleCommand(operationId, claimEpoch, "canceled").catch(() => undefined)
    return
  }
  await actionLanes.take(command.action)
  laneHeld = true
  if (cancelled || stopped()) {
    actionLanes.free(command.action)
    laneHeld = false
    lease.stop()
    await settleCommand(operationId, claimEpoch, "canceled").catch(() => undefined)
    return
  }
  let settled = false
  try {
    const result = await dispatch(command)
    if (lost) return
    const status = cancelled || result.cancelled ? "canceled" : result.failed ? "failed" : "completed"
    // The settle runs after the outcome is known: a failed settle write must
    // report its own error, not fall into the catch below and reclassify a
    // completed command as dispatch-failed.
    settled = true
    await settleCommand(operationId, claimEpoch, status, result.body, result.errorBody)
  } catch (reason) {
    if (settled) {
      // The command already reached its terminal state locally; a failed
      // settle write here is a lost record, not a dispatch failure.
      return
    }
    if (lost) return
    // A dead lease is a normal outcome — a newer claim owns the command now.
    await settleCommand(operationId, claimEpoch, "failed", undefined, {
      code: "command_dispatch_failed",
      message: reason instanceof Error ? reason.message : String(reason),
    }).catch(() => undefined)
  } finally {
    if (laneHeld) actionLanes.free(command.action)
    lease.stop()
  }
}

function commandActionRows(command: ClaimedCommand): string[] {
  const ids = command.payload["rowIds"]
  return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === "string") : []
}

type CommandResult = {
  cancelled?: boolean
  failed?: boolean
  body?: Record<string, unknown>
  errorBody?: Record<string, unknown>
}

/**
 * No action has a runtime handler: `listing_prepare` and `assets_import` read
 * and wrote cloud listing rows and were retired with the Task/MCP row path
 * (browser-owned-listing D4), so a claimed command always settles
 * `unknown_action`. Code Mode no longer exposes methods that enqueue those actions;
 * this browser endpoint can settle already persisted legacy commands without
 * claiming that a render or listing preparation took place.
 */
async function dispatch(command: ClaimedCommand): Promise<CommandResult> {
  return {
    failed: true,
    errorBody: { code: "unknown_action", message: `no runtime handler for ${command.action}` },
  }
}

/**
 * The shell-mounted loop. One runtime is registered per live grant — the
 * grant binding is what scopes which commands this tab may ever see — then
 * claims with bounded backoff until `stop()`. Refresh-safe by construction:
 * a reloaded tab registers anew and reclaims its dead claims after the lease
 * lapses.
 */
export function startAutomationRuntime(input: {
  workspaceId: number
  onError?: (reason: unknown) => void
}): { stop: () => void } {
  let stopped = false
  let polling = false
  let pollSoon = false
  let pollTimer = 0
  let outstanding = 0
  const runtimes = new Map<string, { handle: RuntimeHandle, stopBeat: () => void }>()
  const workspaceId = input.workspaceId

  const schedulePoll = (delay: number) => {
    window.clearTimeout(pollTimer)
    if (stopped) return
    pollTimer = window.setTimeout(() => void pollAll(), delay)
  }

  const tearDown = async (grantId: string) => {
    const entry = runtimes.get(grantId)
    if (!entry) return
    runtimes.delete(grantId)
    entry.stopBeat()
    await deregister(entry.handle.runtimeId).catch(() => undefined)
  }

  const pollAll = async () => {
    if (polling || stopped) return
    polling = true
    pollSoon = false
    let delay = POLL_BUSY_MS
    try {
      for (const [grantId, entry] of runtimes) {
        if (stopped) break
        if (!runtimes.has(grantId)) continue
        const room = MAX_OUTSTANDING - outstanding
        if (room <= 0) {
          delay = POLL_IDLE_MS
          break
        }
        const claimed = await claimCommands(entry.handle.runtimeId, Math.min(CLAIM_LIMIT, room))
        if (stopped) break
        if (!runtimes.has(grantId)) continue
        if (claimed.commands.length > 0) delay = POLL_IDLE_MS
        for (const command of claimed.commands) {
          outstanding += 1
          void runCommand(
            command,
            () => stopped || !runtimes.has(grantId),
            entry.handle.runtimeId,
            entry.handle.leaseSeconds,
          ).finally(() => { outstanding -= 1 })
        }
      }
    } catch (reason) {
      delay = POLL_ERROR_MS
      input.onError?.(reason)
    } finally {
      polling = false
      const wait = pollSoon ? 0 : delay
      pollSoon = false
      if (!stopped && runtimes.size > 0) schedulePoll(wait)
    }
  }

  const sync = async () => {
    if (stopped) return
    let grants: GrantView[]
    try {
      grants = (await listGrants()).filter(isLiveGrant)
    } catch (reason) {
      input.onError?.(reason)
      return
    }
    const wanted = new Set(grants.map((grant) => grant.id))
    for (const grantId of runtimes.keys()) {
      if (!wanted.has(grantId)) await tearDown(grantId)
    }
    for (const grant of grants) {
      if (runtimes.has(grant.id) || stopped) continue
      try {
        const handle = await registerRuntime(grant.id, `tab ${workspaceId}:${TAB_ID}`)
        if (stopped) {
          await deregister(handle.runtimeId).catch(() => undefined)
          return
        }
        const stopBeat = tabLeaseScheduler().keep(
          `runtime:${handle.runtimeId}`,
          HEARTBEAT_MS,
          () => heartbeat(handle.runtimeId).catch(() => undefined),
        )
        runtimes.set(grant.id, { handle, stopBeat })
        pollSoon = true
        if (!polling) void pollAll()
      } catch (reason) {
        input.onError?.(reason)
      }
    }
  }

  // Grant set changes (mint/revoke) are picked up on a slow cadence.
  const resync = window.setInterval(() => void sync(), 60_000)
  void sync()

  return {
    stop: () => {
      stopped = true
      window.clearInterval(resync)
      window.clearTimeout(pollTimer)
      for (const grantId of runtimes.keys()) void tearDown(grantId)
    },
  }
}

/** User-facing wrapper: the shell notifies once, the loop stays silent. */
export function mountAutomationRuntime(workspaceId: number): () => void {
  const runtime = startAutomationRuntime({
    workspaceId,
    onError: (reason) => notifyCommandError(reason, "自动化执行端同步失败，稍后自动重试。"),
  })
  return () => runtime.stop()
}
