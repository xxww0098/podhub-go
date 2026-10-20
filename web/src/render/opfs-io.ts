/**
 * Origin Private File System byte IO for the render module.
 *
 * Storage is Chromium-first. Bytes live in OPFS. When the engine
 * proves it can, a dedicated worker moves them through
 * `FileSystemFileHandle.createSyncAccessHandle` — DedicatedWorker-only in the
 * File System spec — so the copies stay off this thread (`opfs-worker.ts`,
 * `opfs-channel.ts`). Engines without the worker path keep this module's own
 * `getDirectory` / `getFile` / `createWritable`; an engine without the async
 * writable API is unsupported rather than degraded.
 *
 */
import type { RenderBytes } from "./wasm"
import { openOpfsChannel, OpfsChannelDead, type OpfsChannel } from "./opfs-channel"

export class OpfsUnavailable extends Error {
  constructor(missing: string) {
    super(`this browser cannot store renders: ${missing} is missing (ADR-0085 decision 7 is Chromium-first)`)
    this.name = "OpfsUnavailable"
  }
}

/**
 * The Window-thread OPFS surface this module actually uses. A prototype that
 * only has `createSyncAccessHandle` is not enough: that method is not exposed
 * on Window, and the writes below never call it.
 */
export function opfsUnavailableReason(
  storage: { getDirectory?: unknown } | undefined,
  fileHandleCtor: { prototype: object } | undefined,
): string | null {
  if (typeof storage?.getDirectory !== "function") {
    return "navigator.storage.getDirectory"
  }
  const writable = (fileHandleCtor?.prototype as { createWritable?: unknown } | undefined)
    ?.createWritable
  if (typeof writable !== "function") {
    return "FileSystemFileHandle.createWritable"
  }
  return null
}

export async function root(): Promise<FileSystemDirectoryHandle> {
  const missing = opfsUnavailableReason(
    typeof navigator === "undefined" ? undefined : navigator.storage,
    typeof FileSystemFileHandle === "undefined" ? undefined : FileSystemFileHandle,
  )
  if (missing) {
    throw new OpfsUnavailable(missing)
  }
  return navigator.storage.getDirectory()
}

async function makeDirectory(path: string[]): Promise<FileSystemDirectoryHandle> {
  let handle = await root()
  for (const segment of path) {
    handle = await handle.getDirectoryHandle(segment, { create: true })
  }
  return handle
}

/**
 * The byte mover: the dedicated OPFS worker when it answered its capability
 * probe, this thread's async API otherwise (`opfs-channel.ts`). Probed once
 * per tab — the channel's worker owns `createSyncAccessHandle`, so reads and
 * writes of up to 254 MiB no longer copy on the main thread.
 */
let channelMemo: Promise<OpfsChannel | null> | undefined

export function io(): Promise<OpfsChannel | null> {
  channelMemo ??= openOpfsChannel()
  return channelMemo
}

/**
 * The worker died mid-op: bury the channel so every later call takes the
 * Window path, and tell the caller to retry this one there. Reads and
 * previews are idempotent; a write that died inside the worker's sync handle
 * left at most a truncated file, which the retried write overwrites whole.
 */
export function buryChannel(): null {
  channelMemo = Promise.resolve(null)
  return null
}

export async function readFile(path: string[], name: string): Promise<RenderBytes | null> {
  const channel = await io()
  if (channel) {
    try {
      return (await channel.read(path, name)) as RenderBytes | null
    } catch (error) {
      if (!(error instanceof OpfsChannelDead)) throw error
      buryChannel()
    }
  }
  try {
    let handle = await root()
    for (const segment of path) {
      handle = await handle.getDirectoryHandle(segment)
    }
    const file = await (await handle.getFileHandle(name)).getFile()
    return new Uint8Array(await file.arrayBuffer()) as RenderBytes
  } catch (error) {
    if ((error as DOMException).name === "NotFoundError") {
      return null
    }
    throw error
  }
}

/**
 * Stream a Blob into OPFS without one ArrayBuffer of the whole file.
 * The worker path copies its message, so a 140 MiB PSD stays on this
 * createWritable loop instead.
 */
export async function writeBlob(path: string[], name: string, blob: Blob): Promise<void> {
  const handle = await (await makeDirectory(path)).getFileHandle(name, { create: true })
  const stream = await handle.createWritable()
  const reader = blob.stream().getReader()
  try {
    for (;;) {
      const next = await reader.read()
      if (next.done) break
      await stream.write(next.value)
    }
    await stream.close()
  } catch (error) {
    try { await stream.abort() } catch { /* the write's own error stands */ }
    throw error
  }
}

export async function writeOnce(path: string[], name: string, bytes: RenderBytes): Promise<void> {
  const channel = await io()
  if (channel) {
    try {
      await channel.write(path, name, bytes)
      return
    } catch (error) {
      if (!(error instanceof OpfsChannelDead)) throw error
      buryChannel()
    }
  }
  const handle = await (await makeDirectory(path)).getFileHandle(name, { create: true })
  await writeTo(handle, bytes)
}

async function writeTo(handle: FileSystemFileHandle, bytes: RenderBytes): Promise<void> {
  const stream = await handle.createWritable()
  try {
    await stream.write(bytes)
    await stream.close()
  } catch (error) {
    // A half-written stream holds the bytes it already took; aborting returns
    // the file to its pre-write state instead of leaving a truncated slice.
    // An engine without `abort` keeps the original error, never a TypeError.
    try { await stream.abort() } catch { /* the write's own error stands */ }
    throw error
  }
}

/** Delete one entry, file or directory. Already gone is the wanted end state. */
export async function remove(key: string): Promise<void> {
  const segments = key.split("/")
  const name = segments.pop()!
  try {
    let handle = await root()
    for (const segment of segments) {
      handle = await handle.getDirectoryHandle(segment)
    }
    await handle.removeEntry(name, { recursive: true })
  } catch (error) {
    if ((error as DOMException).name !== "NotFoundError") {
      throw error
    }
  }
}
