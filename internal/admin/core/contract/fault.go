// Package contract holds the admin types shared by admin and its topic units:
// the handler Fault and the admin Actor. admin/domain aliases both, so every
// admin unit returns and matches the same types.
package contract

// Fault is a handler outcome. HTTP maps Kind to a status. Code is the wire code.
type Fault struct {
	Kind    string
	Code    string
	Message string
}

func (f *Fault) Error() string {
	if f == nil {
		return ""
	}
	return f.Message
}

func fault(kind, code, message string) *Fault {
	return &Fault{Kind: kind, Code: code, Message: message}
}

func Validation(code, message string) *Fault { return fault("validation", code, message) }
func Forbidden(code, message string) *Fault  { return fault("forbidden", code, message) }
func Conflict(code, message string) *Fault   { return fault("conflict", code, message) }
func NotFound(code, message string) *Fault   { return fault("not_found", code, message) }
func Internal(code, message string) *Fault   { return fault("internal", code, message) }
func WritesDisabled(code, message string) *Fault {
	return fault("writes_disabled", code, message)
}
func Unavailable(code, message string) *Fault { return fault("unavailable", code, message) }

// Fulfillment is an internal settle failure. The HTTP body is the fixed 503
// sentence; Message is the audit reason and is not returned to the client.
func Fulfillment(message string) *Fault    { return fault("fulfillment", "INTERNAL", message) }
func Upstream(code, message string) *Fault { return fault("upstream", code, message) }
func Locked(code, message string) *Fault {
	return fault("locked", code, "资源正在更新，请稍后重试")
}
