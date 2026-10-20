package contract

import "errors"

// Fail is an HTTP-shaped outcome. Handlers map it and do not invent a second code.
type Fail struct {
	Status  int
	Code    string
	Message string
}

func (f *Fail) Error() string {
	if f == nil {
		return ""
	}
	return f.Message
}

func (f *Fail) Is(target error) bool {
	other, ok := target.(*Fail)
	return ok && other != nil && f != nil && f.Status == other.Status && f.Code == other.Code
}

func fail(status int, code, message string) *Fail {
	return &Fail{Status: status, Code: code, Message: message}
}

func Unavailable() error { return fail(503, "internal", "服务暂不可用") }

func WritesDisabled() error {
	return fail(503, "OZON_WRITES_DISABLED", "Ozon 写入已停止")
}

func RateLimited() error { return fail(429, "rate_limited", "请求过于频繁") }

func BadRequest(message string) error {
	if message == "" {
		message = "请求无效"
	}
	return fail(400, "bad_request", message)
}

func NotFound() error { return fail(404, "not_found", "资源不存在") }

func Forbidden() error { return fail(403, "forbidden", "当前角色无权执行此操作") }

func Busy() error { return fail(409, "warehouse_busy", "该仓库已有进行中的写操作") }

func InFlight() error {
	return fail(409, "grant_in_flight", "该操作正在进行，不会再次发放密钥")
}

func GrantExpired() error {
	return fail(409, "grant_expired", "发放已过期，不会再次发放密钥")
}

func IntentClosed() error {
	return fail(409, "intent_closed", "该操作已结束，不会再次发放密钥")
}

func ConfirmRequired() error {
	return fail(400, "confirm_required", "归档必须带 confirm=true 与目标 warehouse_id")
}

func WarehouseStatus() error {
	return fail(409, "warehouse_status", "当前仓库状态不允许该操作")
}

func NotSynced() error { return fail(409, "warehouse_not_synced", "请先同步仓库后再操作") }

func ReportState() error { return fail(409, "report_state", "该意图不能报回") }

func CredentialUnavailable() error {
	return fail(503, "credential_unavailable", "店铺密钥暂不可用")
}

func Ozon() error { return fail(502, "ozon_error", "Ozon 读取失败") }

func Obsolete() error {
	return fail(502, "ozon_obsolete", "仓库列表接口已停用，未回退到旧路径")
}

func NotPorted() error { return fail(501, "not_ported", "not_ported") }

// OpenError is a credential admission failure. It never carries a key.
type OpenError struct {
	Status  int
	Code    string
	Message string
}

func (e *OpenError) Error() string {
	if e == nil {
		return ""
	}
	return e.Message
}

// ErrRateLimited is the limiter sentinel. It is not an HTTP body by itself.
var ErrRateLimited = errors.New("rate limited")
