/**
 * Product identity for the SPA.
 *
 * Root `VERSION` is the SSOT. Vite injects it as
 * `import.meta.env.PODHUB_VERSION`. Display surfaces use `vX.Y.Z`.
 */
export function productVersion(version?: string): string {
  const explicit = version?.trim() ?? ""
  if (explicit) return explicit
  try {
    return import.meta.env.PODHUB_VERSION.trim()
  } catch {
    return ""
  }
}

export function productVersionLabel(version?: string): string {
  const raw = productVersion(version)
  return raw ? `v${raw}` : ""
}
