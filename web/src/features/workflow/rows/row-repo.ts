// The only file allowed to open IndexedDB database "listing". See
// specs/browser-owned-listing/slices/09-row-store.md.
//
// Two implementations behind one interface: `memoryRowRepo()` for Bun's test
// runner (no real IndexedDB there) and `idbRowRepo()` for browsers. Callers
// never touch IndexedDB directly — `card-rows.ts` is the only writer, and it
// only ever goes through this interface.

import { LocalStorageFullError, type CardLocalState, type LocalRow, type PublishOfferLock } from "./types"
import type { WbPreviewRow, WbPreviewIdentity } from "./wb-preview-rows"

export interface RowRepo {
  wbPreviewsOfCard(workspaceUuid: string, cardId: string): Promise<WbPreviewRow[]>
  putWbPreviews(rows: WbPreviewRow[]): Promise<void>
  deleteWbPreviews(rows: WbPreviewIdentity[]): Promise<void>
  /** Local workspace-wide locks survive card switches and deleted rows. */
  offerLocks(workspaceUuid: string): Promise<PublishOfferLock[]>
  rowsOfCard(workspaceUuid: string, cardId: string): Promise<LocalRow[]>
  /** Upserts every row in one transaction (by `id`). */
  putRows(rows: LocalRow[]): Promise<void>
  deleteRows(ids: string[]): Promise<void>
  cardState(workspaceUuid: string, cardId: string): Promise<CardLocalState | undefined>
  putCardState(state: CardLocalState): Promise<void>
  /**
   * All source-image sha256 referenced by local rows, for the OPFS pinning
   * watchdog (`setPinnedSources` in `render/opfs-cache.ts`; I5: a referenced source
   * is never evicted).
   *
   * Always empty for now. Nothing calls `sourcesInUse()` until
   * browser-owned-listing slice 17 wires `setPinnedSources` to it, so an empty
   * set cannot lose data yet. Filling it in means either reading the media
   * field out of the opaque `row` (LeanRow,
   * `rust/crates/listing-core/src/ops/lean_row.rs`) blob or moving source-sha
   * bookkeeping onto a typed `LocalRow` field so this repo never has to parse
   * the blob.
   */
  sourcesInUse(): Promise<Set<string>>
  // `schemas` / `coordinates` stores exist (idbRowRepo creates them) but have
  // no read/write methods yet; slice 11 adds them.
}

function cardKey(workspaceUuid: string, cardId: string): string {
  return `${workspaceUuid}:${cardId}`
}

export function memoryRowRepo(): RowRepo {
  const previews = new Map<string, WbPreviewRow>()
  const previewKey = (row: WbPreviewIdentity) => JSON.stringify([row.workspaceUuid, row.cardId, row.id])
  const rows = new Map<string, LocalRow>()
  const cards = new Map<string, CardLocalState>()
  return {
    async wbPreviewsOfCard(workspaceUuid, cardId) {
      return structuredClone([...previews.values()].filter((row) => row.workspaceUuid === workspaceUuid && row.cardId === cardId))
    },
    async putWbPreviews(rows) { for (const row of rows) previews.set(previewKey(row), structuredClone(row)) },
    async deleteWbPreviews(rows) { for (const row of rows) previews.delete(previewKey(row)) },
    async offerLocks(workspaceUuid) {
      return structuredClone([...cards.values()].filter((state) => state.workspaceUuid === workspaceUuid).flatMap((state) => state.publish?.locks ?? []))
    },
    async rowsOfCard(workspaceUuid, cardId) {
      return [...rows.values()].filter((row) => row.workspaceUuid === workspaceUuid && row.cardId === cardId)
    },
    async putRows(batch) {
      for (const row of batch) rows.set(row.id, row)
    },
    async deleteRows(ids) {
      for (const id of ids) rows.delete(id)
    },
    async cardState(workspaceUuid, cardId) {
      return cards.get(cardKey(workspaceUuid, cardId))
    },
    async putCardState(state) {
      cards.set(cardKey(state.workspaceUuid, state.cardId), state)
    },
    async sourcesInUse() {
      return new Set()
    },
  }
}

const ROWS_STORE = "rows"
const WB_PREVIEWS_STORE = "wb_preview_rows"
const CARDS_STORE = "cards"
const SCHEMAS_STORE = "schemas" // placeholder store; slice 11 adds methods
const COORDINATES_STORE = "coordinates" // placeholder store; slice 11 adds methods
const CARD_INDEX = "by_card"
const DB_VERSION = 2

function isQuotaExceeded(error: unknown): boolean {
  return error instanceof DOMException && error.name === "QuotaExceededError"
}

