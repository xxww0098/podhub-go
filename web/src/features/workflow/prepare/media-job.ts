/**
 * The `media.render` / `media.upload` rail: OPFS render through the wasm
 * lanes, the per-template static-slice cache, manifest writeback, and public
 * object confirmation through the Local Media Object Set
 * (`media-objects.ts`). Runs locally without a Cloud execution lease.
 */
import { isBusyRefusal } from "@/api/busy-retry"
import { api } from "@/api/client"
import { route } from "@/api/routes"
import type { components } from "@/api/schema"
import type {
  WorkflowFailureLogEntry,
  WorkflowImageLifecycle,
} from "@/bindings/commands"
import type { ListingRowView } from "@/bindings/listing-projection"
import { readListingRow } from "@/bindings/http-listing"
import { diagLog, elapsedMs, PREPARE_LOG } from "@/lib/diag-log"
import { errorTransportContext } from "@/lib/error-feedback"
import { listingMediaSummary } from "@/lib/error-report-environment"
import { listingCorrelation, listingFailureModule, listingLog, noteListingRow, psdIdOf } from "@/lib/listing-log"
import { refusalPair } from "@/lib/listing-refusal"
import { notifyError } from "@/lib/notify"
import { peekListingWorkbench } from "../workbench/listing-workbench-store"
import { digestOf, rowImages, uploadMediaJob, type MediaJobData } from "./media-upload-job"
import { rememberSliceEncode } from "./slice-encode-memory"
import type { RenderLane } from "@/render/client"
import { renderProfile, type RenderArtifactOwner } from "@/render/opfs"
import { DEFAULT_RENDER_INTENT, type RenderBytes, type RenderResult, type RenderSlice } from "@/render/wasm"
import {
  device,
  errorFields,
  blockersOf,
  jobPayload,
  logStage,
  operationBlockerMessage,
  sourceOf,
  JOB_RENDER,
  type MediaExecution,
} from "./execution-context"

export { UPLOAD_CONCURRENCY } from "./media-upload-job"

/**
 * The renderer contract the slice decision is keyed on. It names *this* build
 * of `rust/crates/render` compiled to wasm; a row prepared under another one is a
 * different pin, not a cache hit.
 */
export const RENDERER_CONTRACT_VERSION = "browser-wasm-v2"

// --- the media rail ---------------------------------------------------------

export function pendingUploadBytes(row?: ListingRowView | null): number {
  return row ? rowImages(row).reduce((total, image) => total + (image.byte_size ?? 0), 0) : 0
}

function renderedImage(slice: RenderSlice): WorkflowImageLifecycle {
  return {
    index: slice.index,
    file_name: slice.fileName,
    content_hash: slice.contentHash,
    group_name: slice.groupName,
    width: slice.width,
    height: slice.height,
    byte_size: slice.bytes.length,
    phase: "rendered",
  }
}

function asTrap(reason: unknown): boolean {
  return errorFields(reason).code === "RENDER_TRAP"
}

