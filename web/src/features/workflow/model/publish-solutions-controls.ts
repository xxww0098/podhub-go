import type { DiagnosticCode } from "@/lib/diagnostic-summary"
import type { components } from "@/api/schema"
import type { PsdTemplateFailureCause } from "../prepare/psd-template-failure"
import type { Solution } from "./publish-solutions-native"

const manual = (reason: string, step: string, scope: Solution["scope"] = "row", diagnosticCode: DiagnosticCode | null = null): Solution =>
  ({ reason, scope, steps: [step], actions: [], reportable: diagnosticCode !== null, diagnosticCode })
export const contractSolution = manual(
  "发布结果与当前接口合同不符，无法判定可执行动作",
  "保留平台、阶段、对象与诊断编号，请管理员核对原 Intent 和接口版本；确认前不要重发",
  "row", "contract_violation",
)
export const unknownSolution = manual("本次发送结果未确认", "核对原平台、原店铺的确切 Intent 和平台记录；不要重复发送", "row", "result_unknown")
export const offerBusySolution = manual(
  "本次整块未入队：店铺的历史发送记录触发了货号保护，可能在发送中、结果未确认或已受理；不表示块内每个货号都冲突",
  "在原店铺按货号核对历史发送记录和平台任务：已受理的商品在卖家后台管理；在途发送请等待；结果未确认时不要重发，由管理员核对确切 Intent ID 和平台记录。仅对确认允许发送的商品重新读回当前状态并通过原生校验，再由用户明确发送",
  "block",
)
export const notEnabledSolution = manual(
  "WB 真实发送尚未启用，当前仅支持字段拼接、校验和预览",
  "保留 WB 原生预览，完成类目与变体校验；需要上架时到 WB 卖家后台处理。等待 WB 凭据、提交端点与 Intent 能力上线后再明确发送；不会转发到其它平台或自动重试",
)
export const draftSkipSolutions = {
  schema_stale: manual("类目字段版本已变化", "刷新当前类目材料并重新校验；仅对确定拒绝的本次输入明确发送"),
  blocked: manual("商品当前状态不允许发送", "查看本行阻止项，完成字段或准备步骤；有旧发送记录时先核对原 Intent"),
  media_foreign: manual("媒体证据不属于当前工作空间", "在当前工作空间重新上传并保存本行媒体，再重新校验"),
  media_expired: manual("本行媒体证据已过期", "重新上传或确认本行媒体，保存后重新校验；只有确定未派发的输入才可再次发送"),
  offer_busy: manual("此商品的货号已有在途、未确认或已受理的发送记录", "按货号核对原店铺的历史发送记录；已受理的商品在卖家后台管理，无法确认结果时不要再次发送"),
  compose_failed: manual("本行发送字段拼接未完成", "检查本行字段和类目材料，保存并通过原生校验后再明确发送"),
} satisfies Record<components["schemas"]["SubmitDraftSkipReason"], Solution>
export const legacySkipSolutions = {
  not_found: manual("原商品行已不存在", "刷新方案核对商品归属与历史发送记录，不要使用失效行标识发送"),
  store_mismatch: manual("商品绑定的店铺与本次发送不一致", "检查上架方案与此行的目标店铺，保存后再发送"),
  store_unbound: manual("商品尚未绑定目标店铺", "在上架方案选择可用店铺并保存后再发送"),
  compose_failed: draftSkipSolutions.compose_failed,
  blocked: draftSkipSolutions.blocked,
  waiting: manual("发送队列等待中：店铺并发已满或该行准备尚未完成", "查看当前准备进度与原 Intent；等待当前工作结束，不要重复提交"),
  already_accepted: manual("该商品已在 Ozon 受理（此前发送），未重复创建", "在原店铺按货号核对已有商品与平台任务；不要重复发送"),
  revision_mismatch: manual("商品已更新，请刷新后再发送", "载入此行当前版本，核对字段并重新校验"),
} satisfies Record<components["schemas"]["ListingBatchSkipReason"], Solution>
export const freezeSolutions = {
  row_id_invalid: legacySkipSolutions.not_found,
  schema_stale: draftSkipSolutions.schema_stale,
  coordinate_mismatch: manual("商品与类目坐标不一致", "核对该行和方案的原生类目坐标，保存并重新校验"),
  candidates_unresolved: manual("AI 候选尚未全部确认", "确认或忽略本行候选后重新校验"),
  validation_failed: manual("本行未通过原生字段校验", "修正原生校验指出的字段，保存后重新校验"),
  freeze_failed: manual("本行发送快照生成未完成", "保留诊断编号，重新载入本地模块再明确校验", "row", "contract_violation"),
} satisfies Record<components["schemas"]["FreezeRefusal"], Solution>
export const requestSolutions = {
  auth_required: manual("登录状态已失效", "重新登录并载入原工作空间，再核对发送状态"),
  auth_invalid: manual("当前会话无法认证", "重新登录并载入原工作空间，再核对发送状态"),
  forbidden: manual("当前成员没有此操作权限", "请工作空间管理员核对该店铺和操作权限"),
  validation: manual("方案或商品未通过保存校验", "修正校验指出的字段或组并重新保存，再明确发送"),
  not_found: legacySkipSolutions.not_found,
  template_object_missing: manual("PSD 云端备份尚未完成", "本机原文件仍在时可继续工作；后台确认对象缺失后有限重试，仍失败时在原设备重新绑定以备份"),
  conflict: manual("当前输入与已保存版本冲突", "刷新当前版本，核对原 Intent 与字段；确认前不要重发"),
  gone: manual("此旧操作入口已退役", "使用当前商品编辑或确切 Intent 管理入口；本页未接入时按人工步骤处理"),
  schema_sync_required: draftSkipSolutions.schema_stale,
  media_confirmation_required: draftSkipSolutions.media_expired,
  queue_busy: manual("当前发送队列正在处理其它任务", "等待当前任务结束后查看各行状态，不要连续提交", "store"),
  supplier_not_listable: manual("供货商品当前不可上架", "查看供货商品状态并请供应商修正，再重新校验"),
  not_replayable: manual("此任务不允许重放", "核对原 Intent 和平台记录，不要通过重新建行绕过限制"),
  store_unusable: manual("目标店铺当前不可用", "在店铺设置核对绑定、权限与凭据", "store"),
  store_busy: manual("目标店铺发送槽位暂时占满", "等待原队列的有界等待结束；仍受阻时核对该店铺在途 Intent", "store"),
  store_unavailable: manual("目标店铺暂时无法发送", "检查店铺状态并核对在途 Intent，再明确操作", "store"),
  submit_capacity_full: manual("发送服务暂时没有可用容量", "等待当前提交完成，再核对本次是否已入队；不要连续提交", "block"),
  offer_busy: offerBusySolution,
  internal: manual("发送服务返回未分类的内部失败", "保留诊断编号，请管理员核对原店铺 Intent 与服务记录；确认前不要重发", "block", "unclassified_server"),
} satisfies Record<components["schemas"]["ListingErrorCode"], Solution>
export const psdSolutions = {
  template_unbound: manual("上架方案未绑定 PSD 模板", "返回建卡页绑定原始 PSD 模板后重试切片"),
  supplier_template_unbound: manual("供货商品没有唯一 PSD 模板", "在在线商库配置唯一 PSD 模板后重试切片"),
  template_restore_failed: manual("当前切片尝试未能恢复 PSD 模板", "检查方案原始 PSD 绑定和本机文件权限，重新选择同一模板后重试切片"),
} satisfies Record<PsdTemplateFailureCause, Solution>
export const controlSolutions = {
  result_unconfirmed: unknownSolution,
  network: unknownSolution,
  timeout: unknownSolution,
  cancelled: manual("已停止后续发送，该行尚未提交", "核对当前块返回的状态；需要继续时明确发送尚未提交的行"),
  wasm_failed: manual("本地原生校验模块执行中断", "保留诊断编号；下一次明确操作时重新载入模块，不自动重发", "row", "wasm_exception"),
  not_enabled: notEnabledSolution,
  contract_invalid: contractSolution,
} satisfies Record<"result_unconfirmed" | "network" | "timeout" | "cancelled" | "wasm_failed" | "not_enabled" | "contract_invalid", Solution>

