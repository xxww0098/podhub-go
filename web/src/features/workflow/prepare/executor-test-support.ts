/**
 * Shared harness for the split executor tests: the recorded fetch stub, the
 * stubbed OPFS/render device, and the row/job fixtures every rail's tests use.
 */
import { resetConsoleDedupe } from "@/lib/diag-log"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"

import { route } from "@/api/routes"
import type { TestContext } from "node:test"

import { listingProjection } from "../../../../tests/listing-row-fixture"
import type { RenderLane } from "@/render/client"
import {
  invalidateAccountOverview,
  peekAccountOverview,
  rememberAccountOverview,
} from "@/features/account/account-overview-cache"
import { RECOGNITION_CONTRACT_VERSION } from "./ai-job"

/** sha256 of the stub renderer’s one-byte slice. */
export const SLICE_DIGEST = "4bf5122f344554c53bde2ebb8cd2b7e3d1600ad631c385a5d7cce23c7785459a"

/** Image-tag candidates for valid and oversized test answers. */
export const TWENTY_TAGS = [
  "#море", "#волны", "#песчаный_берег", "#чайки", "#реалистичный_стиль",
  "#синий", "#бежевый", "#синий_бежевый", "#гостиная", "#спальня",
  "#летний_день", "#спокойное_настроение", "#морской_пейзаж", "#природа", "#белый",
  "#светлые_тона", "#панорама", "#сканди", "#для_семьи", "#подарок_на_новоселье",
]

export const FIXED_TAGS = Array.from({ length: 16 }, (_, index) => `#fixed_${index + 1}`)

export const FIVE_TAGS = TWENTY_TAGS.slice(0, 5)

export const OK_ANSWER = readFileSync(new URL("../../../../../fixtures/ocr/digital-painting.json", import.meta.url), "utf8")

export const HAN_ANSWER = readFileSync(new URL("../../../../../fixtures/ocr/digital-painting-han.json", import.meta.url), "utf8")

export type RenderBatchOccupy = import("@/render/client").RenderBatch["occupy"]

export type Call = { url: string, method: string, body: any, headers: Record<string, string> }

export async function advanceBusyClock<T>(context: TestContext, run: () => Promise<T>): Promise<T> {
  context.mock.timers.enable({ apis: ["setTimeout"] })
  let done = false
  const result = run()
  void result.then(() => { done = true }, () => { done = true })
  try {
    for (let tick = 0; tick < 2000 && !done; tick++) {
      await new Promise<void>(resolve => setImmediate(resolve))
      context.mock.timers.tick(1000)
    }
    assert.ok(done, "workflow must complete or stop after capacity changes")
    return await result
  } finally { context.mock.timers.reset() }
}

export function grantedClaim(job: { id: string, payload?: Record<string, unknown> }) {
  return { job: { ...job, payload: { recognition_contract_version: RECOGNITION_CONTRACT_VERSION, ...job.payload } }, lease: { owner: `tab-${job.id}`, epoch: 1 }, lease_seconds: 30 }
}

export function windowCalls(calls: Call[]) {
  return calls.filter((call) => call.url.endsWith("/claim-window"))
}

export function windowJobIds(calls: Call[]) {
  return windowCalls(calls).flatMap((call) => (call.body?.jobIds ?? []) as string[])
}

export function singleJobClaims(calls: Call[]) {
  return calls.filter((call) => call.url.endsWith("/claim"))
}

const STORE_CHECKSUM = `${"a".repeat(43)}=`