/** `null` when Stop arrived before a render lane did: the row held nothing yet. */
async function renderToOpfs(
  row: ListingRowView,
  templateSha256: string,
  execution: MediaExecution,
  owner: RenderArtifactOwner,
  supplierTemplate?: { productId: string, fileName?: string },
): Promise<{ slices: RenderSlice[]; evidence: Record<string, unknown> } | null> {
  const source = sourceOf(row)
  const laneStartedAt = performance.now()
  execution.feedback?.("waiting", "等待本机渲染资源")
  // The lane comes first. A row waiting for one holds nothing — the template
  // read below is up to 254 MiB — and a stop skips it outright.
  const render = await execution.workers.withLane(
    templateSha256,
    async (lane): Promise<RenderResult | null> => {
      execution.feedback?.("running", "正在渲染")
      logStage("media.lane", row.id, { waitedMs: elapsedMs(laneStartedAt) })
      lane.bindListing?.(listingCorrelation(row.id))
      noteListingRow(row.id, { psdId: psdIdOf(templateSha256) })
      if (execution.stopped()) return null
      execution.assertCurrent()
      const held = lane.heldTemplate()
      let templateId: number
      if (held?.sha256 === templateSha256) {
        templateId = held.id
        diagLog(PREPARE_LOG, "template.retain", { sha256: templateSha256, template: templateId })
        listingLog({ module: "bind", event: "template.end", rowId: row.id, durationMs: 0 })
      } else {
        execution.feedback?.("running", "正在加载模板")
        let templateBytes = await device.getTemplate(templateSha256)
        if (!templateBytes && supplierTemplate) {
          await device.stageSupplierTemplate(
            supplierTemplate.productId,
            templateSha256,
            supplierTemplate.fileName,
          )
          templateBytes = await device.getTemplate(templateSha256)
        }
        if (!templateBytes) {
          throw Object.assign(new Error("本机没有该 PSD 模板，请在建卡页重新选择模板文件"), {
            code: "workflow_template_missing",
          })
        }
        const releaseTemplate = execution.workers.occupy(templateBytes.byteLength)
        const loadStartedAt = performance.now()
        listingLog({ module: "bind", event: "template.start", rowId: row.id })
        try {
          templateId = await lane.retainTemplate(templateSha256, templateBytes)
        } finally { releaseTemplate() }
        listingLog({ module: "bind", event: "template.end", rowId: row.id, durationMs: elapsedMs(loadStartedAt), fields: { bytes: templateBytes.length } })
        diagLog(PREPARE_LOG, "template.load", {
          sha256: templateSha256,
          template: templateId,
          bytes: templateBytes.length,
          ms: elapsedMs(loadStartedAt),
        })
      }
      const sourceBytes = await device.getSource(source.sha256, source.fileName)
      if (!sourceBytes) {
        throw Object.assign(new Error("本机没有该源图，请重新导入后再准备"), {
          code: "workflow_source_missing",
        })
      }
      execution.assertCurrent()
      const startedAt = performance.now()
      listingLog({ module: "render", event: "render.start", rowId: row.id })
      execution.feedback?.("running", "正在渲染")
      const releaseSource = execution.workers.occupy(sourceBytes.byteLength)
      let result: RenderResult
      try {
        result = await renderWithStaticCache(lane, templateId, templateSha256, source, sourceBytes)
      } catch (reason) {
        if (asTrap(reason)) {
          lane.forgetHeldTemplate()
          diagLog(PREPARE_LOG, "template.forget", {
            sha256: templateSha256,
            template: templateId,
            reason: "RENDER_TRAP",
          })
        }
        throw reason
      } finally { releaseSource() }
      const sliceBytes = result.slices.reduce((total, slice) => total + slice.bytes.length, 0)
      const releaseSlices = execution.workers.occupy(sliceBytes)
      try {
        if (result.slices.length === 0 || result.slices.some((slice) => !slice.bytes.length || !slice.contentHash || !slice.fileName || slice.width === 0 || slice.height === 0)) {
          throw Object.assign(new Error("切片不完整，请重新切片"), { code: "workflow_render_incomplete" })
        }
        const committed = await device.putRender(row.id, result.slices, result.manifest, owner)
        if (committed === false) {
          throw Object.assign(new Error("本机已有更新的切片产物"), { code: "workflow_render_superseded" })
        }
        for (const slice of result.slices) {
          if (slice.encodeMs) rememberSliceEncode(slice.contentHash, slice.encodeMs)
          const stored = await device.getRender(row.id, slice.fileName)
          if (!stored?.length) {
            throw Object.assign(new Error("本机缺少待上传切片，请重新导入源图后点击切片，再上传"), { code: "workflow_render_missing" })
          }
        }
      } finally { releaseSlices() }
      const encodeMs = result.slices.reduce((total, slice) => total + (slice.encodeMs ?? 0), 0)
      listingLog({ module: "render", event: "render.end", rowId: row.id, durationMs: elapsedMs(startedAt), fields: { slices: result.slices.length, bytes: sliceBytes, encodeMs } })
      if (encodeMs > 0) listingLog({ module: "encode", event: "encode.end", rowId: row.id, durationMs: encodeMs, fields: { slices: result.slices.length, stage: "encode" } })
      logStage("render", row.id, {
        ms: elapsedMs(startedAt),
        design: source.fileName,
        slices: result.slices.length,
        bytes: sliceBytes,
        ...(encodeMs > 0 ? { encodeMs } : {}),
        template: templateId,
      })
      return result
    },
  )
  if (!render) return null
  execution.assertCurrent()
  const manifestDigest = `manifest:v1:${row.id}:sha256:${await device.sha256Hex(
    JSON.stringify(render.manifest),
  )}`
  return {
    slices: render.slices,
    evidence: {
      source_sha256: source.sha256,
      template_sha256: templateSha256,
      renderer_contract_version: RENDERER_CONTRACT_VERSION,
      manifest_digest: manifestDigest,
      manifest: render.manifest,
      sliceCount: render.slices.length,
      degradations: [],
    },
  }
}

