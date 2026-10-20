/**
 * Browser preference for the next OCR task. Cloud still pins the models onto
 * the Job; this module only remembers the operator's choice and resolves
 * 「系统默认」 at task creation. No price version is stored or sent.
 */

export type OcrModelChoice = {
  primary_model: string
  backup_model?: string | null
}

export type OcrCatalogueDefault = {
  default_ocr_model?: string | null
}

const STORAGE_KEY = "podhub.ocr-model.v1"

type KeyValue = {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

function browserStorage(): KeyValue | undefined {
  try {
    const storage = globalThis.localStorage
    if (!storage || typeof storage.getItem !== "function") return undefined
    return storage
  } catch {
    return undefined
  }
}

function choiceFrom(value: unknown): OcrModelChoice | undefined {
  if (!value || typeof value !== "object") return undefined
  const primary = (value as { primary_model?: unknown }).primary_model
  const backup = (value as { backup_model?: unknown }).backup_model
  if (typeof primary !== "string" || primary.trim() === "" || primary !== primary.trim()) return undefined
  if (typeof backup === "string" && backup.trim() !== "" && backup === backup.trim() && backup !== primary) {
    return { primary_model: primary, backup_model: backup }
  }
  return { primary_model: primary }
}

/** Absent, unreadable or not an explicit model: follow the system default. */
export function readOcrModelChoice(storage: KeyValue | undefined = browserStorage()): OcrModelChoice | undefined {
  if (!storage) return undefined
  try {
    const raw = storage.getItem(STORAGE_KEY)
    if (!raw) return undefined
    return choiceFrom(JSON.parse(raw))
  } catch {
    return undefined
  }
}

/** `undefined` clears the key so the next task follows the system default again. */
export function writeOcrModelChoice(
  choice: OcrModelChoice | undefined,
  storage: KeyValue | undefined = browserStorage(),
): void {
  if (!storage) return
  try {
    const normalized = choiceFrom(choice)
    if (!normalized) storage.removeItem(STORAGE_KEY)
    else storage.setItem(STORAGE_KEY, JSON.stringify(normalized))
  } catch {
    /* a locked-down profile keeps the in-memory choice for this tab */
  }
}

/**
 * Freeze the model that a new recognition task will keep.
 *
 * An explicit primary is copied as chosen. Backup stays off unless the
 * operator turned it on. 「系统默认」 has no primary yet: pin the catalogue's
 * current default and do not add a backup. Failover on 429/5xx is unchanged
 * and is not decided here.
 */
export function routingForNewTask(
  preference: OcrModelChoice | undefined,
  catalogue: OcrCatalogueDefault | undefined,
): OcrModelChoice | undefined {
  const explicit = choiceFrom(preference)
  if (explicit) return explicit
  const pinned = catalogue?.default_ocr_model?.trim()
  if (!pinned) return undefined
  return { primary_model: pinned }
}