function openDb(name: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(name, DB_VERSION)
    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains(WB_PREVIEWS_STORE)) {
        const store = db.createObjectStore(WB_PREVIEWS_STORE, { keyPath: ["workspaceUuid", "cardId", "id"] })
        store.createIndex(CARD_INDEX, ["workspaceUuid", "cardId"])
      }
      if (!db.objectStoreNames.contains(ROWS_STORE)) {
        const store = db.createObjectStore(ROWS_STORE, { keyPath: "id" })
        store.createIndex(CARD_INDEX, ["workspaceUuid", "cardId"])
      }
      if (!db.objectStoreNames.contains(CARDS_STORE)) db.createObjectStore(CARDS_STORE)
      if (!db.objectStoreNames.contains(SCHEMAS_STORE)) db.createObjectStore(SCHEMAS_STORE)
      if (!db.objectStoreNames.contains(COORDINATES_STORE)) db.createObjectStore(COORDINATES_STORE)
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

/** Runs a read against one store; resolves with the terminal request's result once the transaction completes. */
function runReadTx<T>(db: IDBDatabase, storeName: string, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, "readonly")
    const request = run(tx.objectStore(storeName))
    tx.oncomplete = () => {
      db.close()
      resolve(request.result)
    }
    tx.onerror = () => {
      db.close()
      reject(tx.error)
    }
    tx.onabort = () => {
      db.close()
      reject(tx.error)
    }
  })
}

/** Runs one or more writes against a store in a single transaction. */
function runWriteTx(db: IDBDatabase, storeName: string, run: (store: IDBObjectStore) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, "readwrite")
    run(tx.objectStore(storeName))
    tx.oncomplete = () => {
      db.close()
      resolve()
    }
    tx.onerror = () => {
      db.close()
      reject(isQuotaExceeded(tx.error) ? new LocalStorageFullError(tx.error) : tx.error)
    }
    tx.onabort = () => {
      db.close()
      reject(isQuotaExceeded(tx.error) ? new LocalStorageFullError(tx.error) : tx.error)
    }
  })
}

/** Database name is deliberately unbranded (spec decision S7): this repo has
 * been renamed twice, and a brand-prefixed storage key becomes a silent
 * data-loss trap on the next rebrand. Browser fixtures and tests must pass a
 * `listing-fixture-*` name instead of the default, so they never touch real
 * user data (see specs/browser-owned-listing/slices/09-row-store.md). */
export function idbRowRepo(name = "listing"): RowRepo {
  return {
    async wbPreviewsOfCard(workspaceUuid, cardId) {
      return runReadTx<WbPreviewRow[]>(await openDb(name), WB_PREVIEWS_STORE, (store) => store.index(CARD_INDEX).getAll(IDBKeyRange.only([workspaceUuid, cardId])))
    },
    async putWbPreviews(rows) {
      if (rows.length) await runWriteTx(await openDb(name), WB_PREVIEWS_STORE, (store) => { for (const row of rows) store.put(row) })
    },
    async deleteWbPreviews(rows) {
      if (rows.length) await runWriteTx(await openDb(name), WB_PREVIEWS_STORE, (store) => { for (const row of rows) store.delete([row.workspaceUuid, row.cardId, row.id]) })
    },
    async offerLocks(workspaceUuid) {
      const db = await openDb(name)
      const states = await runReadTx<CardLocalState[]>(db, CARDS_STORE, (store) => store.getAll())
      return states.filter((state) => state.workspaceUuid === workspaceUuid).flatMap((state) => state.publish?.locks ?? [])
    },
    async rowsOfCard(workspaceUuid, cardId) {
      const db = await openDb(name)
      return runReadTx<LocalRow[]>(db, ROWS_STORE, (store) =>
        store.index(CARD_INDEX).getAll(IDBKeyRange.only([workspaceUuid, cardId])),
      )
    },
    async putRows(batch) {
      if (batch.length === 0) return
      const db = await openDb(name)
      await runWriteTx(db, ROWS_STORE, (store) => {
        for (const row of batch) store.put(row)
      })
    },
    async deleteRows(ids) {
      if (ids.length === 0) return
      const db = await openDb(name)
      await runWriteTx(db, ROWS_STORE, (store) => {
        for (const id of ids) store.delete(id)
      })
    },
    async cardState(workspaceUuid, cardId) {
      const db = await openDb(name)
      return runReadTx<CardLocalState | undefined>(db, CARDS_STORE, (store) =>
        store.get(cardKey(workspaceUuid, cardId)),
      )
    },
    async putCardState(state) {
      const db = await openDb(name)
      await runWriteTx(db, CARDS_STORE, (store) => {
        store.put(state, cardKey(state.workspaceUuid, state.cardId))
      })
    },
    async sourcesInUse() {
      return new Set()
    },
  }
}
