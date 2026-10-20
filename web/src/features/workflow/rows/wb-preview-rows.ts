/** WB view of the CardRows writer. No database connection or independent lock. */
import type { WbProductConfig, WbPreview } from "@/listing-core/wb-types"
import { assertWbJson } from "@/listing-core/wb-types"
import type { RowRepo } from "./row-repo"

export type WbPreviewRow = {
  workspaceUuid: string
  cardId: string
  id: string
  rev: number
  config: WbProductConfig
  preview?: WbPreview
}
export type WbPreviewIdentity = Pick<WbPreviewRow, "workspaceUuid" | "cardId" | "id">
export type WbPreviewRows = {
  all(): readonly WbPreviewRow[]
  get(id: string): WbPreviewRow | undefined
  create(id: string, config: WbProductConfig): void
  edit(id: string, expectRev: number, config: WbProductConfig): boolean
  settle(id: string, expectRev: number, preview: WbPreview): boolean
  remove(id: string): void
}
export function wbPreviewWorkingSet(options: {
  repo: RowRepo; workspaceUuid: string; cardId: string; initial: WbPreviewRow[]
  requireWritable(): void; changed(): void; current(): boolean
}) {
  let records = new Map(options.initial.map((row) => [row.id, structuredClone(row)]))
  const revisions = new Map(options.initial.map((row) => [row.id, row.rev]))
  const puts = new Map<string, WbPreviewRow>()
  const deletes = new Map<string, WbPreviewIdentity>()
  function write(row: WbPreviewRow) {
    records.set(row.id, row); revisions.set(row.id, row.rev); puts.set(row.id, row); deletes.delete(row.id); options.changed()
  }
  const view: WbPreviewRows = {
    all: () => options.current() ? structuredClone([...records.values()]) : [],
    get: (id) => { const row = options.current() ? records.get(id) : undefined; return row && structuredClone(row) },
    create(id, config) {
      options.requireWritable(); assertWbJson(config)
      if (!id.trim() || id.trim() !== id || records.has(id)) throw new Error("WB preview record identity is blank or duplicated")
      write({ id, workspaceUuid: options.workspaceUuid, cardId: options.cardId, rev: (revisions.get(id) ?? 0) + 1, config: structuredClone(config) })
    },
    edit(id, expectRev, config) {
      options.requireWritable(); assertWbJson(config)
      const row = records.get(id)
      if (!row || row.rev !== expectRev) return false
      write({ ...row, rev: row.rev + 1, config: structuredClone(config), preview: undefined })
      return true
    },
    settle(id, expectRev, preview) {
      options.requireWritable()
      const row = records.get(id)
      if (!row || row.rev !== expectRev) return false
      write({ ...row, rev: row.rev + 1, preview: structuredClone(preview) })
      return true
    },
    remove(id) {
      options.requireWritable()
      const row = records.get(id)
      if (!row) return
      records.delete(id); puts.delete(id)
      deletes.set(id, { id, workspaceUuid: row.workspaceUuid, cardId: row.cardId }); options.changed()
    },
  }
  return {
    view,
    get pending() { return puts.size > 0 || deletes.size > 0 },
    reset(rows: WbPreviewRow[]) {
      records = new Map(rows.map((row) => [row.id, structuredClone(row)]))
      for (const row of rows) revisions.set(row.id, Math.max(row.rev, revisions.get(row.id) ?? 0))
    },
    async flush() {
      const removed = [...deletes.values()], written = [...puts.values()]
      if (removed.length) await options.repo.deleteWbPreviews(removed)
      if (written.length) await options.repo.putWbPreviews(written)
      for (const row of removed) if (deletes.get(row.id) === row) deletes.delete(row.id)
      for (const row of written) if (puts.get(row.id) === row) puts.delete(row.id)
    },
  }
}
