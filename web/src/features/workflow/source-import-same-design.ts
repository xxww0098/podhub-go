/**
 * 同源多规格导入 —— the opt-in same-design import (spec slice 02, items 4-8).
 *
 * One supplier design (a 货源库 plus a non-empty 款号) holds several sizes.
 * Importing them as ONE design means: every size keeps its own `fromSupplier`
 * Card with its own PSD, current supply fact, size, prompt and defaults, while
 * the new rows share one derived 型号 and one association batch key so Ozon
 * groups them.
 *
 * What this module is, and is not:
 *
 * - It is a **coordinator**. Every Card is created or fetched atomically by the
 *   server (`listingCardCreateFromSupplier`) and every row is filed through the
 *   existing per-card path (`workflowImportSourceAssets`). The bytes are staged
 *   to OPFS once for the whole batch and each Card gets its own input context:
 *   nothing here rotates the open workbench Card, and stop/resume/scope-fence
 *   stay bound to whichever Card the workbench has open.
 * - It is not a client-side identity. It sends the association *inputs*
 *   (`sourceId` + `variantGroup`) and one stable create key per (Card + selected
 *   source image). Cloud derives the batch key, the common 型号 and the frozen
 *   grouping digest, and re-checks the Card's own supplier binding — so nothing
 *   here can override a server-side binding.
 * - It does not redistribute Stores. Every row of the batch is created against
 *   the one Store the caller resolved (`storeId`), because a per-card quota must
 *   never split one design across Stores. A later rebinding is the operator's
 *   explicit decision, not this import's.
 */
import { cardPayload, type CardPayload } from "@/bindings/listing-projection"
import type { WorkflowImportSourceBatchItemResult } from "@/bindings/commands"
import { refuse } from "@/bindings/refusal"
import { listingHttp } from "@/bindings/http-listing"
import { readListingCard } from "@/bindings/http-listing"
import { stagedFile } from "@/bindings/file-picker"
import { listingCardSavePsd } from "./card/card-writes"
import { workflowActions } from "./workflow-actions"
import {
  openSourceImportBatch,
  stageSourcePaths,
  type SourceImportIdentity,
} from "./source-import-actions"
import {
  mapImportItemResult,
  type SourceImportItemOutcome,
  type SourceImportResult,
} from "./product-instances"
import { commandError } from "./workflow-shared"
import { listingScopeCurrent, listingWorkbenchScope } from "./workbench/listing-workbench-store"

/** One size of a same-design import: its queue identity and its own source image. */
export type SameDesignSizeInput = {
  /** The supplier row this size was picked from. */
  productId: string
  /** `sc_products.source_id`: the supplier database the design came from. */
  sourceId: string
  /** The supplier row's 款号. Empty is refused: 空款号不自动关联. */
  variantGroup: string
  title: string
  size?: string
  /** The picked source image for THIS size (a staging handle). */
  path: string
  /** PSD the queue entry carried; applied only to a Card this batch creates. */
  psd?: { sha256: string, fileName: string }
}

export type SameDesignImportInput = {
  sizes: readonly SameDesignSizeInput[]
  /**
   * The one Store every Card of this batch uses. It is a *creation* parameter:
   * an empty one would let each Card fall back to its own binding and split one
   * design across Stores, so it is refused before anything is created.
   */
  storeId: string
  importedLog: string
  onItem?: (item: SourceImportItemOutcome) => void
}

/** One stable create key per (Card + selected source image) for the whole batch. */
export function sameDesignCreateKey(cardId: string, sha256: string): string {
  return `sd:${cardId.trim().toLowerCase()}:${normalizeSha256(sha256)}`
}

/**
 * The client's own content declaration for that key. It is input, never
 * authority: Cloud folds it into the digest it stores, so keeping the key while
 * changing what it declares is a refusal rather than a silent replay.
 */
export function sameDesignRequestFingerprint(productId: string): string {
  return `sd-fp:${productId.trim()}`
}

function normalizeSha256(value: string): string {
  const trimmed = value.trim().toLowerCase()
  return (trimmed.startsWith("sha256:") ? trimmed.slice("sha256:".length) : trimmed).slice(0, 64)
}

/**
 * The queue entries an opt-in same-design import can cover: same supplier
 * database and same NON-EMPTY 款号. An empty variant group never associates, so
 * it is never grouped here either.
 */
export function sameDesignKey(
  size: { sourceId: string, variantGroup?: string },
): string {
  return `${size.sourceId.trim()}\u0000${(size.variantGroup ?? "").trim()}`
}

/** One design the operator can import as an association. */
export type SameDesignGroup = {
  /** 货源库 + 款号: the identity the server re-checks. */
  sourceId: string
  variantGroup: string
  /** The sizes of this design, in list order. */
  sizes: SameDesignSizeInput[]
}

/** What a same-design group needs from one selection-list entry. */
export type SameDesignCandidate = {
  productId: string
  sourceId: string
  variantGroup?: string
  title: string
  size?: string
  path: string
  psd?: { sha256: string, fileName: string }
}

/**
 * The designs a batch could cover: same supplier database and same NON-EMPTY
 * 款号, at least two sizes.
 *
 * This is the opt-in's own selection surface — the operator picks one group
 * and only then does anything import. An empty 款号 never appears here, the
 * same way it never associates on the server, and a design whose sizes are
 * already covered is the caller's to filter.
 */
