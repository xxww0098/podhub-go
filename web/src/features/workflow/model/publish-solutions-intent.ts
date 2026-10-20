import type { components } from "@/api/schema"
import { nativeSolutions, type Solution } from "./publish-solutions-native"
import { contractSolution, draftSkipSolutions, unknownSolution } from "./publish-solutions-controls"

/** Persisted Intent codes are a separate closed family, not native stage tuples.
 * Keep this table independent of legacy presentation and submit policy: either
 * entry point must be able to initialize the canonical solution lookup. */
export const intentSolutions = {
  ...nativeSolutions.ozon.pre_dispatch,
  ...nativeSolutions.ozon.submit,
  INTENT_PAYLOAD_UNREADABLE: contractSolution,
  STORE_CREDENTIAL_MISSING: { ...nativeSolutions.ozon.submit.OZON_CREDENTIAL_INVALID,
    reason: "店铺凭据尚未配置或不可用", steps: ["在店铺设置登记该店铺凭据，核对当前发送记录后再明确发送"] },
  STORE_CREDENTIAL_EXPIRED: { ...nativeSolutions.ozon.submit.OZON_CREDENTIAL_INVALID,
    reason: "店铺凭据已过期", steps: ["在卖家后台重新生成密钥，并在店铺设置更新该店铺凭据，再核对当前发送记录"] },
  STORE_CREDENTIAL_ERROR: { ...nativeSolutions.ozon.submit.OZON_CREDENTIAL_INVALID,
    reason: "发送服务无法读取店铺凭据", steps: ["请管理员核查店铺凭据和服务配置；恢复后核对当前发送记录，再明确发送"] },
  MEDIA_LEASE_UNAVAILABLE: { ...draftSkipSolutions.media_expired,
    reason: "发送前未取得媒体保留凭证", steps: ["核对商品图片的上传与保留状态；恢复媒体凭证并重新校验后再明确发送"] },
  MEDIA_OBJECT_MISSING: { ...draftSkipSolutions.media_expired,
    reason: "发送所需的商品图片文件已不可用", steps: ["重新上传缺失的商品图片，保存并重新校验后再明确发送"] },
  cancel_requested: { reason: "已请求停止尚未派发的任务", scope: "row", steps: ["等待当前 Intent 的权威结果；已派发的请求不因取消而视为未发送"], actions: [], reportable: false, diagnosticCode: null },
  OZON_SUBMIT_IN_FLIGHT: { ...unknownSolution, reason: "发送请求已派发，尚未取得确定结果" },
  OZON_SUBMIT_NOT_DISPATCHED: { reason: "本次 Intent 尚未派发", scope: "row", steps: ["核对当前 Intent 状态和权限；只有明确允许恢复时才继续该操作"], actions: [], reportable: false, diagnosticCode: null },
  OZON_SUBMIT_RETRY_EXHAUSTED: { reason: "当前操作已用尽发送尝试预算", scope: "row", steps: ["核对原 Intent 和拒绝原因，处理后明确操作；不要通过切换方案重置预算"], actions: [], reportable: false, diagnosticCode: null },
} satisfies Record<components["schemas"]["IntentErrorCode"], Solution>
