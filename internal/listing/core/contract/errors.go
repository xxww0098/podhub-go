package contract

import (
	"encoding/json"
	"errors"
)

// Core error codes are listing-core-wasm error.rs. Every failing export writes
// {"code","message"} to the last_error slot, and these three are the only codes
// it emits: CodeDecode (the call body did not decode into the op's input shape),
// CodeSchemaHandle (the handle names no resident schema), CodeRefused (the op
// said no — a listing_core::ops business rule).
const (
	CodeDecode       = "CORE_DECODE"
	CodeSchemaHandle = "CORE_SCHEMA_HANDLE"
	CodeRefused      = "CORE_REFUSED"
)

// CoreError is one listing-core failure with the code the core chose. Error
// returns the core's own message, so a caller that only prints the error reads
// the same sentence the wasm wrote; a caller that has to pick a response reads
// Code. It is a pointer type because errors.As fills a pointer.
//
// ReasonCode and RetryClass are set only for an OCR contract refusal, where the
// core adds them to the same slot (error.rs to_json_bytes). Nothing in this
// server calls that op yet, so they travel for the log and for whoever wires it.
type CoreError struct {
	Code       string
	Message    string
	ReasonCode string
	RetryClass string
}

func (e *CoreError) Error() string { return e.Message }

// NewCoreError builds one failure with a known code.
func NewCoreError(code, message string) *CoreError {
	return &CoreError{Code: code, Message: message}
}

// AsCoreError is errors.As narrowed to *CoreError.
func AsCoreError(err error) (*CoreError, bool) {
	var coreErr *CoreError
	if errors.As(err, &coreErr) && coreErr != nil {
		return coreErr, true
	}
	return nil, false
}

// SlotError turns the bytes one export wrote to last_error_ptr/last_error_len
// into a CoreError. The slot always holds the contract's {"code","message"};
// bytes that are not that (an empty slot, a code from a newer wasm) become
// CodeDecode with prefix and the raw text kept, so every caller still gets a
// code to map and a message to log.
func SlotError(prefix string, raw []byte) *CoreError {
	var wire struct {
		Code       string `json:"code"`
		Message    string `json:"message"`
		ReasonCode string `json:"reason_code"`
		RetryClass string `json:"retry_class"`
	}
	if json.Unmarshal(raw, &wire) == nil && wire.Code != "" && wire.Message != "" {
		return &CoreError{Code: wire.Code, Message: wire.Message, ReasonCode: wire.ReasonCode, RetryClass: wire.RetryClass}
	}
	return NewCoreError(CodeDecode, prefix+": "+string(raw))
}
