/**
 * The in-cell source marker vocabulary (D3): which layer wrote a value, and
 * which layers may still overwrite it. Pure data — the marker presentation
 * lives in `field-source-marker.tsx`.
 */
import type { components } from "@/api/schema"
import {
  Barcode,
  Database,
  FileImage,
  Layers,
  Package,
  PenLine,
  ScanText,
  Settings2,
  type LucideIcon,
} from "lucide-react"

export type FieldLayerView = components["schemas"]["FieldLayerView"]

/**
 * The wire layer order (OpenAPI `FIELD_LAYER_ORDER`), weak → strong. Typed as
 * the wire tuple itself — a local order cannot drift from the wire one.
 */
export const FIELD_LAYER_ORDER: components["schemas"]["FIELD_LAYER_ORDER"] = [
  "database_default",
  "instance",
  "seller_sku",
  "user_custom",
  "ocr",
  "source_file",
  "renderer",
  "system_default",
]

/**
 * Which layers may overwrite a value the given layer wrote, by the build
 * write rules (`build.rs` layer table): instance-owned keys replace the card
 * default; the seller code replaces instance/card labels; manual and confirmed
 * recognition win by exact address; source-file, renderer and system defaults
 * only ever fill blanks, so a value they produced is only ever replaced by a
 * later operator or recognition write.
 */
const OVERRIDERS: Readonly<Record<FieldLayerView, readonly FieldLayerView[]>> = {
  database_default: ["instance", "seller_sku", "user_custom", "ocr"],
  instance: ["seller_sku", "user_custom", "ocr"],
  seller_sku: ["user_custom", "ocr"],
  user_custom: ["ocr"],
  ocr: ["user_custom"],
  source_file: ["user_custom", "ocr"],
  renderer: ["user_custom"],
  system_default: ["user_custom"],
}

export const LAYER_LABEL: Readonly<Record<FieldLayerView, string>> = {
  database_default: "数据库默认",
  seller_sku: "卖家货号",
  instance: "实例",
  user_custom: "用户自定义",
  ocr: "AI 识别",
  source_file: "源文件",
  renderer: "渲染器",
  system_default: "系统缺省",
}

/** Semantic tone tokens from `src/index.css`; no bare colors. */
const LAYER_TONE: Readonly<Record<FieldLayerView, string>> = {
  database_default: "text-muted-foreground",
  seller_sku: "text-store-amber-ink",
  instance: "text-store-teal-ink",
  user_custom: "text-primary",
  ocr: "text-brand-ink",
  source_file: "text-store-indigo-ink",
  renderer: "text-store-cyan-ink",
  system_default: "text-faint-foreground",
}

const LAYER_ICON: Readonly<Record<FieldLayerView, LucideIcon>> = {
  database_default: Database,
  seller_sku: Barcode,
  instance: Package,
  user_custom: PenLine,
  ocr: ScanText,
  source_file: FileImage,
  renderer: Layers,
  system_default: Settings2,
}

export type SourceMarker = {
  icon: LucideIcon
  tone: string
  label: string
  /** Layers that may overwrite this layer's value, in wire order. */
  overriddenBy: readonly FieldLayerView[]
}

/** Everything the in-cell marker and its tooltip show for one layer. */
export function sourceMarker(layer: FieldLayerView): SourceMarker {
  const wireIndex = new Map(FIELD_LAYER_ORDER.map((entry, index) => [entry, index]))
  const overriddenBy = [...OVERRIDERS[layer]].sort(
    (left, right) => (wireIndex.get(left) ?? 0) - (wireIndex.get(right) ?? 0),
  )
  return {
    icon: LAYER_ICON[layer],
    tone: LAYER_TONE[layer],
    label: LAYER_LABEL[layer],
    overriddenBy,
  }
}

/** The tooltip's second line: who can still overwrite this value. */
export function overriddenByCopy(marker: SourceMarker): string {
  if (!marker.overriddenBy.length) return "该层是最终写入者"
  return `可被 ${marker.overriddenBy.map((layer) => LAYER_LABEL[layer]).join("、")} 覆盖`
}
