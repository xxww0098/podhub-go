/**
 * Browser workflow orchestration: prepare verbs, video relay, source import
 * (implemented in `source-import-actions.ts`), and listing writes that project
 * through feature helpers.
 *
 * Screens import `workflowActions` directly. Bindings stay wire-only —
 * this module is the one that may call the prepare/submit executors, `media-objects`,
 * `product-edit` and `row-state`.
 */
import type { PreparationRequest } from "./prepare/ocr-model-routing"
import {
  fileBytes,
  pickDirectory,
  pickFiles,
  PROMPT_ACCEPT,
  stageFile,
  stagedFile,
  VIDEO_ACCEPT,
} from "@/bindings/file-picker"
import {
  cardPayload,
  rowHandEditedKeys,
  type CardPayload,
  type ListingRowView,
} from "@/bindings/listing-projection"
import {
  cardCategorySchema,
  cardLifecycle,
  cardRows,
  mergeListingRow,
  patchListingRow,
  queueStateView,
  readListingCard,
  readListingRow,
} from "@/bindings/http-listing"
import { patchListingCard } from "@/features/workflow/card/card-writes"
import { refuse } from "@/bindings/refusal"
import { readVideoDurationMs, validateVideoResolution } from "@/lib/video-duration"
import type {
  ListingCardAttachVideoToProductsRequest,
  VideoPoolUploadRequest,
  WorkflowAttachVideoRequest,
  WorkflowClearGeneratedContentItemResult,
  WorkflowClearGeneratedContentRequest,
  WorkflowDraftView,
  WorkflowImageLifecycle,
  WorkflowMediaBindingResult,
  WorkflowOperationRowResult,
  WorkflowPendingVideo,
  WorkflowPickVideoRequest,
  WorkflowProductSaveResult,
  WorkflowProductStatusView,
  WorkflowPromptDirEntry,
  WorkflowPromptDirScan,
  WorkflowRowsActionRequest,
  WorkflowUploadVideoRequest,
  WorkflowVideoMetadata,
  WorkflowVideoRole,
} from "@/bindings/commands"
import { requestStop, type AutomationExecutionScope } from "./prepare/execution-context"
import { runRows } from "./prepare/run-rows"
import { sendRows } from "./submit/send-rows"
import { deliverMediaObject } from "./media/media-objects"
import { isProductEditConflict, mergeProductEdit, type ProductEditFields } from "./model/product-edit"
import { draftValidationState, rowStatusView } from "./model/row-state"
import { mapLimit } from "./source-batch"
import {
  rowDraftView,
  workflowImportSourceAssets,
  workflowImportSourceAssetsStop,
  workflowPickSourceAssets,
} from "./source-import-actions"

/** Adapt a streamed row using the already loaded Card metadata. */
export function listingRowDraftView(row: ListingRowView, card: WorkflowDraftView): WorkflowDraftView {
  return rowSaveResult({ ...card, draft_id: row.id, kind: "instance", display_name: "", parent_card_id: row.card_id }, row).saved
}

function rowSaveResult(view: WorkflowDraftView, row: ListingRowView): WorkflowProductSaveResult {
  const status = rowStatusView(row)
  return {
    saved: {
      ...view,
      source_layers: status.source_layers,
      target_store_id: row.store_id ?? "",
      draft: row.draft,
      validation_state: draftValidationState(row.validation_state),
      issues: row.validation_issues,
      lifecycle: status.lifecycle,
      updated_at_ms: row.updated_at_ms,
      hand_edited_keys: rowHandEditedKeys(row),
    },
    status,
  }
}

type RowMediaSection = {
  images?: Array<WorkflowImageLifecycle>
  videos?: Array<WorkflowVideoMetadata>
  videoCover?: WorkflowVideoMetadata
}

function rowMedia(row: ListingRowView): RowMediaSection {
  return (row.media ?? {}) as RowMediaSection
}

function videoIdentity(video: WorkflowVideoMetadata): string | undefined {
  return video.content_hash ?? video.public_url
}

/** `cover` is a slot, `product` is an ordered list keyed by hash or public URL. */
function mediaWithVideo(media: RowMediaSection, video: WorkflowVideoMetadata): RowMediaSection {
  if (video.role === "cover") return { ...media, videoCover: video }
  const identity = videoIdentity(video)
  const videos = identity === undefined
    ? (media.videos ?? [])
    : (media.videos ?? []).filter((existing) => videoIdentity(existing) !== identity)
  return { ...media, videos: [...videos, video] }
}

function mediaWithoutVideo(
  media: RowMediaSection,
  role: WorkflowVideoRole,
  identity?: string,
): RowMediaSection {
  if (role === "cover") return { ...media, videoCover: undefined }
  return {
    ...media,
    videos: (media.videos ?? []).filter(
      (video) => identity !== undefined && videoIdentity(video) !== identity,
    ),
  }
}

