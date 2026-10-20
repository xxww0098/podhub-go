// Shared `RowRepo` behavior contract. Kept free of any Bun/Node test-runner
// import on purpose: `row-repo.test.ts` (Bun) and `web/tests/row-store.browser.tsx`
// (real browser, bundled by Vite) both call `runRowRepoContract` directly, and
// `node:test`/`bun:test` do not resolve in a Vite browser bundle. Plain
// `check()` assertions keep this file runnable in both environments.

import type { RowRepo } from "./row-repo"
import type { CardLocalState, LocalRow } from "./types"
import type { WbPreviewRow } from "./wb-preview-rows"

function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`RowRepo contract violation: ${message}`)
}

/** Builds a fully-formed LocalRow for tests. `row`/`verdict` default to arbitrary opaque JSON to exercise verbatim round-tripping. */
export function sampleLocalRow(overrides: Partial<LocalRow> = {}): LocalRow {
  const now = Date.now()
  return {
    v: 1,
    id: crypto.randomUUID(),
    workspaceUuid: "ws-1",
    cardId: "card-1",
    position: 0,
    createdAtMs: now,
    updatedAtMs: now,
    rev: 1,
    row: { title: "opaque lean row", nested: { a: [1, 2, 3] } },
    verdict: { ok: true, issues: [] },
    ...overrides,
  }
}

/** Exercises the full `RowRepo` interface. Call once per implementation. */
export async function runRowRepoContract(repo: RowRepo): Promise<void> {
  const row = sampleLocalRow({ id: "contract-row-1" })
  await repo.putRows([row])
  const afterPut = await repo.rowsOfCard(row.workspaceUuid, row.cardId)
  check(afterPut.length === 1, "rowsOfCard must return the row just written")
  check(
    JSON.stringify(afterPut[0]) === JSON.stringify(row),
    "row must round-trip verbatim, including opaque row/verdict blobs",
  )

  // Isolation by workspace + card: a row filed under a different card or
  // workspace must never leak into rowsOfCard's result.
  const otherCardRow = sampleLocalRow({ id: "contract-row-2", cardId: "card-2" })
  const otherWorkspaceRow = sampleLocalRow({ id: "contract-row-3", workspaceUuid: "ws-2" })
  await repo.putRows([otherCardRow, otherWorkspaceRow])
  const stillOne = await repo.rowsOfCard(row.workspaceUuid, row.cardId)
  check(
    stillOne.length === 1 && stillOne[0]?.id === row.id,
    "rowsOfCard must not leak rows from other cards or workspaces",
  )

  // putRows batches multiple rows into a single call.
  const batchA = sampleLocalRow({ id: "contract-row-4", cardId: "card-3" })
  const batchB = sampleLocalRow({ id: "contract-row-5", cardId: "card-3" })
  await repo.putRows([batchA, batchB])
  const batch = await repo.rowsOfCard("ws-1", "card-3")
  check(batch.length === 2, "putRows must write every row in the batch")

  // putRows upserts an existing row by id rather than duplicating it.
  const updated = sampleLocalRow({ id: "contract-row-1", rev: 2, row: { title: "changed" } })
  await repo.putRows([updated])
  const afterUpdate = await repo.rowsOfCard(row.workspaceUuid, row.cardId)
  check(
    afterUpdate.length === 1 && afterUpdate[0]?.rev === 2,
    "putRows must overwrite an existing row by id, not duplicate it",
  )

  // deleteRows removes exactly the given ids, and a missing id is a no-op.
  await repo.deleteRows([otherCardRow.id])
  const afterDelete = await repo.rowsOfCard(otherCardRow.workspaceUuid, otherCardRow.cardId)
  check(afterDelete.length === 0, "deleteRows must remove the row")
  await repo.deleteRows(["does-not-exist"])

  // Empty batches are harmless no-ops.
  await repo.putRows([])
  await repo.deleteRows([])

  // Card state: absent by default, round-trips after a write, isolated per workspace+card.
  const missing = await repo.cardState("ws-1", "card-absent")
  check(missing === undefined, "cardState must be undefined before any write")
  const state: CardLocalState = {
    workspaceUuid: "ws-1",
    cardId: "card-1",
    queue: { frozenRowIds: ["r1"], nextPosition: 5, paused: false, stopAfterCurrent: false },
  }
  await repo.putCardState(state)
  const readState = await repo.cardState("ws-1", "card-1")
  check(JSON.stringify(readState) === JSON.stringify(state), "cardState must round-trip verbatim")
  const otherWorkspaceState = await repo.cardState("ws-2", "card-1")
  check(otherWorkspaceState === undefined, "cardState must be isolated per workspace")

  // The same contract is executed against memory and browser IndexedDB.
  // WB lives in its own typed store; the same record id in another scope is distinct.
  const preview: WbPreviewRow = { id: "preview-1", workspaceUuid: "ws-1", cardId: "card-1", rev: 1,
    config: { subjectId: 105, language: "ru", variants: [{ vendorCode: "A" }, { vendorCode: "B" }] } }
  await repo.putWbPreviews([preview, { ...preview, workspaceUuid: "ws-2" }, { ...preview, cardId: "card-2" }])
  check(JSON.stringify(await repo.wbPreviewsOfCard("ws-1", "card-1")) === JSON.stringify([preview]), "WB preserves variant order and isolates workspace/card")
  await repo.putWbPreviews([{ ...preview, rev: 2 }])
  check((await repo.wbPreviewsOfCard("ws-1", "card-1"))[0]?.rev === 2, "WB upserts the same scoped identity")
  await repo.deleteWbPreviews([preview])
  check((await repo.wbPreviewsOfCard("ws-1", "card-1")).length === 0, "WB removes only the exact scoped record")
  check((await repo.wbPreviewsOfCard("ws-2", "card-1")).length === 1, "WB deletion must preserve the other workspace")
  check((await repo.wbPreviewsOfCard("ws-1", "card-2")).length === 1, "WB deletion must preserve the other card")
  await repo.putWbPreviews([])
  await repo.deleteWbPreviews([])

  // sourcesInUse resolves to a Set (always empty for now — see row-repo.ts).
  const sources = await repo.sourcesInUse()
  check(sources instanceof Set, "sourcesInUse must resolve to a Set")
}
