const DEVICE_ID_STORAGE_KEY = "podhub:spa-device-id"
let fallbackId: string | undefined

/** Shared inbox identity; never a credential. Storage denial stays a quiet side path. */
export function spaDeviceId(
  storage?: Pick<Storage, "getItem" | "setItem">,
): string {
  try {
    const store = storage ?? window.localStorage
    const existing = store.getItem(DEVICE_ID_STORAGE_KEY)
    if (existing && /^spa-[0-9a-f-]{36}$/.test(existing)) return existing
    const generated = fallbackId ??= `spa-${crypto.randomUUID()}`
    store.setItem(DEVICE_ID_STORAGE_KEY, generated)
    return generated
  } catch {
    return fallbackId ??= `spa-${crypto.randomUUID()}`
  }
}
