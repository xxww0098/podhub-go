/**
 * Incomplete upload tasks. IndexedDB holds the fingerprint, finished parts,
 * finished objects, the target row, and a file handle when the browser gave one.
 * Tests and runtimes without IndexedDB use the in-memory store.
 */

export type ResumePart = { partNumber: number; etag: string }

export type ResumeObject = {
  digest: string
  extension: string
  byteLength: number
  objectKey: string
  accountId: string
  uploadTicket?: string
  publicUrl?: string
  workspaceUuid?: string
  storageRevision?: number
  putDone: boolean
  confirmed: boolean
}

export type UploadResumeRecord = {
  id: string
  kind: "psd" | "slice"
  sha256: string
  /** Listing row, or the card draft that owns a PSD binding. */
  rowId: string
  workspaceUuid: string
  fileName: string
  byteLength: number
  updatedAt: number
  descriptionCategoryId?: number
  typeId?: number
  uploadId?: string
  ticket?: string
  partSize?: number
  completedParts: ResumePart[]
  uploadBatch?: string
  batchExpiresAt?: string
  objects: ResumeObject[]
  handle?: FileSystemFileHandle
}

const DB_NAME = "podhub-upload-resume"
const STORE = "tasks"
const VERSION = 1

const memory = new Map<string, UploadResumeRecord>()
const writeTails = new Map<string, Promise<void>>()

export function psdResumeId(sha256: string): string {
  return `psd:${sha256.toLowerCase()}`
}

export function sliceResumeId(workspaceUuid: string, rowId: string, manifestDigest: string): string {
  return `slice:${workspaceUuid}:${rowId}:${manifestDigest.toLowerCase()}`
}

function clone(record: UploadResumeRecord): UploadResumeRecord {
  return {
    ...record,
    completedParts: record.completedParts.map((part) => ({ ...part })),
    objects: record.objects.map((object) => ({ ...object })),
  }
}

function idbAvailable(): boolean {
  return typeof indexedDB !== "undefined" && !("Bun" in globalThis)
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, VERSION)
    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: "id" })
        store.createIndex("bySha", "sha256", { unique: false })
        store.createIndex("byKind", "kind", { unique: false })
      }
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error("upload resume store failed"))
  })
}

function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error("upload resume store failed"))
  })
}

export async function readResume(id: string): Promise<UploadResumeRecord | null> {
  const cached = memory.get(id)
  if (!idbAvailable()) return cached ? clone(cached) : null
  try {
    const db = await openDb()
    const stored = await requestToPromise(db.transaction(STORE, "readonly").objectStore(STORE).get(id)) as UploadResumeRecord | undefined
    db.close()
    if (!stored) return cached ? clone(cached) : null
    memory.set(id, stored)
    return clone(stored)
  } catch {
    return cached ? clone(cached) : null
  }
}

export async function writeResume(record: UploadResumeRecord): Promise<void> {
  const next = clone({ ...record, updatedAt: record.updatedAt || Date.now() })
  memory.set(next.id, next)
  const previous = writeTails.get(next.id) ?? Promise.resolve()
  const job = previous.catch(() => undefined).then(async () => {
    if (!idbAvailable()) return
    const latest = memory.get(next.id)
    if (!latest) return
    try {
      const db = await openDb()
      await requestToPromise(db.transaction(STORE, "readwrite").objectStore(STORE).put(clone(latest)))
      db.close()
    } catch {
      // A full quota or a private mode must not fail the upload itself.
    }
  })
  writeTails.set(next.id, job)
  await job
}

export async function deleteResume(id: string): Promise<void> {
  memory.delete(id)
  const previous = writeTails.get(id) ?? Promise.resolve()
  const job = previous.catch(() => undefined).then(async () => {
    memory.delete(id)
    if (!idbAvailable()) return
    try {
      const db = await openDb()
      await requestToPromise(db.transaction(STORE, "readwrite").objectStore(STORE).delete(id))
      db.close()
    } catch {
      // Losing the note is safer than failing a finished upload.
    }
  })
  writeTails.set(id, job)
  await job
}

export async function listResumes(kind: UploadResumeRecord["kind"]): Promise<UploadResumeRecord[]> {
  if (!idbAvailable()) {
    return [...memory.values()].filter((record) => record.kind === kind).map(clone)
  }
  try {
    const db = await openDb()
    const rows = await requestToPromise(
      db.transaction(STORE, "readonly").objectStore(STORE).index("byKind").getAll(kind),
    ) as UploadResumeRecord[]
    db.close()
    for (const row of rows) memory.set(row.id, row)
    return rows.map(clone)
  } catch {
    return [...memory.values()].filter((record) => record.kind === kind).map(clone)
  }
}

type GrantedFileHandle = {
  queryPermission?: (descriptor: { mode: "read" }) => Promise<"granted" | "denied" | "prompt">
  getFile: () => Promise<File>
}

/** Read a handle only when permission is already granted. Never prompts. */
export async function fileFromGrantedHandle(handle: FileSystemFileHandle): Promise<File | null> {
  const readable = handle as FileSystemFileHandle & GrantedFileHandle
  try {
    const query = readable.queryPermission?.({ mode: "read" })
    const state = query ? await query : "granted"
    if (state !== "granted") return null
    return await readable.getFile()
  } catch {
    return null
  }
}

/** Test hook. Production code does not call this. */
export async function clearResumes(): Promise<void> {
  memory.clear()
  writeTails.clear()
  if (!idbAvailable()) return
  try {
    const db = await openDb()
    await requestToPromise(db.transaction(STORE, "readwrite").objectStore(STORE).clear())
    db.close()
  } catch {
    // A failed sweep must not block signing out.
  }
}

export function resetResumeMemory(): void {
  memory.clear()
  writeTails.clear()
}
