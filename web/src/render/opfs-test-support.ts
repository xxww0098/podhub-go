/** In-memory OPFS shared by storage and asset integration tests. */
import { setPinnedSources, sweep, resetUseLogForTest } from "./opfs-cache"

let restoreGlobals: (() => void) | undefined

export async function restoreOpfsTestGlobals() {
  setPinnedSources(async () => new Set())
  if (!restoreGlobals) return
  await sweep()
  resetUseLogForTest()
  restoreGlobals()
  restoreGlobals = undefined
}

export function stubOpfs(options: { quotaOnce?: boolean } = {}) {
  const names = ["localStorage", "navigator", "FileSystemFileHandle"] as const
  const originals = names.map(name => Object.getOwnPropertyDescriptor(globalThis, name))
  restoreGlobals = () => names.forEach((name, index) => {
    const descriptor = originals[index]
    if (descriptor) Object.defineProperty(globalThis, name, descriptor)
    else Reflect.deleteProperty(globalThis, name)
  })
  let persistCalls = 0
  let quotaBurned = false
  const written = new Set<string>()
  const sizes = new Map<string, number>()
  const contents = new Map<string, Uint8Array>()
  const fileReads: string[] = []
  const store = new Map<string, string>()
  let storageWrites = 0

  const file = (path: string) => ({
    kind: "file",
    getFile: async () => {
      fileReads.push(path)
      if (!written.has(path)) throw new DOMException("file not found", "NotFoundError")
      return {
        size: sizes.get(path) ?? contents.get(path)?.length ?? 1,
        lastModified: 0,
        arrayBuffer: async () => contents.get(path)?.slice().buffer ?? new ArrayBuffer(0),
      }
    },
  })

  function directory(prefix: string): FileSystemDirectoryHandle {
    return {
      kind: "directory",
      getDirectoryHandle: async (name: string) => directory(`${prefix}${name}/`),
      getFileHandle: async (name: string) => ({
        ...file(`${prefix}${name}`),
        createWritable: async () => ({
          write: async (bytes: Uint8Array) => {
            if (options.quotaOnce && !quotaBurned) {
              quotaBurned = true
              throw new DOMException("quota refused", "QuotaExceededError")
            }
            written.add(`${prefix}${name}`)
            contents.set(`${prefix}${name}`, bytes.slice())
          },
          close: async () => {},
          abort: async () => {},
        }),
      }),
      removeEntry: async (name: string) => {
        const target = `${prefix}${name}`
        for (const path of written) {
          if (path === target || path.startsWith(`${target}/`)) written.delete(path)
        }
      },
      entries: async function* () {
        const seen = new Set<string>()
        for (const path of written) {
          if (!path.startsWith(prefix)) continue
          const rest = path.slice(prefix.length)
          const slash = rest.indexOf("/")
          const name = slash < 0 ? rest : rest.slice(0, slash)
          if (seen.has(name)) continue
          seen.add(name)
          yield [name, slash < 0 ? file(path) : directory(`${prefix}${name}/`)]
        }
      },
    } as unknown as FileSystemDirectoryHandle
  }

  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => {
        storageWrites++
        store.set(key, value)
      },
    },
  })
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: {
      storage: {
        getDirectory: async () => directory(""),
        persist: async () => {
          persistCalls += 1
          return true
        },
      },
    },
  })
  Object.defineProperty(globalThis, "FileSystemFileHandle", {
    configurable: true,
    value: class {
      async createWritable() {}
    },
  })

  return { written, persistCount: () => persistCalls, store, sizes, contents, fileReads, storageWrites: () => storageWrites }
}