/**
 * One in-flight full render fills `(templateFingerprint, renderProfile)`.
 * Followers wait, then skip-render their own design. A failed leader does
 * not donate pixels; followers full-render themselves.
 */
const staticSliceFills = new Map<string, Promise<boolean>>()

async function leadOrJoinStaticFill(key: string, fill: () => Promise<void>): Promise<"lead" | "joined" | "retry"> {
  const existing = staticSliceFills.get(key)
  if (existing) return (await existing.catch(() => false)) ? "joined" : "retry"
  let settle!: (ok: boolean) => void
  const flight = new Promise<boolean>((resolve) => {
    settle = resolve
  })
  staticSliceFills.set(key, flight)
  try {
    await fill()
    settle(true)
    return "lead"
  } catch (reason) {
    settle(false)
    throw reason
  } finally {
    staticSliceFills.delete(key)
  }
}

/**
 * Static groups — the ones the selected slot cannot reach — render once per
 * template and render profile, then come from OPFS. The renderer decides which
 * groups those are (`StaticGroups` in `rust/crates/render`), the cache validates
 * every entry it hands back, and the slice list keeps the renderer's group
 * order either way (listing-design.md 切片). A cache that has entries but not
 * the one a skipped slice needs costs one full render, which refiles them.
 * Concurrent first fills of the same cache share one full render.
 */
async function renderWithStaticCache(
  lane: RenderLane,
  templateId: number,
  templateSha256: string,
  source: { sha256: string; fileName: string },
  sourceBytes: RenderBytes,
): Promise<RenderResult> {
  const fingerprint = `sha256:${templateSha256}`
  const profile = renderProfile()
  const first = await trySkipStaticCache(lane, templateId, fingerprint, profile, source, sourceBytes)
  if (first.ok) return first.result
  let bytes = first.consumedDesign ? await requireSource(source) : sourceBytes
  const key = `${fingerprint}|${profile}`
  let led: RenderResult | undefined
  const role = await leadOrJoinStaticFill(key, async () => {
    led = await fullRenderAndFileStatic(lane, templateId, fingerprint, profile, source, bytes)
  })
  if (role === "lead") return led!
  if (role === "joined") {
    bytes = await requireSource(source)
    const second = await trySkipStaticCache(lane, templateId, fingerprint, profile, source, bytes)
    if (second.ok) return second.result
    bytes = second.consumedDesign ? await requireSource(source) : bytes
  }
  return fullRenderAndFileStatic(lane, templateId, fingerprint, profile, source, bytes)
}

type StaticSkipAttempt =
  | { ok: true, result: RenderResult, consumedDesign: true }
  | { ok: false, consumedDesign: boolean }

