import type { components } from "@/api/schema"

type SupplierOzonConfigValue = components["schemas"]["SupplierOzonConfigValue"]

/** Numeric editors keep raw text while typing; only unambiguous values become typed. */
export function numericAttributeValue(
  raw: string,
  editor: "integer" | "decimal",
): SupplierOzonConfigValue {
  const text = raw.trim()
  if (editor === "integer" && /^-?(?:0|[1-9]\d*)$/.test(text)) {
    const number = Number(text)
    if (Number.isSafeInteger(number) && String(number) === text) {
      return { kind: "integer", value: number }
    }
  }
  if (
    editor === "decimal" &&
    /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(text) &&
    Number.isFinite(Number(text))
  ) {
    return { kind: "decimal", value: text }
  }
  return { kind: "text", value: raw }
}
