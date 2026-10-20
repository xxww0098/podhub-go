/**
 * Source import: stage picked files into OPFS under their own identity, then
 * file one Product Instance per file no loaded row already carries.
 *
 * Staging and filing are separate steps so the batch owner
 * (`product-instances.ts::importSourcePaths`) can restore rows whose local
 * source went missing between them — with the identity it already staged, no
 * second hash or OPFS write, and no Cloud request. Stopping is cooperative
 * across both steps: a batch opens one stop fence and checks it between files.
 */
import { fileBytes, pickFiles, SOURCE_ACCEPT, stageFile, stagedFile } from "@/bindings/file-picker"
import {
  cardPayload,
  rowHandEditedKeys,
  type CardPayload,
  type ListingRowView,
} from "@/bindings/listing-projection"
import { cardCategorySchema, createListingRowOnce, readListingCard } from "@/bindings/http-listing"
import type { ListingRowAssociation } from "@/bindings/http-listing"
import type {
  CategorySchemaView,
  CommandError,
  WorkflowDraftView,
  WorkflowImportSourceBatchItem,
  WorkflowImportSourceBatchItemResult,
  WorkflowImportSourceBatchRequest,
  WorkflowPickedSource,
  WorkflowPickSourceBatchRequest,
} from "@/bindings/commands"
import { device, errorFields } from "./prepare/execution-context"
import { draftValidationState, rowStatusView } from "./model/row-state"
import { mapLimit } from "./source-batch"

/**
 * One Cloud row as a Product Instance Draft. The Card cohort read
 * (`workflowActions.listingCardListProductInstances`) adapts rows the same way.
 *
 * The prompt, the template and the AI policy are the card's — a row is pinned
 * to the card that produced it — and the schema is the card's too, because
 * `seed_row_payload` pins every row of a cohort to the card's coordinate.
 */
export function rowDraftView(
  row: ListingRowView,
  card: CardPayload,
  schema: CategorySchemaView,
): WorkflowDraftView {
  return {
    draft_id: row.id,
    kind: "instance",
    display_name: "",
    schema,
    draft: row.draft,
    validation_state: draftValidationState(row.validation_state),
    issues: row.validation_issues,
    ai_prompt_id: card.aiPromptId,
    ai_prompt: card.aiPrompt,
    ai_prompt_file_name: card.aiPromptFileName,
    psd_template_asset_id: card.psdTemplateSha256 || card.psdTemplateAssetId,
    psd_template_file_name: card.psdTemplateFileName,
    target_store_id: row.store_id ?? "",
    ai_field_policy: card.aiFieldPolicy,
    parent_card_id: row.card_id,
    lifecycle: rowStatusView(row).lifecycle,
    updated_at_ms: row.updated_at_ms,
    hand_edited_keys: rowHandEditedKeys(row),
    source_layers: rowStatusView(row).source_layers,
  }
}

const SOURCE_IMPORT_CONCURRENCY = 4

let sourceImportStopGeneration = 0

/** One batch's stop fence: true once Stop was pressed after the batch opened. */
export function openSourceImportBatch(): () => boolean {
  const generation = sourceImportStopGeneration
  return () => generation !== sourceImportStopGeneration
}

/**
 * A picked file already written to OPFS. `handle` is `{sha256}/{fileName}` —
 * the digest of the original bytes and the original name, both as-is — which
 * is exactly what a Product Instance carries as `lifecycle.source_asset_handle`.
 */
export type StagedSource = { sha256: string, fileName: string, handle: string }

export type SourceStage =
  | { staged: StagedSource, error?: undefined }
  | { staged?: undefined, error: CommandError }

function cancelledError(): CommandError {
  return { code: "workflow_source_import_cancelled", message: "已停止导入", remediation: null }
}

function importError(reason: unknown): CommandError {
  return {
    code: (reason as { code?: string }).code ?? "workflow_source_import_failed",
    message: errorFields(reason).message,
    remediation: (reason as { remediation?: string | null }).remediation ?? null,
  }
}

async function stageSource(path: string): Promise<SourceStage> {
  const file = stagedFile(path)
  if (!file) {
    return {
      error: {
        code: "workflow_source_missing",
        message: "该图片已不在本次会话中，请重新选择",
        remediation: null,
      },
    }
  }
  try {
    // Through the executor's device seam: import is a device+route job like
    // every other one, and a test drives it without a browser.
    const sha256 = await device.putSource(await fileBytes(file), file.name)
    return { staged: { sha256, fileName: file.name, handle: `${sha256}/${file.name}` } }
  } catch (reason) {
    return { error: importError(reason) }
  }
}

