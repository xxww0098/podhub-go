// Package contract is the supplier catalogue manager's wire types, validation
// rules, and HTTP-shaped faults.
//
// The manager surface is deliberately narrower than the staff one in
// internal/admin/x1: a catalog manager maintains row data and the supply cost,
// but never reads the platform's cost columns back and never writes the
// platform price (docs/architecture/account-permission-model.md 8.2/8.3).
package contract

import "errors"

// Level is the architecture level for suppliercatalog.
const Level = 3

// MsgForbidden is the manager gate refusal.
const MsgForbidden = "没有这家货源库的商品维护权限"

// MsgUnavailable is the shared 503 text.
const MsgUnavailable = "服务暂不可用"

// MsgWritesDisabled is the writer-lease refusal for this surface.
const MsgWritesDisabled = "平台货源写入未启用"

// Fault is an HTTP-shaped outcome. The handler maps it once and does not
// invent a second code.
type Fault struct {
	Status  int
	Code    string
	Message string
	Missing []string
}

func (f *Fault) Error() string {
	if f == nil {
		return ""
	}
	return f.Message
}

// Is lets errors.Is compare faults by status and code.
func (f *Fault) Is(target error) bool {
	other, ok := target.(*Fault)
	return ok && other != nil && f != nil && f.Status == other.Status && f.Code == other.Code
}

// AsFault unwraps err to a Fault.
func AsFault(err error) (*Fault, bool) {
	var f *Fault
	if errors.As(err, &f) {
		return f, true
	}
	return nil, false
}

func fail(status int, code, message string) *Fault {
	return &Fault{Status: status, Code: code, Message: message}
}

// Invalid is a body that does not decode.
func Invalid() error { return fail(400, "VALIDATION", "请求格式无效") }

// Validation is a 400 with a specific message.
func Validation(message string) error {
	if message == "" {
		message = "请求无效"
	}
	return fail(400, "VALIDATION", message)
}

// ValidationMissing is a 400 that lists the failed readiness keys.
func ValidationMissing(message string, missing []string) error {
	f := fail(400, "VALIDATION", message)
	f.Missing = missing
	return f
}

// Forbidden is the manager gate refusal.
func Forbidden() error { return fail(403, "FORBIDDEN", MsgForbidden) }

// NotFound is a missing source, row, or prop definition.
func NotFound() error { return fail(404, "NOT_FOUND", "资源不存在") }

// Conflict is an optimistic-concurrency or uniqueness refusal.
func Conflict(message string) error { return fail(409, "CONFLICT", message) }

// MediaRetired is p0m01: the object is in the recycle path.
func MediaRetired() error {
	return fail(409, "CONFLICT", "媒体对象已进入回收，请重新上传")
}

// Unavailable is 55p03: the row is locked by another writer.
func Unavailable() error { return fail(503, "INTERNAL", "资源正在更新，请稍后重试") }

// Internal is the generic 500.
func Internal() error { return fail(500, "INTERNAL", MsgUnavailable) }

// WritesDisabled is the writer-lease refusal.
func WritesDisabled() error { return fail(503, "WRITES_DISABLED", MsgWritesDisabled) }
