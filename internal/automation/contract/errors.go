// Package contract is the automation surface. The domain level is L4.
package contract

import "errors"

// ErrNotPorted remains for routes this process has not implemented.
// The thirteen /api/automation routes no longer return it.
var ErrNotPorted = errors.New("not_ported")

// ErrIllegalStatus is a browser_commands.status outside the CHECK list.
var ErrIllegalStatus = errors.New("illegal browser command status")

// ErrIllegalEdge is not one of the named command edges.
var ErrIllegalEdge = errors.New("illegal browser command edge")

// ErrNotApplied means the named edge's SQL WHERE did not match.
// The row is left unchanged.
var ErrNotApplied = errors.New("browser command edge did not apply")

// ErrMissing means the SELECT/UPDATE/DELETE matched no row.
var ErrMissing = errors.New("automation row missing")

// ErrAuthority means the locked user or live workspace role no longer matches.
var ErrAuthority = errors.New("automation authority changed")

// ErrIllegalAction is an automation_grants action outside the CHECK list.
var ErrIllegalAction = errors.New("illegal automation grant action")

// ErrIllegalScope is an automation_grants.scope_kind outside the CHECK list.
var ErrIllegalScope = errors.New("illegal automation grant scope")

// Wire messages copied from the automation handlers and from_db_err.
const (
	MsgBadJSON          = "请求格式无效"
	MsgBadName          = "名称不能为空且不超过 120 字符"
	MsgTooManyItems     = "素材集合最多 500 项"
	MsgBadItem          = "素材项需要文件名与 64 位十六进制 SHA-256"
	MsgRuntimeMissing   = "执行端不存在"
	MsgBadClaim         = "claim 格式无效"
	MsgOperationMissing = "操作不存在"
	MsgBadStatus        = "status 须为 completed|failed|canceled"
	MsgGrantMissing     = "授权不存在"
	MsgGrantInactive    = "授权不存在或已失效"
	MsgUnknownAction    = "未知的授权动作 "
	MsgCannotDelegate   = "当前角色无权委托 "
	MsgNoAction         = "至少选择一个授权动作"
	MsgBadExpiry        = "有效期须在 1 到 3650 天之间"
	MsgAuthority        = "当前授权已变化，请刷新后重试"
	MsgBadRenderer      = "渲染契约版本无效"
	MsgRuntimeGone      = "执行端不存在或已注销"
	MsgUnavailable      = "服务暂不可用"
	MsgBusy             = "资源正在更新，请稍后重试"
	MsgConflict         = "媒体对象已进入回收，请重新上传"
)

// Fault is a finished automation error. Kind selects the HTTP status in the
// http package; Message is the Rust string.
type Fault struct {
	Kind    string
	Message string
	Retry   int
}

func (f *Fault) Error() string {
	if f == nil {
		return ""
	}
	return f.Message
}

// Validation is HTTP 400 VALIDATION.
func Validation(message string) *Fault {
	return &Fault{Kind: "validation", Message: message}
}

// NotFound is HTTP 404 NOT_FOUND.
func NotFound(message string) *Fault {
	return &Fault{Kind: "not_found", Message: message}
}

// Forbidden is HTTP 403 FORBIDDEN.
func Forbidden(message string) *Fault {
	return &Fault{Kind: "forbidden", Message: message}
}

// Unavailable is HTTP 500 INTERNAL.
func Unavailable() *Fault {
	return &Fault{Kind: "unavailable", Message: MsgUnavailable}
}

// Busy is SQLSTATE 55P03: HTTP 503 INTERNAL, Retry-After 1.
func Busy() *Fault {
	return &Fault{Kind: "busy", Message: MsgBusy, Retry: 1}
}

// Conflict is SQLSTATE P0M01: HTTP 409 INTERNAL.
func Conflict() *Fault {
	return &Fault{Kind: "conflict", Message: MsgConflict}
}