function cardWithVideo(payload: CardPayload, video: WorkflowVideoMetadata): CardPayload {
  const media = mediaWithVideo({ videos: payload.videos, videoCover: payload.videoCover }, video)
  return { ...payload, videos: media.videos ?? [], videoCover: media.videoCover }
}

function cardWithoutVideo(
  payload: CardPayload,
  role: WorkflowVideoRole,
  identity?: string,
): CardPayload {
  const media = mediaWithoutVideo(
    { videos: payload.videos, videoCover: payload.videoCover },
    role,
    identity,
  )
  return { ...payload, videos: media.videos ?? [], videoCover: media.videoCover }
}

const VIDEO_EXTENSIONS: Record<string, string> = {
  "video/mp4": "mp4",
  "video/quicktime": "mov",
}

/**
 * Deliver one media file through the relay door (`media-objects.ts`): local
 * set, else probe, then PUT only on an origin miss. The local set only skips
 * asking again about an object Cloud already confirmed.
 */
async function relayMediaFile(
  bytes: Uint8Array<ArrayBuffer>,
  extension: string,
  contentType: string,
): Promise<{ digest: string, publicUrl: string, objectKey: string }> {
  const digest = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")
  const delivered = await deliverMediaObject({
    digest,
    extension,
    contentType,
    byteLength: bytes.byteLength,
    bytes: () => bytes,
  })
  return { digest, publicUrl: delivered.publicUrl, objectKey: delivered.objectKey }
}

async function uploadStagedVideo(
  handle: string,
  role: WorkflowVideoRole,
): Promise<WorkflowVideoMetadata> {
  const file = stagedFile(handle)
  if (!file) throw refuse("workflow_video_handle_missing", "视频文件已失效，请重新选择")
  const extension = VIDEO_EXTENSIONS[file.type]
  if (!extension) throw refuse("workflow_video_unsupported", "仅支持 mp4 与 mov 视频")
  const durationMs = await validateVideoResolution(file)
  const bytes = await fileBytes(file)
  const delivered = await relayMediaFile(bytes, extension, file.type)
  return {
    role,
    origin: "managed_upload",
    file_name: file.name,
    content_type: file.type,
    size_bytes: file.size,
    duration_ms: durationMs || await readVideoDurationMs(file, { knownBytes: bytes }),
    public_url: delivered.publicUrl,
    object_key: delivered.objectKey,
    content_hash: `sha256:${delivered.digest}`,
  }
}

