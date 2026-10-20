/**
 * Browser file chooser and per-tab staging.
 *
 * `<input type="file">` gives a `File`, and the handle is a key into this
 * tab's staging table. The bytes go to OPFS the moment they are needed by a
 * render; until then a picked file is just a `File` waiting to be uploaded,
 * which is what the video path wants (a 200 MB mp4 has no reason to be copied
 * into OPFS on its way to the relay).
 *
 * Handles are per tab and do not survive a reload. Every durable identity in
 * the workbench is a sha256, not a handle.
 */
import { refuse } from "./refusal"

export type FileHandle = string

const staged = new Map<FileHandle, File>()
let counter = 0

export function stageFile(file: File): FileHandle {
  const handle = `file-${++counter}-${file.size}`
  staged.set(handle, file)
  return handle
}

export function stagedFile(handle: FileHandle): File | undefined {
  return staged.get(handle)
}

/**
 * Open the browser's file chooser. Resolves empty when the operator cancels —
 * a cancelled dialog is not an error.
 *
 * Each open creates a fresh, hidden `<input>` mounted until the dialog settles.
 * Mounting lets browser file-chooser automation find it; a fresh input avoids
 * remembering the last selection and importing it again on the next open.
 *
 * `change` for a large file can arrive seconds after the window regains focus
 * (a 140 MiB PSD on a secondary volume). Engines that fire `cancel` must not
 * treat that focus as a dismissal: settling empty here is what the binder
 * reports as "user cancelled", so the card stays on 绑定 PSD and no toast shows.
 * The short focus fallback remains only for an engine with no `cancel` event.
 */
const FILE_PICK_FOCUS_GRACE_MS = 300
const FILE_PICK_ABANDON_MS = 120_000

/** Cloud registers at most 500 MiB (`listing/api/templates` `MAX_BYTES`). */
export const PSD_TEMPLATE_MAX_BYTES = 500 * 1024 * 1024

/**
 * A picked PSD the listing binder may stage. Windows often reports `.psd` with
 * an empty `file.type`; the extension is the check, not the MIME.
 * Returns null when the file can be bound.
 */
export function psdTemplateRefusal(file: { name: string, size: number, type: string }): Error | null {
  const name = file.name.trim().toLowerCase()
  if (!name.endsWith(".psd") && !name.endsWith(".psb")) {
    return refuse("workflow_template_type", "请选择扩展名为 .psd 或 .psb 的文件")
  }
  if (!Number.isFinite(file.size) || file.size <= 0) {
    return refuse("workflow_template_empty", "没有读到 PSD 内容，请重新选择文件")
  }
  if (file.size > PSD_TEMPLATE_MAX_BYTES) {
    return refuse(
      "workflow_template_too_large",
      "这份 PSD 超过 500 MB，无法绑定",
      "请压缩或另存为较小的文件后再试。",
    )
  }
  return null
}

function chosenFiles(input: HTMLInputElement): Promise<File[]> {
  input.hidden = true
  document.body.appendChild(input)
  return awaitChosenFiles(input, typeof window === "undefined" ? undefined : window)
}

/** Settle a mounted file input. `win` is the focus target; tests pass their own. */
export function awaitChosenFiles(input: HTMLInputElement, win: EventTarget | undefined): Promise<File[]> {
  return new Promise((resolve) => {
    let settled = false
    let focusTimer: ReturnType<typeof setTimeout> | undefined
    let abandonTimer: ReturnType<typeof setTimeout> | undefined

    const finish = (files: File[]) => {
      if (settled) return
      settled = true
      if (focusTimer !== undefined) clearTimeout(focusTimer)
      if (abandonTimer !== undefined) clearTimeout(abandonTimer)
      win?.removeEventListener("focus", onFocus)
      input.remove()
      resolve(files)
    }
    const snapshot = () => Array.from(input.files ?? [])
    const onFocus = () => {
      // `oncancel` lives on HTMLInputElement in every engine that fires
      // `cancel` (Chromium and current Firefox). Focus is not a dismissal there.
      if ("oncancel" in input) return
      focusTimer = setTimeout(() => finish(snapshot()), FILE_PICK_FOCUS_GRACE_MS)
    }

    // A cancel that already has files is a selection (the same path chosen
    // again), not a dismissal.
    input.addEventListener("cancel", () => finish(snapshot()), { once: true })
    input.addEventListener("change", () => finish(snapshot()), { once: true })
    abandonTimer = setTimeout(() => finish([]), FILE_PICK_ABANDON_MS)
    // Watch focus only after the chooser has opened, so the opening click
    // cannot look like a cancel.
    setTimeout(() => {
      if (!settled) win?.addEventListener("focus", onFocus)
    }, 0)
  })
}

type ShowOpenFilePicker = (options?: {
  multiple?: boolean
  excludeAcceptAllOption?: boolean
  types?: { description?: string; accept: Record<string, string[]> }[]
}) => Promise<FileSystemFileHandle[]>

/**
 * Prefer a persistent file handle so a reload can keep reading the same PSD.
 * A cancelled dialog stays empty. If the handle API is missing or refuses, the
 * ordinary chooser is the fallback and resume waits for the same file again.
 */
export async function pickPsdFile(): Promise<{ file?: File; handle?: FileSystemFileHandle }> {
  const opener = (globalThis as { showOpenFilePicker?: ShowOpenFilePicker }).showOpenFilePicker
  if (typeof opener === "function") {
    try {
      const [handle] = await opener({
        multiple: false,
        excludeAcceptAllOption: true,
        types: [{
          description: "Photoshop",
          accept: {
            "image/vnd.adobe.photoshop": [".psd", ".psb"],
            "application/octet-stream": [".psd", ".psb"],
          },
        }],
      })
      if (!handle) return {}
      return { file: await handle.getFile(), handle }
    } catch (reason) {
      if ((reason as { name?: string }).name === "AbortError") return {}
    }
  }
  const [file] = await pickFiles(PSD_ACCEPT)
  return file ? { file } : {}
}

export function pickFiles(accept: string, multiple = false): Promise<File[]> {
  if (typeof document === "undefined") return Promise.resolve([])
  const input = document.createElement("input")
  input.type = "file"
  input.accept = accept
  input.multiple = multiple
  const picked = chosenFiles(input)
  input.click()
  return picked
}

/**
 * Pick a whole directory. Each `File` carries `webkitRelativePath`
 * (`l1/l2/type/file`); the browser does the walking.
 */
export function pickDirectory(): Promise<File[]> {
  if (typeof document === "undefined") return Promise.resolve([])
  const input = document.createElement("input")
  input.type = "file"
  input.webkitdirectory = true
  const picked = chosenFiles(input)
  input.click()
  return picked
}

export const PSD_ACCEPT = ".psd,.psb"
export const SOURCE_ACCEPT = "image/jpeg,image/png,.jpg,.jpeg,.png"

export function isSourceImage(file: File): boolean {
  return SOURCE_ACCEPT.split(",").some((format) =>
    format.startsWith(".") ? file.name.toLowerCase().endsWith(format) : file.type === format,
  )
}
export const VIDEO_ACCEPT = "video/mp4,video/quicktime"
export const PROMPT_ACCEPT = ".txt,.md"

export async function fileBytes(file: File): Promise<Uint8Array<ArrayBuffer>> {
  return new Uint8Array(await file.arrayBuffer())
}
