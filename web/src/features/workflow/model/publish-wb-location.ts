import type { WbIssue } from "@/listing-core/wb-types"
import type { PublishProblem } from "./publish-problem"

/** Native coordinates plus the captured local record and ordered input length. */
export type PublishWbLocation = Readonly<{
  platform: "wb"
  recordId: string
  variantCount: number
  scope: WbIssue["scope"] | "record"
  field: WbIssue["field"] | "record_id"
  characteristicId: WbIssue["characteristicId"]
  variantIndex: WbIssue["variantIndex"]
}>

// This is field-label copy, not a second native validation table.
const fieldLabels = {
  catalog: "类目目录", defaults: "方案默认特征", subject: "subject", language: "语言",
  variants: "变体列表", vendor_code: "货号 vendorCode", title: "标题 title",
  dimensions: "尺寸 dimensions", characteristic: "特征 characteristic", payload: "上传预览",
  record_id: "预览记录标识",
} satisfies Record<PublishWbLocation["field"], string>

/** Check representability and attribution only. Rust still owns field validity.
 * A preview's variant index must address its captured ordered input, never an
 * assumed first variant. Signed characteristic IDs include native unknown-ID issues. */
export function wbLocationPresentation(problem: PublishProblem): { scope: string; step: string } | undefined {
  const location = problem.location
  if (!location || typeof location !== "object" || problem.platform !== "wb" || problem.family !== undefined
    || location.platform !== "wb" || !Number.isSafeInteger(location.variantCount) || location.variantCount < 0) return
  const label = Object.entries(fieldLabels).find(([field]) => field === location.field)?.[1]
  if (!label || (location.characteristicId !== null && !Number.isSafeInteger(location.characteristicId))
    || (location.field === "characteristic") !== (location.characteristicId !== null)) return
  const recordIssue = problem.stage === "identity" && problem.code === "group_key_invalid"
  if (location.scope === "record") {
    if (!recordIssue || location.field !== "record_id" || location.variantIndex !== null) return
    return { scope: "本次 WB 预览记录标识；商品组无法唯一定位",
      step: "核对本次选择的原预览记录，恢复每个商品组的唯一标识后再明确生成预览；不要按此问题修改某个变体" }
  }
  if (recordIssue || location.field === "record_id" || typeof location.recordId !== "string"
    || !/^[A-Za-z0-9_.-]{1,128}$/.test(location.recordId)) return
  const group = `商品组 ${location.recordId}`
  const field = location.characteristicId === null ? label : `${label} ${location.characteristicId}`
  switch (location.scope) {
    case "material":
      if (location.variantIndex !== null) return
      return { scope: `${group} 所用 WB 类目材料；共用该材料的商品组也需核对；${field}`,
        step: `在 ${group} 的 WB 类目或方案默认字段入口核对${field}，处理后明确加载材料并重新校验；不要将此问题归给某个变体` }
    case "group":
      if (location.variantIndex !== null) return
      return { scope: `${group} 整组；${field}`,
        step: `核对 ${group} 的${field}及有序变体列表，修正后保存并重新生成整组预览` }
    case "variant":
      if (location.variantIndex === null || !Number.isSafeInteger(location.variantIndex)
        || location.variantIndex < 0 || location.variantIndex >= location.variantCount) return
      return { scope: `${group} 的第 ${location.variantIndex + 1} 个变体（原生序号 ${location.variantIndex}）；${field}`,
        step: `修改 ${group} 的第 ${location.variantIndex + 1} 个变体的${field}，保存后重新校验整组；变体序号按当前输入顺序，不要修改其它变体来代替` }
  }
}