function mediaBatchAnswer(call: Call): { objects: unknown[] } {
  const workspace = peekAccountOverview()?.active_workspace?.uuid ?? "test-workspace"
  const header = call.headers["x-podhub-store-checksum"]
  const optedIn = call.body?.store_checksum === "sha256" || header === "sha256"
  if (call.url.endsWith("/presign-batch")) {
    return {
      objects: (call.body?.objects ?? []).map((item: { digest: string, extension: string }) => {
        const [stamp, nonce] = String(call.body?.upload_batch ?? "").split(".")
        const prefix = stamp && nonce ? `uploads/2026-09-16/${stamp}-${nonce}/` : ""
        return {
          transport: "direct",
          workspace_uuid: workspace,
          account_id: "acct",
          object_key: `${prefix}images/teams/${workspace}/sha256/${item.digest}.${item.extension}`,
          public_url: `https://cdn.example.invalid/${prefix}images/teams/${workspace}/sha256/${item.digest}.${item.extension}`,
          storage_revision: 1,
          upload_batch: call.body?.upload_batch,
          upload: {
            url: `https://s3.example.invalid/media/${item.digest}.${item.extension}`,
            headers: {
              content_type: item.extension === "png" ? "image/png" : "image/jpeg",
              if_none_match: "*",
              ...(optedIn ? { checksum_sha256: STORE_CHECKSUM } : {}),
            },
            expires_at_ms: Date.now() + 600000,
          },
          upload_ticket: `ticket-${item.digest}`,
        }
      }),
    }
  }
  return {
    objects: (call.body?.objects ?? []).map((item: { account_id?: string, object_key: string, storage_revision?: number, byte_length?: number }) => ({
      object: {
        transport: "ready",
        workspace_uuid: workspace,
        account_id: item.account_id ?? "acct",
        object_key: item.object_key,
        public_url: `https://cdn.example.invalid/${item.object_key}`,
        storage_revision: item.storage_revision ?? 1,
        byte_length: item.byte_length ?? 1,
        deduplicated: false,
        checksum_trusted: true,
      },
    })),
  }
}

