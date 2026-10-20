package domain

import corecontract "github.com/xxww0098/podhub-go/internal/admin/core/contract"

// APIError is the admin wire failure. Field names match contract.APIError.
type APIError = corecontract.APIError

// Fail builds an API error. Message is the JSON error field.
func Fail(status int, code, message string) *APIError {
	return corecontract.Fail(status, code, message)
}

// NotPorted is the envelope for a branch this port does not invent.
func NotPorted() *APIError { return corecontract.NotPorted() }

// Marshal encodes v with struct field order, no HTML escape, and no trailing newline.
func Marshal(v any) ([]byte, error) { return corecontract.Marshal(v) }