/** Whatever a rejection says, in the one sentence the row log prints. */
function commandMessage(reason: unknown): string {
  const fields = (typeof reason === "object" && reason !== null ? reason : {}) as {
    message?: string
  }
  return fields.message ?? String(reason)
}
export const workflowActions = {
  /**
   * The card's cohort. One card read (for the prompt, template and policy every
   * instance inherits), one catalog read (every row of a cohort is pinned to the
   * card's coordinate by `seed_row_payload`) and the rows themselves.
   */
  listingCardListProductInstances: async (cardDraftId: string) => {
    const card = cardPayload(await readListingCard(cardDraftId))
    const [schema, rows] = await Promise.all([
      cardCategorySchema(card),
      cardRows(cardDraftId),
    ])
    return rows.map((row) => rowDraftView(row, card, schema))
  },
  workflowGetProductStatus: async (rowId: string): Promise<WorkflowProductStatusView> => {
    return rowStatusView(await readListingRow(rowId))
  },
  /** A live cohort costs one card plus row pages, with no catalog or per-row reads. */
  workflowReadCardStatus: async (cardId: string, isCurrent?: () => boolean) => {
    const [card, rows] = await Promise.allSettled([
      readListingCard(cardId),
      cardRows(cardId, isCurrent),
    ])
    // Keep one failed page from releasing the polling flight while its siblings still read.
    if (card.status === "rejected") throw card.reason
    if (rows.status === "rejected") throw rows.reason
    return {
      queue: queueStateView(card.value, cardPayload(card.value).queue.frozenRowIds.length > 0 && rows.value.some((row) =>
        row.submission_state === "queued" || row.submission_state === "submitting",
      )),
      rows: rows.value.map((row) => ({
        draftId: row.id,
        updatedAtMs: row.updated_at_ms,
        status: rowStatusView(row),
      })),
    }
  },
  workflowRecognize: (request: PreparationRequest, onRow: (row: WorkflowOperationRowResult) => void) => runRows(request, "recognize", onRow),
  workflowSlice: (request: WorkflowRowsActionRequest, onRow: (row: WorkflowOperationRowResult) => void) => runRows(request, "slice", onRow),
  workflowUpload: (request: WorkflowRowsActionRequest, onRow: (row: WorkflowOperationRowResult) => void) => runRows(request, "upload", onRow),
  workflowSend: (request: WorkflowRowsActionRequest, shouldStop?: (rowId: string) => boolean,
    diagnostics?: import("./model/publish-diagnostic").PublishDiagnosticDispatch) => sendRows(request, shouldStop, { diagnostics }),
  workflowPrepare: (request: PreparationRequest, onRow: (row: WorkflowOperationRowResult) => void, scope?: AutomationExecutionScope) => runRows(request, "prepare", onRow, scope),
  listingCardAttachVideo: async (request: WorkflowAttachVideoRequest) => {
    const card = await patchListingCard(request.draft_id, (payload) =>
      cardWithVideo(payload, request.metadata),
    )
    return cardLifecycle(card)
  },
  listingCardAttachVideoToProducts: async (request: ListingCardAttachVideoToProductsRequest) => {
    const media = cardPayload(await readListingCard(request.card_draft_id))
    const candidates = request.role === "cover" ? [media.videoCover] : media.videos
    const video = candidates.find((candidate) =>
      candidate !== undefined && videoIdentity(candidate) === request.video_identity,
    )
    if (!video) {
      throw refuse("workflow_media_binding_missing", "源商品没有可绑定的视频")
    }
    // As with autosave flushes, leave room in the Workspace write budget for preparation.
    return mapLimit(request.target_draft_ids, 3, async (targetId): Promise<WorkflowMediaBindingResult> => {
      try {
        const target = await mergeListingRow(targetId, (current) => ({
          media: mediaWithVideo(rowMedia(current), { ...video, role: request.role }),
        }))
        return { draft_id: targetId, lifecycle: rowStatusView(target).lifecycle }
      } catch (reason) {
        return { draft_id: targetId, error: commandMessage(reason) }
      }
    })
  },
  workflowPickVideo: async (request: WorkflowPickVideoRequest) => {
    const files = (await pickFiles(VIDEO_ACCEPT, request.selection_limit > 1)).slice(
      0,
      Math.max(request.selection_limit, 1),
    )
    return Promise.all(
      files.map(async (file): Promise<WorkflowPendingVideo> => ({
        asset_handle: stageFile(file),
        metadata: {
          role: request.role,
          origin: "managed_upload",
          file_name: file.name,
          content_type: file.type,
          size_bytes: file.size,
          duration_ms: await readVideoDurationMs(file),
        },
      })),
    )
  },
  listingCardUploadVideo: async (request: WorkflowUploadVideoRequest) => {
    const metadata = await uploadStagedVideo(request.asset_handle, request.role)
    const card = await patchListingCard(request.draft_id, (payload) =>
      cardWithVideo(payload, metadata),
    )
    return {
      metadata,
      public_url: metadata.public_url ?? "",
      object_key: metadata.object_key ?? "",
      lifecycle: cardLifecycle(card),
    }
  },
  workflowRemoveVideo: async (rowId: string, role: WorkflowVideoRole, identity?: string) => {
    const row = await mergeListingRow(rowId, (current) => ({
      media: mediaWithoutVideo(rowMedia(current), role, identity),
    }))
    return rowStatusView(row).lifecycle
  },
  listingCardRemoveVideo: async (
    cardId: string,
    role: WorkflowVideoRole,
    identity?: string,
  ) => {
    const card = await patchListingCard(cardId, (payload) =>
      cardWithoutVideo(payload, role, identity),
    )
    return cardLifecycle(card)
  },
  /**
   * A Product Instance's durable write.
   *
   * `PATCH … {draft}` re-runs the invalidation graph and the validator inside
   * the one CAS write, so the row's verdict can never describe a value it no
   * longer holds (`listing_api/rows.rs::write_draft`) — there is no second
   * "mark changed" call. Compare edited fields with their original values,
   * retain unrelated server changes, and CAS the merged Draft. The row revision
   * fences this write; it is not an independent authoring version.
   *
   * Target Store rides the same CAS write as the draft. Cloud invalidates the
   * derived rails when it changes; the workbench blocks sealed rows before
   * this command is called.
   */
  listingRowSaveDraft: async (view: WorkflowDraftView, baseline: WorkflowDraftView, fields?: ProductEditFields, known?: WorkflowDraftView): Promise<WorkflowProductSaveResult> => {
    for (let attempt = 0; ; attempt += 1) {
      try {
        // The durable autosave flush passes the stream-fed workbench view, so
        // the hot path owes no pre-PATCH GET. Programmatic
        // callers (quota moves, ribbon verbs) omit `known`: their workbench
        // view can be stale, and the server read is what "the actual
        // assignment" means. A CAS-conflict retry always re-reads.
        const knownNow = known !== undefined && attempt === 0 ? known : undefined
        const fetched = knownNow ? undefined : await readListingRow(view.draft_id)
        const current = knownNow
          ? { revision: knownNow.lifecycle.revision, storeId: knownNow.target_store_id || null, draft: knownNow.draft }
          : fetched!
        // The wire row spells the assignment `store_id`; a workbench view carries it as `target_store_id`.
        const currentStoreId = "storeId" in current ? current.storeId : current.store_id ?? null
        let edited
        try {
          edited = mergeProductEdit(baseline, view, {
            draft: current.draft,
            target_store_id: currentStoreId ?? "",
          }, true, fields)
        } catch (reason) {
          if (isProductEditConflict(reason)) {
            reason.current = rowSaveResult(view, fetched ?? await readListingRow(view.draft_id))
          }
          throw reason
        }
        const wanted = edited.target_store_id.trim()
        // Debounced autosave uses the full verdict. A light save would leave
        // validation and the build stamp stale, so a finished row read as
        // expired until the next send — a conscious trade of autosave write
        // budget for verdict freshness. `known` still skips the
        // pre-PATCH GET.
        const row = await patchListingRow(view.draft_id, {
          baseRevision: current.revision,
          draft: edited.draft,
          ...(wanted === (currentStoreId ?? "") ? {} : { storeId: wanted || null }),
        }, fetched ?? (() => readListingRow(view.draft_id)))
        return rowSaveResult(view, row)
      } catch (reason) {
        // Only a confirmed CAS refusal is safe to repeat; recompute the field merge on the fresh row.
        if (attempt > 0 || !reason || typeof reason !== "object" || !("status" in reason) || reason.status !== 409 ||
          ("code" in reason && reason.code === "cloud_schema_sync_required")) throw reason
      }
    }
  },
  // Source import lives in `source-import-actions.ts`; the facade keeps its verbs.
  workflowPickSourceAssets,
  workflowImportSourceAssets,
  workflowImportSourceAssetsStop,
  workflowImportPromptPath: async (_path?: string) => {
    const [file] = await pickFiles(PROMPT_ACCEPT)
    if (!file) throw refuse("workflow_prompt_cancelled", "未选择提示词文件")
    return { file_name: file.name, content: await file.text() }
  },
  /**
   * The admin prompt importer's directory walk. `<input webkitdirectory>`
   * hands back every file with its `webkitRelativePath`, so the l1/l2/type
   * names come straight off the path the operator picked. Only the brief body
   * is read: `.fixed-tags.txt` sidecars are eval inputs (ADR-0103),
   * so they are ignored rather than reported as skipped.
   */
  workflowScanPromptDir: async (): Promise<WorkflowPromptDirScan> => {
    const files = await pickDirectory()
    const entries: WorkflowPromptDirEntry[] = []
    const skipped: string[] = []
    let root = ""
    for (const file of files) {
      const path = file.webkitRelativePath || file.name
      const [pickedRoot, l1_name, l2_name, type_name, ...rest] = path.split("/")
      root ||= pickedRoot ?? ""
      const file_name = rest.length === 1 ? rest[0]! : ""
      if (file_name.toLowerCase().endsWith(".fixed-tags.txt")) {
        continue
      }
      const isPrompt = PROMPT_ACCEPT.split(",").some((ext) =>
        file_name.toLowerCase().endsWith(ext),
      )
      if (!l1_name || !l2_name || !type_name || !isPrompt) {
        skipped.push(path)
        continue
      }
      entries.push({
        l1_name,
        l2_name,
        type_name,
        name: file_name.replace(/\.[^.]+$/, ""),
        file_name,
        content: await file.text(),
      })
    }
    return { root, entries, skipped }
  },
  videoPoolUploadVideo: async (request: VideoPoolUploadRequest) => {
    const file = stagedFile(request.asset_handle)
    if (!file) throw refuse("workflow_video_handle_missing", "视频文件已失效，请重新选择")
    const metadata = await uploadStagedVideo(request.asset_handle, "product")
    return {
      file_name: metadata.file_name,
      public_url: metadata.public_url ?? "",
      duration_ms: metadata.duration_ms,
    }
  },
  workflowAnalyzeAssetsStop: async (rowIds: readonly string[]) => requestStop(rowIds),
  /** Cloud's one-CAS reset keeps identity and videos while clearing generated data. */
  workflowClearGeneratedContent: (request: WorkflowClearGeneratedContentRequest) =>
    Promise.all(
      request.draft_ids.map(
        async (rowId): Promise<WorkflowClearGeneratedContentItemResult> => {
          try {
            const current = await readListingRow(rowId)
            const row = await patchListingRow(rowId, {
              baseRevision: current.revision,
              clearGeneratedContent: true,
            })
            return { draft_id: rowId, row, status: rowStatusView(row) }
          } catch (reason) {
            return {
              draft_id: rowId,
              error: { code: "workflow_clear_failed", message: commandMessage(reason), remediation: null },
            }
          }
        },
      ),
    ),
}
