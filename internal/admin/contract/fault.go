package contract

import "github.com/xxww0098/podhub-go/internal/admin/core/contract/apifault"

// Fault is one admin, AI, or auth error body. Code is the wire token
// (SCREAMING_SNAKE). Status is the HTTP status. RetryAfter is seconds;
// zero means the header is omitted.
type Fault = apifault.Fault

// AsFault unwraps a Fault.
func AsFault(err error) (*Fault, bool) { return apifault.AsFault(err) }

func Validation(message string) *Fault { return apifault.Validation(message) }

func Forbidden(message string) *Fault { return apifault.Forbidden(message) }

func Conflict(message string) *Fault { return apifault.Conflict(message) }

func NotFound(message string) *Fault { return apifault.NotFound(message) }

func Internal(message string) *Fault { return apifault.Internal(message) }

func Unavailable(code, message string) *Fault { return apifault.Unavailable(code, message) }

// Coded builds a fault whose status and wire code are both explicit.
func Coded(status int, code, message string) *Fault { return apifault.Coded(status, code, message) }