export function record(
  reply: (call: Call) => unknown,
  claim: (job: { id: string }) => unknown = grantedClaim,
  heartbeat: (call: Call) => unknown = () => true,
): { calls: Call[], restore: () => void } {
  const previous = globalThis.fetch
  const previousOverview = peekAccountOverview()
  let restored = false
  const calls: Call[] = []
  const jobs = new Map<string, any>()
  /**
   * The server bumps `jobs.attempt` on every granted claim and only there;
   * the count outlives any single plan snapshot of the job.
   */
  const claimAttempts = new Map<string, number>()
  const grant = (result: any, job: any) => {
    const attempt = Math.max(claimAttempts.get(job.id) ?? 0, job.attempt ?? 0) + 1
    claimAttempts.set(job.id, attempt)
    return { ...result, job: { ...result.job, attempt } }
  }
  const operations = new Map<string, string>()
  const rows = new Map<string, any>()
  const objects = new Map<string, any>()
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const call: Call = {
      url: String(input),
      method: init?.method ?? "GET",
      body: init?.body === undefined ? undefined : typeof init.body === "string" ? JSON.parse(init.body) : init.body,
      headers: (init?.headers ?? {}) as Record<string, string>,
    }
    calls.push(call)
    if (call.url.endsWith("/media/upload-batches")) {
      return new Response(JSON.stringify({ data: { upload_batch: `${Date.now()}.00000000-0000-4000-8000-${String(calls.length).padStart(12, "0")}.fixture-signature`, expires_at: new Date(Date.now() + 4 * 60 * 60 * 1000).toISOString() } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    }
    const windowIds = call.url.endsWith("/claim-window") ? call.body?.jobIds as string[] | undefined : undefined
    const claimedId = call.url.match(/\/jobs\/([^/]+)\/claim$/)?.[1]
    let answer: any
    if (windowIds) {
      const limit = Math.min(16, Math.max(1, Number(call.body?.limit) || windowIds.length))
      const granted: unknown[] = []
      let refusal: Response | undefined
      for (const id of windowIds.slice(0, limit)) {
        const job = jobs.get(id)
        if (!job) continue
        const result = await claim(job)
        if (result instanceof Response) { refusal = result; break }
        if (result) granted.push(grant(result, job))
      }
      answer = refusal ?? granted
    } else if (call.method === "GET" && /\/jobs\/[^/]+$/.test(call.url)) {
      const id = call.url.split("/").at(-1)!
      answer = { state: "queued", ...jobs.get(id) }
    } else if (call.url.endsWith("/media/objects/presign-batch") || call.url.endsWith("/media/objects/complete-batch")) {
      answer = mediaBatchAnswer(call)
    } else if (call.url.match(/\/media\/objects\/([^/]+)\/([^/]+)\/presign$/)) {
      const match = call.url.match(/\/media\/objects\/([^/]+)\/([^/]+)\/presign$/)!
      const workspace = peekAccountOverview()?.active_workspace?.uuid ?? "test-workspace"
      const [stamp, nonce] = String(call.body.upload_batch ?? "").split(".")
      const prefix = stamp && nonce ? `uploads/2026-09-16/${stamp}-${nonce}/` : ""
      answer = {
        transport: "direct",
        workspace_uuid: workspace,
        account_id: "acct",
        object_key: `${prefix}images/teams/${workspace}/sha256/${match[1]}.${match[2]}`,
        public_url: `https://cdn.example.invalid/${prefix}images/teams/${workspace}/sha256/${match[1]}.${match[2]}`,
        storage_revision: 1,
        upload: { url: `https://s3.example.invalid/media/${match[1]}.${match[2]}`,
          headers: { content_type: match[2] === "png" ? "image/png" : "image/jpeg", if_none_match: "*" }, expires_at_ms: Date.now() + 600000 },
        upload_ticket: `ticket-${match[1]}`,
      }
    } else if (call.url.match(/\/media\/objects\/([^/]+)\/([^/]+)\/complete$/)) {
      const workspace = peekAccountOverview()?.active_workspace?.uuid ?? "test-workspace"
      answer = {
        transport: "ready",
        workspace_uuid: workspace,
        account_id: call.body.account_id ?? "acct",
        object_key: call.body.object_key,
        public_url: `https://cdn.example.invalid/${call.body.object_key}`,
        storage_revision: call.body.storage_revision ?? 1,
        byte_length: call.body.byte_length ?? 1,
        deduplicated: false,
      }
    } else if (call.url === route("aiOcrUploads")) {
      answer = { upload_ticket: "fixture-ocr-ticket", upload: {
        url: "https://s3.example.invalid/private-ocr", headers: { content_type: call.body.image.content_type, if_none_match: "*" }, expires_at_ms: Date.now() + 600000,
      } }
    } else if (call.url === route("aiOcrUploadsConfirm")) {
      // The confirm echoes the DirectUploadSpec the grant was issued for.
      answer = { bytes: call.body?.upload_ticket === "fixture-ocr-ticket" ? 0 : 0, sha256: "", content_type: "" }
      const prior = calls.find(last => last.url === route("aiOcrUploads"))
      if (prior?.body?.image && call.body?.upload_ticket === "fixture-ocr-ticket") answer = { ...prior.body.image }
    } else if (call.url === "https://s3.example.invalid/private-ocr") {
      return new Response(null, { status: 200 })
    } else if (claimedId) {
      const result = await claim(jobs.get(claimedId)!)
      answer = result && !(result instanceof Response) ? grant(result, jobs.get(claimedId)!) : result
    } else {
      answer = call.url.endsWith("/heartbeat") ? await heartbeat(call)
        : call.url.endsWith("/prepare/cancel") ? { jobs: [] }
        : await reply(call)
    }
    if (!(answer instanceof Response) && call.url.endsWith("/prepare") && Array.isArray(answer?.jobs)) {
      answer = { ...answer, jobs: answer.jobs.map((job: any) => job.kind === "ai.recognize" ? {
        ...job, payload: { source_sha256: "source-sha", recognition_contract_version: RECOGNITION_CONTRACT_VERSION, ...job.payload },
      } : job) }
    }
    if (answer instanceof Response) return answer
    const rowId = call.url.match(/\/rows\/([^/]+)/)?.[1]
    if (rowId && call.url.endsWith("/prepare")) operations.set(rowId, call.body.operation)
    if ((call.method === "PUT" || call.url.endsWith("/probe")) && answer.objectKey) objects.set(answer.objectKey, answer)
    if (rowId && call.url.endsWith("/ai/settle")) {
      const saved = rows.get(rowId)
      answer = { ...answer, ...(saved ? { media: saved.media, render_evidence: saved.render_evidence, media_state: saved.media_state,
        revision: Math.max(answer.revision, saved.revision + 1), view_revision: Math.max(answer.view_revision, saved.view_revision + 1),
        projection: { ...answer.projection, media: saved.projection.media },
      } : {}) }
      rows.set(rowId, answer)
    }
    if (rowId && call.method === "GET" && !call.url.includes("include=ocrRecovery")) {
      const saved = rows.get(rowId)
      if (saved) answer = saved.view_revision >= answer.view_revision ? saved : { ...answer, media: saved.media, render_evidence: saved.render_evidence, media_state: saved.media_state, projection: { ...answer.projection, media: saved.projection.media } }
      rows.set(rowId, answer)
    }
    if (rowId && call.url.endsWith("/media") && answer.applied) {
      answer.jobs ??= []
      if (call.body.media_state === "rendered") {
        const manifest = { renderer: call.body.payload.render_evidence.manifest, images: call.body.payload.media.images }
        const manifestDigest = `manifest:test:${call.body.job_id}`
        const upload = operations.get(rowId) === "prepare"
        const row = { ...answer.row, id: rowId, revision: call.body.expected_revision + 1,
          view_revision: Math.max(answer.row.view_revision, rows.get(rowId)?.view_revision ?? 0) + 1,
          projection: { ...answer.row.projection, media: upload ? "uploading" : "rendered" },
          media_state: upload ? "uploading" : "rendered", media: { ...answer.row.media, images: manifest.images },
          render_evidence: { ...call.body.payload.render_evidence, manifest, manifest_digest: manifestDigest } }
        rows.set(rowId, row)
        const origin = jobs.get(call.body.job_id)
        // A reply may already carry the follow-up Jobs; the auto-minted upload
        // Job only fills in when it omitted them under a `prepare` command.
        answer = { applied: true, row, jobs: upload ? [{ ...origin, id: `${origin.id}-upload`, kind: "media.upload",
          payload: { ...origin.payload, manifest_digest: manifestDigest, manifest } }] : answer.jobs ?? [] }
      } else if (call.body.media_state === "failed") {
        const previous = rows.get(rowId)
        const row = { ...previous, media_state: "failed", revision: call.body.expected_revision + 1, view_revision: previous.view_revision + 1, projection: { ...previous.projection, media: "failed" } }
        rows.set(rowId, row)
        answer = { applied: true, row, jobs: [] }
      }
    }
    const receiptIndex = call.url.match(/\/media\/images\/(\d+)$/)?.[1]
    const bulk = call.url.endsWith("/media/images")
    const confirmations = bulk ? call.body.images : receiptIndex === undefined ? [] : [{ ...call.body, index: Number(receiptIndex) }]
    const receipts = []
    for (const confirmation of confirmations) {
      if (!rowId) continue
      const prior = rows.get(rowId)
      const image = objects.get(confirmation.object_key) ?? { public_url: prior.media.images[confirmation.index]?.public_url }
      const images = prior.media.images.map((item: any) => item.index === confirmation.index
        ? { ...item, phase: "public_ready", public_url: image.public_url, object_key: confirmation.object_key, account_id: confirmation.account_id } : item)
      const completed = images.filter((item: any) => item.phase === "public_ready").length
      const complete = completed === images.length
      const row = { ...prior,
        media: { ...prior.media, images }, media_state: complete ? "ready" : "uploading",
        projection: { ...prior.projection, media: complete ? "ready" : "uploading" },
      }
      rows.set(rowId, row)
      receipts.push({ applied: true, index: confirmation.index, phase: "public_ready",
        public_url: image.public_url, object_key: confirmation.object_key, account_id: confirmation.account_id,
        storage_revision: 1, completed, total: images.length,
        media_state: row.media_state,
        ...(complete ? { row } : {}) })
    }
    if (confirmations.length) answer = bulk ? { items: receipts, total: receipts.length } : receipts[0]
    for (const job of (answer as { jobs?: { id: string }[] })?.jobs ?? []) jobs.set(job.id, job)
    return new Response(JSON.stringify({ data: answer }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })
  }) as typeof globalThis.fetch
  return { calls, restore: () => {
    if (restored) return
    restored = true
    // Keep receipt delivery inside the transport fixture's lifetime. A queued
    // receipt must not retry through the restored fetch in another test.
    invalidateAccountOverview()
    if (previousOverview) rememberAccountOverview(previousOverview)
    globalThis.fetch = previous
  } }
}

/** Capture `console.log` lines for one run; the tests assert on the lines, never on the console. */
export function captureLog(): { lines: string[], restore: () => void } {
  // The console dedupes repeated failures for 30s; a captured run must see its own lines.
  resetConsoleDedupe()
  const previous = console.log
  const lines: string[] = []
  console.log = (...args: unknown[]) => {
    lines.push(args.map(String).join(" "))
  }
  return { lines, restore: () => { console.log = previous } }
}

/** The `[prepare]` stage names logged for one row, in order. */
export function prepareStages(lines: string[], rowId: string): string[] {
  return lines
    .filter((line) => line.startsWith("[prepare] ") && line.includes(` row=${rowId}`))
    .filter((line) => !/\[prepare\] (progress|queue\.ready|claim\.wait|retry\.wait|heartbeat) /.test(line))
    .map((line) => line.split(" ")[1]!)
}

export const ROW = {
  id: "row-1",
  card_id: "card-1",
  store_id: "store-1",
  revision: 9,
  view_revision: 1,
  projection: listingProjection({ stage: "awaiting_content", ai: "pending", media: "pending", fields: "dirty", readiness: { ready_to_publish: false, can_start_publish_attempt: false, blockers: ["ai_pending", "media_pending", "fields_dirty"], allowed_actions: ["prepare", "edit_fields"] } }),
  content_state: "draft",
  media_state: "pending",
  validation_state: "stale",
  submission_state: "none",
  draft: { values: {}, complex_values: [] },
  validation_issues: [],
  media: { images: [], videos: [] },
  ai: { candidates: [] },
  source: { asset_id: "", sha256: "source-sha", file_name: "image-1.jpg" },
  payload: {},
  updated_at_ms: 0,
  build: { state: "stale" as const, sources: [] },
}

/** Cloud returns the Draft already validated in its settlement transaction. */
export const RECOGNISED = {
  ...ROW,
  revision: 11,
  content_state: "ready",
  media_state: "processing",
  view_revision: 11,
  projection: listingProjection({ stage: "rendering", media: "rendering" }),
  draft: {
    values: {
      name: { kind: "text", value: "Постер с морем" },
      description: { kind: "text", value: "Морской постер для гостиной" },
    },
    complex_values: [],
  },
  ai: { candidates: [], summary: { tags: FIVE_TAGS, model: "gpt-x" } },
}

export const COMPLETION = {
  // The billing split is the audited `charged + absorbed = total`: the cost
  // the browser logs must be the charged part, never the nominal total.
  billing: { request_id: "air-purchase", model: "gpt-x", total_microfen: 400, charged_microfen: 300, absorbed_microfen: 100 },
  completion: {
    choices: [
      {
        message: {
          content: JSON.stringify({
            ru: "Постер с морем",
            tags: FIVE_TAGS,
            desc: "Морской постер для гостиной",
            candidates: [{ field_key: "brand", value: "NoName" }],
          }),
        },
      },
    ],
  },
}

/**
 * The render worker and OPFS are browser-only. `runRows` is exercised through
 * the routes it takes; the render itself is pinned by `tests/render-wasm.test.ts`.
 */
export async function withStubbedDevice<T>(
  run: () => Promise<T>,
  overrides: Record<string, unknown> = {},
  clientOverrides: Record<string, unknown> = {},
): Promise<T> {
  if (!peekAccountOverview()?.active_workspace?.uuid) {
    const workspace = { id: 1, uuid: "test-workspace", name: "Test", plan: "pro", role: "owner", is_owned: true }
    rememberAccountOverview({
      session: { authenticated: true, email: "test@example.invalid", role: "user" },
      entitlement: {
        plan: "pro",
        features: { ai_relay: true, ocr: true, batch_listing: true, field_package: true },
        limits: { stores: 1, stores_used: 0, seats: 1, seats_used: 1, s3_upload_bytes_monthly: 0,
          s3_upload_bytes_used: 0, ai_tokens_monthly: 0, ai_tokens_used: 0, ai_calls_per_day: 0 },
      },
      active_workspace: workspace,
      workspaces: [workspace],
      account_mode: "owner",
      owned_count: 1,
      owned_limit: 3,
    })
  }
  const { device } = await import("./execution-context")
  const client = await import("@/render/client")
  const original = { ...device }
  const originalCreateBatch = client.renderClient.createBatch
  Object.assign(device, {
    getSource: async () => new Uint8Array([1, 2, 3]),
    getTemplate: async () => new Uint8Array([4, 5, 6]),
    getRender: async () => new Uint8Array([1]),
    putRender: async () => true,
    dropRender: async () => undefined,
    openStaticSliceCache: async () => null,
    writeStaticSlices: async () => undefined,
    ...overrides,
  })
  client.renderClient.createBatch = () => {
    // One lane per batch retains its template across that batch's rows.
    const laneHeld: { current?: { sha256: string; id: number } } = {}
    const lane: Record<string, unknown> = {
      prepareAiImage: async () => new Uint8Array([7, 8, 9]),
      loadTemplate: async () => 1,
      dropTemplate: async () => {
        laneHeld.current = undefined
      },
      renderProduct: async () => ({
        manifest: { staticGroups: 0 },
        slices: [
          {
            groupName: "主图",
            index: 0,
            fileName: "slice-1.jpg",
            width: 900,
            height: 1200,
            contentHash: `sha256:${SLICE_DIGEST}`,
            bytes: new Uint8Array([1]),
          },
        ],
      }),
      ...clientOverrides,
    }
    lane.heldTemplate ??= () => laneHeld.current
    lane.forgetHeldTemplate ??= () => {
      laneHeld.current = undefined
    }
    lane.retainTemplate ??= async (sha256: string, bytes: Uint8Array) => {
      if (laneHeld.current?.sha256 === sha256) return laneHeld.current.id
      const id = await (lane.loadTemplate as (bytes: Uint8Array) => Promise<number>)(bytes)
      laneHeld.current = { sha256, id }
      return id
    }
    let laneTail = Promise.resolve()
    const concurrent = Boolean(clientOverrides.concurrentLanes)
    return {
      prepareAiImage: lane.prepareAiImage as RenderLane["prepareAiImage"],
      occupy: (clientOverrides.occupy as RenderBatchOccupy | undefined) ?? (() => () => {}),
      disposeRender: (clientOverrides.disposeRender as (() => void) | undefined) ?? (() => {}),
      dispose: (clientOverrides.dispose as (() => void) | undefined) ?? (() => {}),
      withLane: async <R,>(_key: string, run: (lane: RenderLane) => Promise<R>): Promise<R> => {
        if (concurrent) return run(lane as unknown as RenderLane)
        const previous = laneTail
        let release!: () => void
        laneTail = new Promise<void>((resolve) => {
          release = resolve
        })
        await previous
        try {
          return await run(lane as unknown as RenderLane)
        } finally {
          release()
        }
      },
    }
  }
  try {
    return await run()
  } finally {
    Object.assign(device, original)
    client.renderClient.createBatch = originalCreateBatch
  }
}

export function answer(content: string): unknown {
  return { choices: [{ message: { content } }] }
}

export function sendPins(rowIds: string[], storeFor: (id: string) => string = () => ROW.store_id) {
  return rowIds.map(row_id => ({ row_id, revision: ROW.revision, store_id: storeFor(row_id) }))
}

// --- congestion: `docs/media-probe-locality.md` P0 / P3 ------------------------

export function busy(status: number, message: string): Response {
  return new Response(JSON.stringify({ code: status === 429 ? "BUSY" : "INTERNAL", message }), {
    status,
    headers: { "Content-Type": "application/json", "Retry-After": "0" },
  })
}

export function preparedRowIds(calls: Call[]) {
  return [...new Set(calls.filter((call) => call.url.endsWith("/prepare")).map((call) => call.url.match(/rows\/([^/]+)/)?.[1]))]
}

export function cancelledRowIds(calls: Call[]) {
  return [...new Set(calls.filter((call) => call.url.endsWith("/prepare/cancel")).map((call) => call.url.match(/rows\/([^/]+)/)?.[1]))]
}

export function slicePrepareReply(rowId: string) {
  return {
    outcome: "running",
    jobs: [{
      id: `job-${rowId}`,
      kind: "media.render",
      aggregate_id: rowId,
      aggregate_type: "listing_row",
      input_revision: 10,
      state: "queued",
      attempt: 0,
      payload: { recognition_prompt: { prompt_id: "prompt-1", fixed_tags: FIXED_TAGS, content: "识图提示词", sha256: "prompt-sha" }, executor: "browser", pinned_revision: 10, psd_template_sha256: "template-sha" },
      updated_at_ms: 0,
    }],
  }
}

export function ocrRecoveryView(attempts: Array<{ attempt: "original" | "contract_retry", status: string, requestId?: string | null, resultUsable?: boolean | null }>) {
  return {
    job_state: "running",
    lease_epoch: 1,
    attempts: attempts.map(item => ({
      attempt: item.attempt,
      status: item.status,
      request_id: item.requestId ?? null,
      result_usable: item.resultUsable ?? null,
    })),
  }
}
