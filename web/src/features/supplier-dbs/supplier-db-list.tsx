/** A country is `''` or ISO-3166-1 alpha-2; the select covers the common ones. */
export const COUNTRY_OPTIONS: Array<{ code: string; label: string }> = [
  { code: "CN", label: "中国" },
  { code: "US", label: "美国" },
  { code: "CA", label: "加拿大" },
  { code: "MX", label: "墨西哥" },
  { code: "BR", label: "巴西" },
  { code: "IT", label: "意大利" },
  { code: "GB", label: "英国" },
]

export function supplierDbCountryLabel(code: string): string {
  if (!code) return "—"
  return COUNTRY_OPTIONS.find((option) => option.code === code)?.label ?? code
}