async function trySkipStaticCache(
  lane: RenderLane,
  templateId: number,
  fingerprint: string,
  profile: string,
  source: { sha256: string; fileName: string },
  sourceBytes: RenderBytes,
): Promise<StaticSkipAttempt> {
  const cache = await device.openStaticSliceCache(fingerprint, profile)
  if (!cache) return { ok: false, consumedDesign: false }
  const partial = await lane.renderProduct(templateId, sourceBytes, source.fileName, {
    ...DEFAULT_RENDER_INTENT,
    staticGroups: "skip",
  })
  const hits = await cache.read(partial.slices.filter(slice => slice.staticGroup))
  let nextHit = 0
  const slices: RenderSlice[] = []
  let complete = partial.slices.length > 0
  for (const slice of partial.slices) {
    if (!slice.staticGroup) {
      if (!slice.bytes.length || !slice.contentHash || slice.width === 0 || slice.height === 0) {
        complete = false
        break
      }
      slices.push(slice)
      continue
    }
    const filled = await fillStaticSlice(slice, hits[nextHit++])
    if (!filled) {
      complete = false
      break
    }
    slices.push(filled)
  }
  if (complete && slices.length === partial.slices.length) {
    const manifest = {
      ...(partial.manifest as Record<string, unknown>),
      slices: slices.map(({ bytes: _bytes, ...metadata }) => metadata),
    }
    return { ok: true, result: { manifest, slices }, consumedDesign: true }
  }
  return { ok: false, consumedDesign: true }
}

async function requireSource(source: { sha256: string; fileName: string }): Promise<RenderBytes> {
  const again = await device.getSource(source.sha256, source.fileName)
  if (!again) {
    throw Object.assign(new Error("本机没有该源图，请重新导入后再准备"), {
      code: "workflow_source_missing",
    })
  }
  return again
}

async function fullRenderAndFileStatic(
  lane: RenderLane,
  templateId: number,
  fingerprint: string,
  profile: string,
  source: { fileName: string },
  sourceBytes: RenderBytes,
): Promise<RenderResult> {
  const full = await lane.renderProduct(templateId, sourceBytes, source.fileName)
  const manifest = full.manifest as { templateFingerprint?: string }
  if (manifest.templateFingerprint === fingerprint) {
    try {
      await device.writeStaticSlices(fingerprint, profile, full.slices.filter((slice) => slice.staticGroup))
    } catch (reason) {
      diagLog(PREPARE_LOG, "static_cache.write.fail", errorFields(reason))
    }
  }
  return full
}

async function fillStaticSlice(
  slice: RenderSlice,
  hit: { width: number; height: number; contentHash: string; bytes: RenderBytes } | null | undefined,
): Promise<RenderSlice | null> {
  if (!hit || !hit.bytes.length || !hit.contentHash || hit.width === 0 || hit.height === 0) return null
  const digest = await device.sha256Hex(hit.bytes)
  if (digest !== digestOf(hit.contentHash)) return null
  return { ...slice, width: hit.width, height: hit.height, contentHash: hit.contentHash, bytes: hit.bytes }
}

