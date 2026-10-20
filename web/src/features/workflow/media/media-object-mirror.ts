import { dropLegacyMediaMirror } from "@/lib/legacy-storage"

/**
 * Incremental mirror of local media confirmations.
 * One IndexedDB record per object. The in-memory map stays the source of truth;
 * a missed flush only costs a later probe.
 */

export type MirrorEntry = {
  objectKey: string
  publicUrl: string
  accountId: string
  workspaceUuid?: string
  storageRevision?: number
  confirmedAtMs: number
}

export type MediaMirror = {
  load(): Promise<Array<[string, MirrorEntry]>>
  put(entries: Array<[string, MirrorEntry]>): Promise<void>
  remove(keys: string[]): Promise<void>
  clear(): Promise<void>
}

const DB_NAME = "podhub-media"
const STORE = "confirmations"
const VERSION = 1

const memory = new Map<string, MirrorEntry>()
let recordWrites = 0

/** How many individual records were put. A whole-map rewrite would not grow this per key. */
export function mediaRecordWrites(): number {
  return recordWrites
}

function memoryMirror(): MediaMirror {
  return {
    async load() {
      return [...memory]
    },
    async put(entries) {
      recordWrites += entries.length
      for (const [key, entry] of entries) memory.set(key, entry)
    },
    async remove(keys) {
      for (const key of keys) memory.delete(key)
    },
    async clear() {
      memory.clear()
    },
  }
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, VERSION)
    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE)
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

function idbMirror(): MediaMirror {
  return {
    async load() {
      const db = await openDb()
      return new Promise((resolve, reject) => {
        const rows: Array<[string, MirrorEntry]> = []
        const tx = db.transaction(STORE, "readonly")
        const request = tx.objectStore(STORE).openCursor()
        request.onsuccess = () => {
          const cursor = request.result
          if (!cursor) return
          rows.push([String(cursor.key), cursor.value as MirrorEntry])
          cursor.continue()
        }
        tx.oncomplete = () => { db.close(); resolve(rows) }
        tx.onerror = () => { db.close(); reject(tx.error) }
        tx.onabort = () => { db.close(); reject(tx.error) }
      })
    },
    async put(entries) {
      if (entries.length === 0) return
      const db = await openDb()
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(STORE, "readwrite")
        const store = tx.objectStore(STORE)
        for (const [key, entry] of entries) store.put(entry, key)
        tx.oncomplete = () => {
          recordWrites += entries.length
          db.close()
          resolve()
        }
        tx.onerror = () => { db.close(); reject(tx.error) }
        tx.onabort = () => { db.close(); reject(tx.error) }
      })
    },
    async remove(keys) {
      if (keys.length === 0) return
      const db = await openDb()
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(STORE, "readwrite")
        const store = tx.objectStore(STORE)
        for (const key of keys) store.delete(key)
        tx.oncomplete = () => { db.close(); resolve() }
        tx.onerror = () => { db.close(); reject(tx.error) }
        tx.onabort = () => { db.close(); reject(tx.error) }
      })
    },
    async clear() {
      const db = await openDb()
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(STORE, "readwrite")
        tx.objectStore(STORE).clear()
        tx.oncomplete = () => { db.close(); resolve() }
        tx.onerror = () => { db.close(); reject(tx.error) }
        tx.onabort = () => { db.close(); reject(tx.error) }
      })
    },
  }
}

export function browserMediaMirror(): MediaMirror {
  // Bun runs the unit tests. IndexedDB there would be a second store the
  // assertions don't share, so tests stay on the in-memory mirror.
  if ("Bun" in globalThis || typeof indexedDB === "undefined") return memoryMirror()
  void dropLegacyMediaMirror()
  return idbMirror()
}
