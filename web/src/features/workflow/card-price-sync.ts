/**
 * 名册默认列的另一半：卡默认落库后把同一字段盖进不会自动跟随的行。
 *
 * 没标记过的行（CardDefault 兜底）显示与发送都跟着卡默认，不必写；
 * 手改过或被清掉的行按卡默认盖回来，格子才和名册一致。发送中与已
 * 封板的行不动——值由冻结的意图或 Ozon 侧决定。
 *
 * 四个 tableInput 字段共用这一条：销售价 / 划线价 / 主题 / JSON富内容。
 * 值相不相等只问 `valuesEqual`。比较在浏览器 WASM 里完成，这里不比较，也不再请求 Cloud。
 */
import {
  cardRows,
  fieldValuesEqual,
  patchListingRow,
  readListingRow,
  type FieldEqualityEditor,
} from "@/bindings/http-listing"
import {
  rowHandEditedKeys,
  withDefaultFieldValue,
  type ListingRowView,
} from "@/bindings/listing-projection"
import type { WorkflowDraftValue } from "@/bindings/commands"
import { readWorkflowValue } from "./workflow-draft"
import { lifecycleSealed } from "./model/listing-row-lifecycle"
import { rowStatusView } from "./model/row-state"
import { mapLimit } from "./source-batch"

const ROW_FIELD_SYNC_CONCURRENCY = 4

export type { FieldEqualityEditor }

export type CardFieldSyncDeps = {
  cardRows: (cardId: string) => Promise<ListingRowView[]>
  patchListingRow: (
    rowId: string,
    body: Record<string, unknown>,
    row?: ListingRowView,
  ) => Promise<ListingRowView>
  readListingRow: (rowId: string) => Promise<ListingRowView>
  valuesEqual: (
    editor: FieldEqualityEditor,
    left: WorkflowDraftValue | undefined,
    right: WorkflowDraftValue | undefined,
  ) => Promise<boolean>
}

export type CardFieldSyncResult = {
  updated: number
  failed: number
  conflicts: number
}

type RowOutcome = "updated" | "failed" | "conflict"

function equalityEditor(
  fieldKey: string,
  left: WorkflowDraftValue | undefined,
  right: WorkflowDraftValue | undefined,
): FieldEqualityEditor {
  if (fieldKey === "price" || fieldKey === "old_price") return "decimal"
  const kind = left?.kind ?? right?.kind
  switch (kind) {
    case "decimal":
    case "decimal_list":
      return "decimal"
    case "integer":
    case "integer_list":
      return "integer"
    case "single_select":
    case "multi_select":
      return "dictionary"
    case "boolean":
    case "boolean_list":
      return "boolean"
    case "url":
    case "url_list":
      return "url"
    default:
      return "text"
  }
}

export async function syncCardFieldToRows(
  cardId: string,
  fieldKey: string,
  value: WorkflowDraftValue | undefined,
  deps: CardFieldSyncDeps = {
    cardRows,
    patchListingRow,
    readListingRow,
    valuesEqual: fieldValuesEqual,
  },
): Promise<CardFieldSyncResult> {
  const same = (
    left: WorkflowDraftValue | undefined,
    right: WorkflowDraftValue | undefined,
  ) => deps.valuesEqual(equalityEditor(fieldKey, left, right), left, right)
  const diverged = async (row: ListingRowView) => {
    const lifecycle = rowStatusView(row).lifecycle
    if (
      lifecycleSealed(lifecycle) ||
      lifecycle.stage === "queued" ||
      lifecycle.stage === "submitting" ||
      lifecycle.ai === "running"
    ) {
      return false
    }
    const marked =
      rowHandEditedKeys(row).includes(fieldKey) ||
      (row.draft.cleared ?? []).includes(fieldKey)
    if (!marked) return false
    return !(await same(readWorkflowValue(row.draft, fieldKey), value))
  }
  const targets = []
  for (const row of await deps.cardRows(cardId)) {
    if (await diverged(row)) targets.push(row)
  }
  const outcomes = await mapLimit(
    targets,
    ROW_FIELD_SYNC_CONCURRENCY,
    async (target): Promise<RowOutcome> => {
      let row = target
      const original = readWorkflowValue(row.draft, fieldKey)
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          await deps.patchListingRow(
            row.id,
            {
              baseRevision: row.revision,
              draft: withDefaultFieldValue(row.draft, fieldKey, value),
            },
            row,
          )
          return "updated"
        } catch (reason) {
          if (attempt === 0 && (reason as { status?: number }).status === 409) {
            try {
              row = await deps.readListingRow(row.id)
            } catch {
              return "failed"
            }
            const latest = readWorkflowValue(row.draft, fieldKey)
            if (await same(latest, value)) return "updated"
            if (await same(latest, original)) continue
            return "conflict"
          }
          return "failed"
        }
      }
      return "failed"
    },
  )
  return {
    updated: outcomes.filter((outcome) => outcome === "updated").length,
    failed: outcomes.filter((outcome) => outcome === "failed").length,
    conflicts: outcomes.filter((outcome) => outcome === "conflict").length,
  }
}
