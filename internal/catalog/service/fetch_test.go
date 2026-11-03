package service

import (
	"context"
	"errors"
	"strings"
	"testing"
)

func TestFetchOutcome(t *testing.T) {
	cases := []struct {
		name    string
		workErr error
		status  string
		message string
	}{
		{
			name:   "clean run",
			status: "ok",
		},
		{
			name:    "shutdown",
			workErr: context.Canceled,
			status:  "failed",
			message: "cancelled",
		},
		{
			name:    "deadline",
			workErr: context.DeadlineExceeded,
			status:  "failed",
			message: "fetch_timeout",
		},
		{
			name:    "missing key",
			workErr: ErrNoFetchKey,
			status:  "failed",
			message: "no_available_key",
		},
		{
			name:    "lost lease",
			workErr: ErrFetchLeaseLost,
			status:  "failed",
			message: "lease_lost",
		},
		{
			name:    "panic",
			workErr: errFetchPanicked,
			status:  "failed",
			message: "fetch_panicked",
		},
		{
			name:    "real upstream error is preserved",
			workErr: errors.New("catalog tree upstream refused: upstream status 401"),
			status:  "failed",
			message: "catalog tree upstream refused: upstream status 401",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			status, message := fetchOutcome(tc.workErr)
			if status != tc.status || message != tc.message {
				t.Fatalf("got %q %q, want %q %q", status, message, tc.status, tc.message)
			}
		})
	}
}

func TestFetchOutcomeClampsLongErrors(t *testing.T) {
	_, message := fetchOutcome(errors.New(strings.Repeat("x", maxErrorMessage+50)))
	if len([]rune(message)) != maxErrorMessage {
		t.Fatalf("clamped to %d runes, want %d", len([]rune(message)), maxErrorMessage)
	}
}
