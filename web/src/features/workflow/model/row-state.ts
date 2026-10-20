/** Cloud owns the row semantics; this adapter only copies them into the workbench view. */
import type {
  FieldLayerView, WorkflowAiCandidate, WorkflowAiSummary, WorkflowCategoryDraft,
  WorkflowDraftValidationState, WorkflowFailureLogEntry, WorkflowImageLifecycle,
  WorkflowProductLifecycle, WorkflowProductStatusView, WorkflowVideoMetadata,
} from "@/bindings/commands"
import { rowQueuePosition, type ListingRowView } from "@/bindings/listing-projection"

/** The row payload sections this module reads, typed off `RowPayload`. */
interface RowSections {
  draft?: WorkflowCategoryDraft
  media?: {
    images?: WorkflowImageLifecycle[]
    videos?: WorkflowVideoMetadata[]
    videoCover?: WorkflowVideoMetadata
  }
  ai?: {
    candidates?: WorkflowAiCandidate[]
    summary?: WorkflowAiSummary
    promptSha256?: string
    modelVersion?: string
  }
  source?: { assetId?: string; sha256?: string; fileName?: string }
  failureLog?: WorkflowFailureLogEntry[]
  renderEvidence?: { sliceCount?: number; degradations?: string[] }
}

function sections(row: ListingRowView): RowSections {
  const payload = (row.payload ?? {}) as Record<string, unknown>
  return {
    draft: row.draft as WorkflowCategoryDraft | undefined,
    media: row.media as RowSections["media"],
    ai: row.ai as RowSections["ai"],
    source: row.source as RowSections["source"],
    failureLog: payload.failureLog as WorkflowFailureLogEntry[] | undefined,
    renderEvidence: row.render_evidence as RowSections["renderEvidence"],
  }
}

function importFollowupOf(
  followup: ListingRowView["projection"]["import_followup"],
): WorkflowProductLifecycle["importFollowup"] {
  const detail = followup?.detail?.trim()
  if (!followup || !detail) return undefined
  return { phase: followup.phase, detail }
}

function importProbeOf(
  probe: ListingRowView["projection"]["import_probe"],
): WorkflowProductLifecycle["importProbe"] {
  if (!probe) return undefined
  const next = probe.next_check_at_ms
  return {
    phase: probe.phase,
    passes: probe.passes,
    nextCheckAtMs: typeof next === "number" ? next : undefined,
  }
}

function rowLifecycle(row: ListingRowView): WorkflowProductLifecycle {
  const parts = sections(row)
  const candidates = parts.ai?.candidates ?? []
  const failureLog = parts.failureLog ?? []
  const projection = row.projection
  return {
    revision: row.revision,
    view_revision: row.view_revision,
    stage: row.projection.stage,
    ai: row.projection.ai,
    media: row.projection.media,
    media_failure_stage: row.projection.media_failure_stage ?? undefined,
    image_total: row.projection.image_total,
    image_completed: row.projection.image_completed,
    fields: row.projection.fields,
    images: parts.media?.images ?? [],
    failure_log: failureLog,
    queue_position: rowQueuePosition(row),
    ai_candidates: candidates,
    ai_summary: parts.ai?.summary,
    listing_draft_ref: {
      draft_id: row.id,
      draft_revision: row.revision,
      schema_revision: String(
        (row.payload as Record<string, unknown> | undefined)?.schemaRevision ?? "",
      ),
    },
    source_file_name: parts.source?.fileName,
    // OPFS key is `{sha256}/{fileName}` (`workflow-actions.ts` sourceHandle). sha256
    // alone cannot restore the file on reopen.
    // The write side always composes `{sha256}/{fileName}` — a bare sha256
    // can never match a stored file, so leave the handle undefined instead
    // of fabricating an unrestorable key.
    source_asset_handle:
      parts.source?.sha256 && parts.source?.fileName
        ? `${parts.source.sha256}/${parts.source.fileName}`
        : undefined,
    product_videos: parts.media?.videos ?? [],
    video_cover: parts.media?.videoCover,
    last_error_code: row.projection.error_code ?? undefined,
    run_id: row.projection.run_id ?? undefined,
    ozon_sku: row.projection.sku ?? undefined,
    ozon_product_id: row.projection.product_id ?? undefined,
    last_error_detail: row.projection.error_detail ?? undefined,
    submission_issue: row.projection.submission_issue ?? undefined,
    importProbe: importProbeOf(row.projection.import_probe),
    importFollowup: importFollowupOf(row.projection.import_followup),
    submissionReceipt: projection.submission_receipt ?? undefined,
    taskId: projection.task_id ?? undefined,
  }
}

/** Translate the wire verdict into the editor's existing vocabulary. */
export function draftValidationState(state: string): WorkflowDraftValidationState {
  return state === "passed" ? "valid" : state === "blocked" ? "invalid" : "draft"
}

/**
 * The build sources flattened to plain field keys — the workbench columns are
 * all plain addresses, so the cell marker looks its field up here. Complex
 * addresses (groups) stay unflattened; no workbench column renders one yet.
 */
export function buildSourceLayers(row: ListingRowView): Record<string, FieldLayerView> | undefined {
  const sources = row.build?.sources
  if (!sources?.length) return undefined
  const layers: Record<string, FieldLayerView> = {}
  for (const source of sources) {
    if (source.address.kind === "plain") layers[source.address.field_key] = source.layer
  }
  return Object.keys(layers).length ? layers : undefined
}

export function rowStatusView(row: ListingRowView): WorkflowProductStatusView {
  return {
    lifecycle: rowLifecycle(row),
    readiness: row.projection.readiness,
    target_store_id: row.store_id ?? "",
    draft: row.draft,
    validation_state: draftValidationState(row.validation_state),
    issues: row.validation_issues,
    source_layers: buildSourceLayers(row),
  }
}
