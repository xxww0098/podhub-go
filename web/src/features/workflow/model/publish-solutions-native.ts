import type { components } from "@/api/schema"
import type { DiagnosticCode } from "@/lib/diagnostic-summary"

export type NativeIssueKey = components["schemas"]["KnownIssueKey"]
export type Solution = {
  reason: string
  scope: "row" | "store" | "block" | "platform"
  steps: readonly string[]
  actions: readonly components["schemas"]["ListingIssueAction"][]
  reportable: boolean
  diagnosticCode: DiagnosticCode | null
}
/** Adding any native platform, stage or code requires its presentation entry. */
export type NativeSolutionTable<K extends { platform: string; stage: string; code: string } = NativeIssueKey> = {
  [P in K["platform"]]: {
    [S in Extract<K, { platform: P }>["stage"]]: {
      [C in Extract<K, { platform: P; stage: S }>["code"]]: Solution
    }
  }
}

const field = (reason: string, step = "按原生校验指出的字段修改并保存，再重新校验"): Solution =>
  ({ reason, scope: "row", steps: [step], actions: ["edit_row"], reportable: false, diagnosticCode: null })
const store = (reason: string, step: string): Solution =>
  ({ reason, scope: "store", steps: [step], actions: ["check_store"], reportable: false, diagnosticCode: null })
const unclassified: Solution = {
  reason: "平台访问响应未能分类，当前发送状态需要核对", scope: "store",
  steps: ["保留诊断编号，请管理员核对原店铺 Intent 与平台记录；确认前不要重发"],
  actions: [], reportable: true, diagnosticCode: "unclassified_server",
}
const rate = store("平台限制了该店铺的请求频率", "等待限制解除，核对原 Intent 是否已派发，再决定下一步；不要连续点击发送")

