import { useId } from "react"
import { FieldMeta } from "@/components/field-meta"
import { Field, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"

import type { ProductProfile } from "@/listing-core/types"
export const EMPTY_PROFILE: ProductProfile = { product_type_ru: "", facts_ru: "" }

export function readProductProfile(raw: string): ProductProfile | null {
  try {
    const value: unknown = JSON.parse(raw)
    if (!value || typeof value !== "object") return null
    const p = value as Record<string, unknown>
    if (Object.keys(p).some(key => !(key in EMPTY_PROFILE)) || Object.keys(EMPTY_PROFILE).some(key => typeof p[key] !== "string")) return null
    return p as ProductProfile
  } catch { return null }
}

export function ProductProfileFields({ value, onChange, disabled }: {
  value: ProductProfile
  onChange: (value: ProductProfile) => void
  disabled?: boolean
}) {
  const id = useId()
  return <div className="flex flex-col gap-3" data-product-profile-fields="">
    <Field>
      <div className="flex min-h-6 flex-wrap items-center gap-1.5">
        <FieldLabel htmlFor={`${id}-type`}>俄文商品类型</FieldLabel>
        <FieldMeta name="俄文商品类型" required description="标题中的商品名称，使用俄文填写；识图只补充画面主题，不推测商品类型。" />
      </div>
      <Input id={`${id}-type`} aria-label="俄文商品类型" required value={value.product_type_ru} disabled={disabled} placeholder="Кружка / Коврик для мыши" onChange={e => onChange({ ...value, product_type_ru: e.target.value })} />
    </Field>
    <Field>
      <div className="flex min-h-6 flex-wrap items-center gap-1.5">
        <FieldLabel htmlFor={`${id}-facts`}>确认属性（俄文）</FieldLabel>
        <FieldMeta name="确认属性（俄文）" essential description="标题中的尺寸、材质、容量等已确认事实，使用俄文填写；无相关属性时可留空。" />
      </div>
      <Input id={`${id}-facts`} aria-label="确认属性（俄文）" value={value.facts_ru} disabled={disabled} placeholder="керамическая 330 мл" onChange={e => onChange({ ...value, facts_ru: e.target.value })} />
    </Field>
    <p className="break-words text-compact text-muted-foreground" aria-live="polite">标题：{[value.product_type_ru, value.facts_ru].filter(Boolean).join(" ") || "商品类型与确认属性"} {"\"图片主题\""}</p>
  </div>
}
