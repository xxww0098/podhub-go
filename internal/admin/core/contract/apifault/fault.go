// Package apifault is the admin wire fault shared by admin and its topic units.
package apifault

import "errors"

// Fault is one admin, AI, or auth error body. Code is the wire token
// (SCREAMING_SNAKE). Status is the HTTP status. RetryAfter is seconds;
// zero means the header is omitted.
type Fault struct {
	Status     int
	Code       string
	Message    string
	RetryAfter int
}

func (f *Fault) Error() string {
	if f == nil {
		return ""
	}
	return f.Message
}

// AsFault unwraps a Fault.
func AsFault(err error) (*Fault, bool) {
	var f *Fault
	if errors.As(err, &f) {
		return f, true
	}
	return nil, false
}

func Validation(message string) *Fault {
	return &Fault{Status: 400, Code: "VALIDATION", Message: message}
}

func Forbidden(message string) *Fault {
	return &Fault{Status: 403, Code: "FORBIDDEN", Message: message}
}

func Conflict(message string) *Fault {
	return &Fault{Status: 409, Code: "CONFLICT", Message: message}
}

func NotFound(message string) *Fault {
	return &Fault{Status: 404, Code: "NOT_FOUND", Message: message}
}

func Internal(message string) *Fault {
	return &Fault{Status: 500, Code: "INTERNAL", Message: message}
}

func Unavailable(code, message string) *Fault {
	return &Fault{Status: 503, Code: code, Message: message}
}

// Coded builds a fault whose status and wire code are both explicit.
func Coded(status int, code, message string) *Fault {
	return &Fault{Status: status, Code: code, Message: message}
}
