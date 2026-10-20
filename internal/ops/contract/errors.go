// Package contract is the ops surface. The domain level is L3.
package contract

import "errors"

const (
	CodeAuthRequired    = "auth_required"
	CodeForbidden       = "forbidden"
	CodeValidation      = "validation"
	CodeNotFound        = "not_found"
	CodeConflict        = "conflict"
	CodeInternal        = "internal"
	CodeOzonAuthFailed  = "ozon_auth_failed"
	CodeOzonRateLimited = "ozon_rate_limited"
	CodeShipping        = "ozon_shipping_failed"
	CodeReturns         = "ozon_ops_returns_failed"
	CodeVoice           = "ozon_voice_failed"
	CodeSupply          = "ozon_supply_failed"
	CodeProducts        = "ozon_products_failed"
	CodeMessage         = "ozon_message_center_failed"
	CodeConsole         = "ozon_console_failed"
	CodeWritesDisabled  = "writes_disabled"
	CodeSellerUnknown   = "seller_result_unknown"
	CodeRefreshBusy     = "console_refresh_busy"
	CodeNotPorted       = "not_ported"
	// The env name is split so this file is not a second parse point.
	WritesDisabledMessage = "OZON_WRITE_" + "KILL_SWITCH 已启用，Ozon 实时写入已停止"
	MsgInFlight           = "该操作已派发或中断，系统不会自动重复提交；请先同步商品确认状态"
	MsgKeyBound           = "Seller 幂等键已绑定到不同请求"
	MsgUnavailable        = "服务暂不可用"
	MsgBusy               = "资源正在更新，请稍后重试"
	MsgMediaGone          = "媒体对象已进入回收，请重新上传"
	MsgStoreMissing       = "Store 不存在"
	MsgMemberUnavailable  = "工作空间成员当前不可用"
	MsgStoreDisabled      = "店铺已停用，无法使用"
	MsgQuotaSuspended     = "店铺配额已挂起，无法使用"
	MsgKeyExpired         = "Seller 密钥已过期，请在卖家后台重新生成后登记"
	MsgKeyMissing         = "Store 尚未登记密钥"
	MsgKeyHostMissing     = "Seller 密钥托管未配置"
	MsgNoWriteRole        = "当前角色不能对 Ozon 执行写操作"
	MsgNoReconcileRole    = "当前角色不能执行店铺对账"
	MsgNoStoreRead        = "当前角色不能读取店铺数据"
	MsgRefreshBusy        = "经营指标正在刷新，请等待本轮完成后再试"
	KindProductMutation   = "product_mutation"
	KindChatSend          = "chat_send"
	ResultUnknownProduct  = "OZON_PRODUCT_MUTATION_RESULT_UNKNOWN"
	ResultUnknownChat     = "OZON_CHAT_SEND_RESULT_UNKNOWN"
	ProbeConflict         = "OZON_WRITE_CONFLICT"
	ProbeUnknown          = "OZON_WRITE_RESULT_UNKNOWN"
)

// ErrNotPorted is the body when the Rust rejection text was not in the spec.
var ErrNotPorted = errors.New("not_ported")

// ErrWritesDisabled is the captured kill switch. Callers compare with errors.Is.
var ErrWritesDisabled = errors.New("writes_disabled")

// ErrSaturated is an L2 slot wait that expired.
var ErrSaturated = errors.New("saturated")

// ErrRateLimited is the distributed read budget.
var ErrRateLimited = errors.New("rate_limited")

// ErrUnreachable is a base URL this process will not dial.
var ErrUnreachable = errors.New("unreachable")

// Fail is an OpsErrorResponse. Field order on the wire is error then code.
type Fail struct {
	Status     int
	Code       string
	Message    string
	RetryAfter string
}

func (f *Fail) Error() string {
	if f == nil {
		return ""
	}
	return f.Message
}

// NotPorted is the unconfirmed axum JSON rejection stand-in.
func NotPorted() *Fail {
	return &Fail{Status: 501, Code: CodeNotPorted, Message: ErrNotPorted.Error()}
}

// WritesOff is the kill switch body. Nothing was inserted and nothing was sent.
func WritesOff() *Fail {
	return &Fail{Status: 503, Code: CodeWritesDisabled, Message: WritesDisabledMessage}
}

// Validation is HTTP 400 code validation.
func Validation(message string) *Fail {
	return &Fail{Status: 400, Code: CodeValidation, Message: message}
}

// Forbidden is HTTP 403.
func Forbidden(message string) *Fail {
	return &Fail{Status: 403, Code: CodeForbidden, Message: message}
}

// Internal is the default database failure.
func Internal(message string) *Fail {
	if message == "" {
		message = MsgUnavailable
	}
	return &Fail{Status: 500, Code: CodeInternal, Message: message}
}