/** Write each picked file to OPFS once, in input order. Nothing leaves the device. */
export function stageSourcePaths(
  paths: readonly string[],
  stopped: () => boolean,
): Promise<SourceStage[]> {
  return mapLimit(paths, SOURCE_IMPORT_CONCURRENCY, async (path) =>
    stopped() ? { error: cancelledError() } : stageSource(path),
  )
}

/**
 * The create identity of one same-design import item: the association inputs
 * plus one stable create key per (Card + selected source image) for the whole
 * batch. The key is operation identity, never a design identity, and a replay
 * of it is a replay of the same row.
 */
export type SourceImportIdentity = {
  createKey: string
  requestFingerprint: string
  association: ListingRowAssociation
}

/**
 * What the batch owner already knows about a create request. `staged` lines up
 * with `request.items`; `stopped` is the owner's fence (Stop plus its own
 * context), checked before every file.
 */
export type SourceImportPlan = {
  staged?: readonly SourceStage[]
  stopped?: () => boolean
  /**
   * Per-item create identity, aligned with `request.items`. Only the opt-in
   * same-design import sets it; an ordinary import leaves it absent and keeps
   * today's plain create byte for byte.
   */
  identities?: readonly (SourceImportIdentity | undefined)[]
}

async function importOneSource(
  cardId: string,
  card: CardPayload,
  schema: CategorySchemaView,
  item: WorkflowImportSourceBatchItem,
  index: number,
  staged: StagedSource,
  stopped: () => boolean,
  identity?: SourceImportIdentity,
): Promise<WorkflowImportSourceBatchItemResult> {
  if (stopped()) return { input_index: index, error: cancelledError() }
  try {
    // A replay of the create key is success: the server answers with the row
    // the key already named, so a retry, a refresh and a concurrent duplicate
    // all converge on one Product Instance. The browser never mints a second
    // key to get around a refusal — a conflicting key surfaces as an error.
    const { row } = await createListingRowOnce(card, {
      cardId,
      storeId: item.target_store_id.trim() || undefined,
      source: { sha256: staged.sha256, fileName: staged.fileName },
      ...(identity
        ? {
            createKey: identity.createKey,
            requestFingerprint: identity.requestFingerprint,
            association: identity.association,
          }
        : {}),
    })
    return {
      input_index: index,
      product: rowDraftView(row, card, schema),
      source: { handle: staged.handle, file_name: staged.fileName },
      status: rowStatusView(row),
    }
  } catch (reason) {
    return { input_index: index, error: importError(reason) }
  }
}

export async function workflowPickSourceAssets(request: WorkflowPickSourceBatchRequest) {
  const limit = Math.max(request.selection_limit, 1)
  if (request.paths.length > 0) {
    return request.paths.slice(0, limit).map((path): WorkflowPickedSource => {
      const file = stagedFile(path)
      if (!file) {
        return { file_name: path, path, error: "本机没有该源图，请重新选择" }
      }
      return { file_name: file.name, path }
    })
  }
  const files = (await pickFiles(SOURCE_ACCEPT, true)).slice(0, limit)
  return files.map((file): WorkflowPickedSource => ({
    file_name: file.name,
    path: stageFile(file),
  }))
}

/**
 * Import: one picked file becomes one Product Instance and nothing else.
 *
 * The bytes go to OPFS under their own digest and only the digest travels —
 * Cloud never sees a source image. Files are staged first (unless the plan
 * already did), and the Card and its Schema are read only when at least one
 * file will actually be filed. Stopping is cooperative: it takes effect
 * between files, and an in-flight create is allowed to settle because the row
 * it makes is already real.
 */
export async function workflowImportSourceAssets(
  request: WorkflowImportSourceBatchRequest,
  onItem: (item: WorkflowImportSourceBatchItemResult) => void,
  plan: SourceImportPlan = {},
): Promise<WorkflowImportSourceBatchItemResult[]> {
  const stopped = plan.stopped ?? openSourceImportBatch()
  const stages = plan.staged
    ?? await stageSourcePaths(request.items.map((item) => item.path), stopped)
  const filing = !stopped() && stages.some((stage) => stage.staged)
  const card = filing ? cardPayload(await readListingCard(request.card_draft_id)) : undefined
  const schema = card ? await cardCategorySchema(card) : undefined
  return mapLimit(request.items, SOURCE_IMPORT_CONCURRENCY, async (item, index) => {
    const stage = stages[index]
    const result: WorkflowImportSourceBatchItemResult = !stage
      ? { input_index: index, error: importError(new Error("源图没有暂存结果")) }
      : !stage.staged
        ? { input_index: index, error: stage.error }
        : !card || !schema
          ? { input_index: index, error: cancelledError() }
          : await importOneSource(request.card_draft_id, card, schema, item, index, stage.staged, stopped, plan.identities?.[index])
    onItem(result)
    return result
  })
}

export async function workflowImportSourceAssetsStop() {
  sourceImportStopGeneration++
}
