/**
 * The supplier surface URL: `/supplier` (ADR-0100 DEL-04, admin-surface 模式).
 *
 * One pathname prefix is the whole boundary: `/supplier`, `/supplier/` and any
 * deeper path paint the factory queue face, whatever the caller's standing —
 * an anonymous visitor gets the embedded 厂家登录卡 (email + password only, no
 * register mode), a signed-in non-member gets the refusal gate, a member gets
 * the queue. Pure and React-free, like [admin-surface](./admin-surface.ts).
 */

export const SUPPLIER_SURFACE_PATH = "/supplier"

export function isSupplierPath(pathname: string): boolean {
  const path = pathname.replace(/\/+$/, "") || "/"
  return (
    path === SUPPLIER_SURFACE_PATH ||
    path.startsWith(`${SUPPLIER_SURFACE_PATH}/`)
  )
}
