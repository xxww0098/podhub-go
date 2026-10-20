package contract

import "net/http"

const (
	// MsgNoWorkspace is identity::NO_ACTIVE_WORKSPACE.
	MsgNoWorkspace = "当前账号尚未加入任何工作空间，请先创建工作空间，或等待他人邀请后在通知中接受"
	// MsgUnauthenticated is the missing-session body.
	MsgUnauthenticated = "未登录"
	// MsgUnavailable is internal()'s public body.
	MsgUnavailable = "服务暂不可用"
	// MsgWritesDisabled is the entitlement lease refusal.
	MsgWritesDisabled = "委托订单写入未启用"
	// MsgStorageMissing is an unconfigured delegate asset bucket.
	MsgStorageMissing = "委托原图存储未配置，请先在集成设置中配置"
	// MsgInvalidJSON is strict_json.
	MsgInvalidJSON = "请求格式无效"
)

// APIError is DelegateErrorResponse plus the HTTP status and optional headers.
// Code is snake_case except when Media is set, which keeps SCREAMING_SNAKE.
type APIError struct {
	Status  int
	Code    string
	Message string
	Headers map[string]string
	Media   bool
}

func (e *APIError) Error() string {
	if e == nil {
		return ""
	}
	return e.Message
}

func (e *APIError) WithHeader(key, value string) *APIError {
	if e.Headers == nil {
		e.Headers = map[string]string{}
	}
	e.Headers[key] = value
	return e
}

// Unauthenticated is HTTP 401 auth_invalid.
func Unauthenticated(message string) *APIError {
	if message == "" {
		message = MsgUnauthenticated
	}
	return &APIError{Status: http.StatusUnauthorized, Code: "auth_invalid", Message: message}
}

// Validation is HTTP 400 validation.
func Validation(message string) *APIError {
	return &APIError{Status: http.StatusBadRequest, Code: "validation", Message: message}
}

// Unprocessable is HTTP 422 validation.
func Unprocessable(message string) *APIError {
	return &APIError{Status: http.StatusUnprocessableEntity, Code: "validation", Message: message}
}

// NotFound is HTTP 404 not_found.
func NotFound(message string) *APIError {
	return &APIError{Status: http.StatusNotFound, Code: "not_found", Message: message}
}

// Conflict is HTTP 409 conflict.
func Conflict(message string) *APIError {
	return &APIError{Status: http.StatusConflict, Code: "conflict", Message: message}
}

// Forbidden is HTTP 403 forbidden.
func Forbidden(message string) *APIError {
	return &APIError{Status: http.StatusForbidden, Code: "forbidden", Message: message}
}

// Internal is HTTP 500 internal. The public message is always 服务暂不可用.
func Internal() *APIError {
	return &APIError{Status: http.StatusInternalServerError, Code: "internal", Message: MsgUnavailable}
}

// WritesDisabled is HTTP 503 writes_disabled.
func WritesDisabled() *APIError {
	return &APIError{Status: http.StatusServiceUnavailable, Code: "writes_disabled", Message: MsgWritesDisabled}
}

// StorageUnavailable is HTTP 503 storage_unavailable.
func StorageUnavailable(message string) *APIError {
	return &APIError{Status: http.StatusServiceUnavailable, Code: "storage_unavailable", Message: message}
}

// Upstream is HTTP 502 upstream_unreachable.
func Upstream(message string) *APIError {
	return &APIError{Status: http.StatusBadGateway, Code: "upstream_unreachable", Message: message}
}

// RateLimited is HTTP 429 upstream_unreachable.
func RateLimited() *APIError {
	return &APIError{Status: http.StatusTooManyRequests, Code: "upstream_unreachable", Message: "Ozon 读取频率已达上限，请稍后重试"}
}

// Locked is SQLSTATE 55P03 from the writer gate: 503 plus Retry-After 1.
func Locked() *APIError {
	return (&APIError{Status: http.StatusServiceUnavailable, Code: "internal", Message: "资源正在更新，请稍后重试"}).WithHeader("Retry-After", "1")
}

// MediaGone is SQLSTATE P0M01. The code stays internal.
func MediaGone() *APIError {
	return &APIError{Status: http.StatusConflict, Code: "internal", Message: "媒体对象已进入回收，请重新上传"}
}