/** Browser admission entries in the canonical solution table; no native field rules. */
export const adapterSolutions = {
  build: {
    transport_unavailable: manual("当前平台的发送通道尚未开通，本次未发送", "保留原平台预览；由管理员开通该平台发送能力后，再明确发送"),
    item_key_duplicate: manual("构建返回了重复商品标识", "重新载入并选择唯一商品"),
    build_failed: contractSolution,
  },
  identity: {
    row_id_invalid: freezeSolutions.row_id_invalid,
    row_id_duplicate: manual("本次选择包含重复商品行", "重新选择商品；同一行每次只能出现一次"),
    rows_empty: manual("尚未选择商品", "先选择要生成预览或发送的商品"),
    group_key_invalid: manual("WB 预览记录标识为空或重复", "重新载入原预览记录，保持每组唯一标识"),
  },
  store: { target_store_missing: legacySkipSolutions.store_unbound },
  field: { clock_invalid: contractSolution, field_rule_failed: contractSolution, field_rule_invalid: contractSolution },
  freeze: {
    core_unavailable: controlSolutions.wasm_failed,
    offer_id_duplicate: manual("同店本次选择包含重复货号", "核对源图文件名和商品归属后重新选择，不要绕过未确认的旧操作"),
  },
} satisfies Record<string, Record<string, Solution>>