/** Native owns validation. This table supplies explanations, never duplicate rules. */
export const nativeSolutions = {
  ozon: {
    validate: {
      required: field("缺少类目必填字段"),
      max_value_count: field("字段值数量超过类目限制"),
      complex_single_item: field("复杂字段组只允许一个项目"),
      name_contains_han: field("商品名称含平台不接受的中文字符"),
      name_too_long: field("商品名称超过 200 个字符", "缩短商品名称至 200 个字符以内，保存后重新校验"),
      offer_id_too_long: field("货号长度超过平台限制"),
      offer_id_charset: field("货号包含平台不支持的字符"),
      invalid_barcode: field("条形码格式未通过校验"),
      invalid_price: field("价格未通过校验"),
      invalid_positive_integer: field("字段需要正整数"),
      invalid_integer: field("字段需要整数"),
      invalid_decimal: field("字段需要有效数字"),
      invalid_boolean: field("字段需要布尔值"),
      invalid_url: field("字段链接格式未通过校验"),
      invalid_choice: field("字段选项不属于当前类目"),
      invalid_choice_cardinality: field("字段选项数量不符合当前类目"),
      invalid_dictionary_id: field("字段字典编号无效"),
      unknown_dictionary_id: field("字段字典编号不在当前元数据中"),
      dictionary_material_required: field("字段校验缺少字典材料", "从类目元数据入口加载对应字典，再明确执行校验"),
    },
    freeze: {
      row_id_invalid: field("商品行标识无效", "重新载入原商品行；不要新建行来绕过旧发送记录"),
      schema_stale: field("类目字段版本已变化", "刷新当前类目元数据，重新校验；只对确定未派发或已拒绝的行明确发送"),
      coordinate_mismatch: field("商品与类目坐标不一致", "核对原类目和商品归属，修正后重新校验"),
      language_mismatch: field("类目材料的语言与商品不一致"),
      ai_candidate_unresolved: field("AI 候选尚未全部确认", "审阅并确认或忽略各项 AI 候选，再重新校验"),
      freeze_failed: { ...field("生成发送快照未完成", "保留诊断编号，重新加载本地校验模块后明确校验；不要自动重发"), reportable: true, diagnosticCode: "contract_violation" },
    },
    pre_dispatch: {
      OZON_STORE_PAUSED: store("店铺发送已暂停", "在店铺设置检查暂停原因，解除后核对当前 Intent"),
      OZON_RATE_LIMITED: rate,
      OZON_EGRESS_UNAVAILABLE: store("店铺发送出口不可用", "请管理员检查发送出口，恢复后核对当前 Intent"),
      OZON_EGRESS_UNREACHABLE: store("店铺发送出口无法连接", "请管理员检查出口连通性，核对当前 Intent 后再操作"),
      OZON_WRITES_DISABLED: {
        reason: "PodHub 已暂停向 Ozon 发送商品，本次尚未发送", scope: "platform",
        steps: ["请联系 PodHub 管理员恢复发送服务；恢复后刷新页面，选中商品并点击「发送」。系统不会自动重发，无需重新识别或生成图片"],
        actions: ["check_store"], reportable: false, diagnosticCode: null,
      },
      OZON_ACCESS_UNCLASSIFIED: unclassified,
      SHIPPING_NOT_READY: field("发货信息尚未准备完成", "补齐供货与发货配置，保存后重新校验"),
    },
    submit: {
      OZON_ROW_REJECTED: field("平台拒绝了商品字段", "按平台给出的字段原因修改并保存，重新校验后明确发送"),
      OZON_CREDENTIAL_INVALID: store("平台拒绝了店铺凭据", "在店铺设置更新该店铺凭据并核对访问权限；不要把密钥写入诊断信息"),
      OZON_PERMISSION_DENIED: store("店铺缺少平台操作权限", "在卖家后台检查 API 权限，再到店铺设置核对授权"),
      OZON_ACCESS_UNCLASSIFIED: unclassified,
      OZON_RATE_LIMITED: rate,
      OZON_DISPATCH_INTERRUPTED: {
        reason: "发送中断且结果未确认", scope: "row", actions: [], reportable: true, diagnosticCode: "result_unknown",
        steps: ["核对原店铺的确切 Intent 与平台记录；确认前不要重发、修复重发或释放其它操作"],
      },
    },
    preview: {
      variant_metadata_unknown: {
        reason: "当前类目材料还没有变体规则（缺少 is_aspect）", scope: "block",
        steps: ["从类目元数据入口刷新当前类目字段，拿到变体规则后再预览；刷新前不要按“没有变体字段”发送"],
        actions: ["edit_row"], reportable: false, diagnosticCode: null,
      },
      variant_model_field_absent: {
        reason: "该类目没有可用的共同型号字段（9048）", scope: "block",
        steps: ["本版只支持卖家后台提供的 plain 9048 型号字段；该类目按单规格分别上架"],
        actions: [], reportable: false, diagnosticCode: null,
      },
      variant_model_field_complex: {
        reason: "该类目的型号字段只存在于复杂属性组里", scope: "block",
        steps: ["本版不支持复杂组里的型号字段；该类目按单规格分别上架，不要用其它字段冒充型号"],
        actions: [], reportable: false, diagnosticCode: null,
      },
      variant_dimension_complex: {
        reason: "区分变体的字段落在复杂属性组里，本版无法可靠归一化", scope: "block",
        steps: ["该类目暂不支持同款分组；不要用忽略该维度的方式绕过"],
        actions: [], reportable: false, diagnosticCode: null,
      },
      variant_category_mismatch: {
        reason: "同一组商品不在同一类目或商品类型", scope: "row",
        steps: ["把不同类目或类型的商品移出该组，重新预览"],
        actions: ["edit_row"], reportable: false, diagnosticCode: null,
      },
      variant_brand_mismatch: {
        reason: "同一组商品的品牌不一致", scope: "row",
        steps: ["统一品牌，或把它们拆成不同型号，重新预览"],
        actions: ["edit_row"], reportable: false, diagnosticCode: null,
      },
      variant_no_distinguishing_dimension: {
        reason: "该类目没有区分变体的字段，无法组成同款多规格", scope: "block",
        steps: ["按单规格分别上架；不要把普通字段当成变体维度"],
        actions: [], reportable: false, diagnosticCode: null,
      },
      variant_combination_duplicate: {
        reason: "同组内出现完全相同的规格组合", scope: "row",
        steps: ["改成不同的规格组合，或把重复的商品移出该组，重新预览"],
        actions: ["edit_row"], reportable: false, diagnosticCode: null,
      },
      variant_write_member_unknown: {
        reason: "本次发送引用了不属于该组的商品", scope: "row",
        steps: ["重新预览并重新选择本组商品；不要只发送组外的一件"],
        actions: ["edit_row"], reportable: false, diagnosticCode: null,
      },
    },
  },
  wb: {
    metadata: {
      catalog_unavailable: field("WB 类目目录尚未提供", "从 WB 类目入口获取原生 subject/characteristic 目录；保留当前预览，目录为空时联系管理员补充"),
      catalog_stale: field("WB 类目目录版本已变化", "明确刷新 WB 类目元数据，再校验当前预览"),
      defaults_stale: field("WB 默认字段版本已变化", "重新载入当前方案默认字段，再校验预览"),
      catalog_invalid: field("WB 类目目录不完整", "保留预览并联系管理员修正原生目录，再明确加载"),
    },
    validate: {
      unknown_characteristic: field("WB characteristic 不属于当前 subject"),
      blank_text: field("WB 文本值为空白"),
      max_count: field("WB 特征值数量超过目录限制"),
      nonfinite_number: field("WB 数字不是有限值"),
      value_type: field("WB 特征值类型不符"),
      required: field("缺少 WB 必填特征"),
      coordinate_mismatch: field("WB subject 与目录坐标不符"),
      invalid_dimensions: field("WB 尺寸未通过校验"),
      variant_count: field("WB 变体数量未通过校验"),
      vendor_code_required: field("WB 变体缺少货号"),
      vendor_code_too_long: field("WB 货号长度超过平台限制"),
      title_too_long: field("WB 标题长度超过平台限制"),
    },
    preview: {
      upload_too_large: field("WB 预览大小超出限制", "减少当前组的变体或字段内容，重新生成预览"),
      encoding_failed: { ...field("WB 预览编码未完成", "保留诊断编号，重新加载本地模块后明确生成预览"), reportable: true, diagnosticCode: "contract_violation" },
    },
  },
} satisfies NativeSolutionTable

/** Runtime boundary: illegal external tuples never index inherited object keys. */
export function nativeSolution(platform: string, stage: string, code: string): Solution | undefined {
  for (const [p, stages] of Object.entries(nativeSolutions)) {
    if (p !== platform) continue
    for (const [s, codes] of Object.entries(stages)) {
      if (s !== stage) continue
      for (const [c, solution] of Object.entries<Solution>(codes)) if (c === code) return solution
    }
  }
  return undefined
}