export function sameDesignGroups(
  entries: readonly SameDesignCandidate[],
): SameDesignGroup[] {
  const groups = new Map<string, SameDesignGroup>()
  for (const entry of entries) {
    if (!entry.sourceId.trim() || !entry.variantGroup?.trim()) continue
    const key = sameDesignKey(entry)
    const group = groups.get(key) ?? {
      sourceId: entry.sourceId.trim(),
      variantGroup: entry.variantGroup.trim(),
      sizes: [],
    }
    group.sizes.push({
      productId: entry.productId,
      sourceId: group.sourceId,
      variantGroup: group.variantGroup,
      title: entry.title,
      ...(entry.size ? { size: entry.size } : {}),
      path: entry.path,
      ...(entry.psd ? { psd: entry.psd } : {}),
    })
    groups.set(key, group)
  }
  return [...groups.values()].filter((group) => group.sizes.length > 1)
}

/**
 * Import one design's sizes as one association.
 *
 * Bytes are staged once, then each size files its own Card through the
 * existing per-card path with its own create key. A partial failure keeps every
 * row and key it already created: the answer reports per-item outcomes, and
 * re-running the same batch replays those keys instead of creating a second row.
 */
export async function importSameDesignSizes(
  input: SameDesignImportInput,
): Promise<SourceImportResult> {
  const storeId = input.storeId.trim()
  if (!storeId) {
    throw refuse(
      "workflow_same_design_store_required",
      "同源多规格导入必须先选定一个共同店铺",
      "请在上架清单里为这批规格指定同一个目标店铺。",
    )
  }
  const scope = listingWorkbenchScope()
  const stopRequested = openSourceImportBatch()
  const stopped = () => stopRequested() || !listingScopeCurrent(scope)
  const labels = input.sizes.map(
    (size) => stagedFile(size.path)?.name ?? size.title,
  )
  const rows: SourceImportResult["rows"] = []
  const products: SourceImportResult["products"] = {}
  const failures: string[] = []
  let cancelled = 0
  let presentFiles = 0
  const settle = (outcome: SourceImportItemOutcome) => {
    if (outcome.cancelled) {
      cancelled += 1
      return
    }
    // A replay is success: the row is the one the create key already named, and
    // the workbench shows the same Product Instance either way.
    if (outcome.failure) failures.push(outcome.failure)
    if (outcome.row) rows.push(outcome.row)
    if (outcome.product) products[outcome.product.draft_id] = outcome.product
    input.onItem?.(outcome)
  }

  const stages = await stageSourcePaths(input.sizes.map((size) => size.path), stopped)
  for (const [index, size] of input.sizes.entries()) {
    const label = labels[index] ?? size.title
    if (stopped()) {
      cancelled += 1
      continue
    }
    const stage = stages[index]
    if (!stage?.staged) {
      failures.push(`${label}：${commandError(stage?.error, "源图暂存失败")}`)
      continue
    }
    if (!size.sourceId.trim() || !size.variantGroup.trim()) {
      failures.push(`${label}：该选品没有款号，不能用于同源多规格导入`)
      continue
    }
    let cardId: string
    try {
      // Atomic create-or-get on the server: a Card that already exists is
      // returned with its own bindings untouched.
      cardId = (await listingHttp.listingCardCreateFromSupplier(size.productId)).id
    } catch (reason) {
      failures.push(`${label}：${commandError(reason, "无法建立上架方案")}`)
      continue
    }
    if (stopped()) {
      cancelled += 1
      continue
    }
    if (size.psd) presentFiles += await adoptQueuedPsd(cardId, size.psd, label, failures)
    const identity: SourceImportIdentity = {
      createKey: sameDesignCreateKey(cardId, stage.staged.sha256),
      requestFingerprint: sameDesignRequestFingerprint(size.productId),
      association: {
        supplierSourceId: size.sourceId.trim(),
        variantGroup: size.variantGroup.trim(),
      },
    }
    let results: WorkflowImportSourceBatchItemResult[]
    try {
      results = await workflowActions.workflowImportSourceAssets(
        {
          card_draft_id: cardId,
          items: [{ path: size.path, target_store_id: storeId }],
        },
        () => {},
        { staged: [stage], stopped, identities: [identity] },
      )
    } catch (reason) {
      failures.push(`${label}：${commandError(reason, "图片导入失败")}`)
      continue
    }
    if (!results.length) {
      failures.push(`${label}：图片导入没有返回结果`)
      continue
    }
    for (const result of results) {
      // Resolve the label using this Card's local index, then expose the
      // original design-batch index to the caller's progress callback.
      const outcome = mapImportItemResult(
        result,
        [{ label, path: size.path }],
        input.importedLog,
      )
      settle({ ...outcome, inputIndex: index })
    }
  }
  return {
    rows,
    products,
    failures,
    cancelled,
    restoredRows: 0,
    presentFiles,
    heldFiles: 0,
  }
}

/**
 * A Card this batch created adopts the queue entry's PSD template; a Card that
 * already carries one keeps its own binding (取得既有卡时保留其绑定). The
 * operator changes a bound Card's PSD through the existing explicit edit.
 *
 * Returns 1 when the batch filed a source for a Card it left unbound, so the
 * caller's "nothing new was needed" count stays honest.
 */
async function adoptQueuedPsd(
  cardId: string,
  psd: { sha256: string, fileName: string },
  label: string,
  failures: string[],
): Promise<number> {
  if (!psd.sha256.trim()) return 0
  let current: CardPayload
  try {
    current = cardPayload(await readListingCard(cardId))
  } catch {
    return 0
  }
  if ((current.psdTemplateSha256 || current.psdTemplateAssetId || "").trim()) return 0
  try {
    await listingCardSavePsd(cardId, psd.sha256, psd.fileName)
  } catch (reason) {
    // The Card exists and the row can still be filed; the binding is the
    // operator's to retry, so it is reported and does not stop the batch.
    failures.push(`${label}：PSD 模板未绑上，${commandError(reason, "请在上架方案里重新绑定")}`)
  }
  return 0
}
