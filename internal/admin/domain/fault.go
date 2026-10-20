package domain

import corecontract "github.com/xxww0098/podhub-go/internal/admin/core/contract"

// Fault is a handler outcome. HTTP maps Kind to a status. Code is the wire code.
type Fault = corecontract.Fault

func Validation(code, message string) *Fault { return corecontract.Validation(code, message) }
func Forbidden(code, message string) *Fault  { return corecontract.Forbidden(code, message) }
func Conflict(code, message string) *Fault   { return corecontract.Conflict(code, message) }
func NotFound(code, message string) *Fault   { return corecontract.NotFound(code, message) }
func Internal(code, message string) *Fault   { return corecontract.Internal(code, message) }
func WritesDisabled(code, message string) *Fault {
	return corecontract.WritesDisabled(code, message)
}
func Unavailable(code, message string) *Fault { return corecontract.Unavailable(code, message) }

// Fulfillment is an internal settle failure. The HTTP body is the fixed 503
// sentence; Message is the audit reason and is not returned to the client.
func Fulfillment(message string) *Fault    { return corecontract.Fulfillment(message) }
func Upstream(code, message string) *Fault { return corecontract.Upstream(code, message) }
func Locked(code, message string) *Fault   { return corecontract.Locked(code, message) }