/** Render and upload are separate durable Jobs; only Cloud enqueues their dependency. */
export async function runMediaJob(
  row: ListingRowView,
  job: components["schemas"]["ListingRunView"],
  execution: MediaExecution,
  uploadBatch?: (rejectedBatch?: string) => Promise<import("../media/media-objects").MediaUploadBatch>,
): Promise<MediaJobData | null> {
  const started = performance.now()
  noteListingRow(row.id, { jobId: job.id })
  try {
    const pinned = jobPayload(job)
    if (job.kind === JOB_RENDER) {
      const owner = { jobId: job.id, generation: Date.now() }
      const supplierProductId = pinned.cardPayload?.supplierProductId
      const rendered = await renderToOpfs(
        row,
        pinned.psdTemplateSha256 ?? "",
        execution,
        owner,
        supplierProductId
          ? { productId: supplierProductId, fileName: pinned.cardPayload?.psdTemplateFileName }
          : undefined,
      )
      if (!rendered) return null
      execution.assertCurrent()
      // AI or a field edit can advance the row while this immutable render is
      // being saved. Retry only CAS refusals; every attempt retains the input
      // fingerprint checks, and never renders the image again.
      const payload = { media: { images: rendered.slices.map(renderedImage) }, render_evidence: rendered.evidence }
      for (let attempt = 0; attempt < 3; attempt += 1) {
        execution.feedback?.("running", "正在写回云端")
        row = await readListingRow(row.id)
        execution.assertCurrent()
        const landed = await writeMedia(row.id, row.revision, "rendered", job.id, payload)
        logStage("media.writeback", row.id, { state: "rendered", applied: landed.applied, pin: row.revision })
        if (landed.applied) return landed
      }
      throw Object.assign(new Error("商品行持续变化，请重新准备"), { code: "workflow_media_writeback_stale" })
    }
    return await uploadMediaJob(row, job, execution, uploadBatch)
  } catch (reason) {
    if (execution.stopped()) return null
    if (isBusyRefusal(reason)) throw reason
    const failure = errorFields(reason)
    const pair = refusalPair(reason) ?? { code: failure.code, refusal: failure.code }
    // A blocked prepare returns the generic envelope message plus structured
    // blockers; log the actionable blocker text, not the envelope.
    const blockers = blockersOf(reason)
    const message = blockers.length
      ? blockers.map(operationBlockerMessage).join("、")
      : failure.message
    logStage("media.fail", row.id, { code: failure.code, message })
    const moduleName = listingFailureModule(job.kind, failure.code)
    const event = moduleName === "upload" ? "upload.end" : moduleName === "bind" ? "template.end" : "media.fail"
    listingLog({
      level: "error",
      module: moduleName,
      event,
      rowId: row.id,
      durationMs: elapsedMs(started),
      errorCode: pair.code,
      errorMessage: message,
      fields: { stage: moduleName, refusal: pair.refusal },
    })
    const payload = {
      failure_log: [{ stage: "media", code: failure.code, message,
        remediation: failure.remediation ?? undefined, occurred_at_ms: Date.now() } satisfies WorkflowFailureLogEntry],
    }
    try {
      let saved = false
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const current = await readListingRow(row.id)
        const landed = await writeMedia(row.id, current.revision, "failed", job.id, payload)
        if (landed.applied) { saved = true; break }
      }
      if (!saved) throw new Error("商品行持续变化")
    } catch (writebackReason) {
      const saved = refusalPair(writebackReason)?.refusal ?? errorFields(writebackReason).code
      const workbench = peekListingWorkbench()
      const media = listingMediaSummary(workbench.productBases[row.id]?.lifecycle)
      notifyError("媒体处理失败，失败记录未保存", {
        id: `media-failure-writeback-${row.id}`,
        description: `处理：${message}；保存：${errorFields(writebackReason).message}`,
        reason: failure,
        context: {
          stage: moduleName === "upload" ? "upload" : "prepare",
          rowId: row.id,
          ...(workbench.cardId ? { cardId: workbench.cardId } : {}),
          ...errorTransportContext(reason),
          ...errorTransportContext(writebackReason),
          refusalReason: saved,
          ...(media ? { media } : {}),
        },
        timeout: 20_000,
      })
    }
    throw reason
  }
}

function writeMedia(
  rowId: string,
  expectedRevision: number,
  mediaState: "failed" | "rendered",
  jobId: string,
  payload: Record<string, unknown>,
): Promise<MediaJobData> {
  return api.post<MediaJobData>(
    route("listingRowsByIdMedia", { id: rowId }),
    {
      expected_revision: expectedRevision,
      media_state: mediaState,
      job_id: jobId,
      payload,
    },
  )
}
