/** Final fixture composition of C schema refresh and S15 confirmed reupload.
 * Upload execution stays with the injected media owner; op6/op7 own validation. */
import type { ListingCoreClient } from "@/listing-core/client"
import type { ListingCore } from "@/listing-core/wasm"
import type { CardPayload, LeanRow, SchemaLoadInput, WorkflowImageLifecycle } from "@/listing-core/types"
import type { CardRows } from "../rows/card-rows"
import type { LocalRow } from "../rows/types"
import type { createSchemaCache, SchemaIdentity } from "../schema-cache"
import type { SendCapability, SendFact } from "../submit/queue/types"
import { createSliceBudget } from "./core"

export type ConfirmedRowUpload = {
  rowId: string
  revision: number
  state: "confirmed"
  images: WorkflowImageLifecycle[]
}
/** Resolves only after the media owner has verified upload success. No speculative URL. */
export type ReuploadRows = (rows: readonly LocalRow[], signal: AbortSignal) => Promise<readonly ConfirmedRowUpload[]>
export function createOzonRepair(options: {
  rows: CardRows
  core: Pick<ListingCore | ListingCoreClient, "revalidate" | "recordUpload" | "freezeListing">
  schemas: ReturnType<typeof createSchemaCache>
  initialHandle: number
  card(): CardPayload
  current(): boolean
  accountId: string
  refreshSchema?: (signal: AbortSignal) => Promise<{ identity: SchemaIdentity; material: SchemaLoadInput }>
  reuploadRows?: ReuploadRows
}) {
  let handle = options.initialHandle
  const canRepair = (kind: "schema" | "media") => kind === "schema" ? !!options.refreshSchema : !!options.reuploadRows
  const repair: NonNullable<SendCapability["repair"]> = async (kind, selected, signal) => {
    if (selected.length === 0) return
    if (selected.length > 100 || new Set(selected.map((row) => row.id)).size !== selected.length) throw new Error("Repair requires one distinct captured submit chunk")
    const code = kind === "schema" ? "schema_stale" : "media_expired"
    const valid = () => !signal.aborted && options.current() && options.rows.writable && options.rows.error === undefined
      && selected.every((row) => {
        const current = options.rows.get(row.id)
        const fact = current?.submission?.receipt as SendFact | undefined
        return current?.rev === row.rev && current.workspaceUuid === row.workspaceUuid && current.cardId === row.cardId
          && current.storeId === row.storeId && current.submission?.state === "rejected" && fact?.state === "rejected"
          && fact.canResume === true && fact.code === code && !fact.admission
      })
    const check = () => { if (!valid()) throw new Error("Repair no longer owns a confirmed rejected row at its captured revision") }
    check()
    if (!canRepair(kind)) throw Object.assign(new Error("修复端口未接入；请先显式更新类目或重新上传媒体，再重新校验商品"), { code: "repair_not_available" })
    let nextHandle = handle
    let uploads: readonly ConfirmedRowUpload[] = []
    if (kind === "schema") {
      const refreshed = await options.refreshSchema!(signal)
      check()
      nextHandle = (await options.schemas.load(refreshed.identity, refreshed.material)).handle
    } else {
      uploads = await options.reuploadRows!(structuredClone(selected), signal)
      check()
      if (uploads.length !== selected.length || new Set(uploads.map((upload) => upload.rowId)).size !== selected.length) throw new Error("Reupload omitted or duplicated a confirmed receipt")
    }
    check()
    const staged: Array<{ local: LocalRow; row: LeanRow; verdict: unknown }> = []
    const tick = createSliceBudget()
    for (const local of selected) {
      check()
      const row = structuredClone(local.row as LeanRow)
      if (kind === "media") {
        const upload = uploads.find((entry) => entry.rowId === local.id && entry.revision === local.rev && entry.state === "confirmed")
        if (!upload || !upload.images.length || upload.images.length !== row.media.images.length
          || upload.images.some((image, index) => {
            const original = row.media.images[index]
            return !original || image.index !== original.index || image.content_hash !== original.content_hash
              || image.width !== original.width || image.height !== original.height || image.file_name !== original.file_name || image.group_name !== original.group_name
              || image.phase !== "public_ready" || !image.public_url || !image.object_key || image.account_id !== options.accountId
          })) throw new Error("Reupload receipt does not match this account's captured media")
        row.media.images = structuredClone(upload.images)
      }
      const edited = await options.core[kind === "schema" ? "revalidate" : "recordUpload"](nextHandle, { row, card: options.card(), nowMs: Date.now() })
      check()
      const frozen = await options.core.freezeListing(nextHandle, { rowId: local.id, row: edited.row, card: options.card() })
      check()
      if (frozen.status !== "frozen") throw new Error("Native validation still refuses the repaired row; explicit field review is required")
      staged.push({ local, row: edited.row, verdict: edited.fact })
      await tick()
    }
    check()
    for (const entry of staged) {
      if (!options.rows.update(entry.local.id, (row) => ({ ...row, row: entry.row, verdict: entry.verdict }), { expectRev: entry.local.rev })) throw new Error("Repair revision changed before persistence")
    }
    await options.rows.flush()
    if (signal.aborted || !options.current()) throw new Error("Repair scope stopped before readmission")
    handle = nextHandle
  }
  return { repair, canRepair, schemaHandle: () => handle,
    /** Only after an explicit next-action restart and local material reload. */
    replaceResidentHandle(next: number) { handle = next },
  }
}
