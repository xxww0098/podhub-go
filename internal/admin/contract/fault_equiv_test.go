package contract

import (
	"errors"
	"fmt"
	"testing"
)

type legacyFault struct {
	Status     int
	Code       string
	Message    string
	RetryAfter int
}

func TestFaultConstructorsMatchLegacy(t *testing.T) {
	cases := []struct {
		got  *Fault
		want legacyFault
	}{
		{Validation("v"), legacyFault{Status: 400, Code: "VALIDATION", Message: "v"}},
		{Forbidden("f"), legacyFault{Status: 403, Code: "FORBIDDEN", Message: "f"}},
		{Conflict("c"), legacyFault{Status: 409, Code: "CONFLICT", Message: "c"}},
		{NotFound("n"), legacyFault{Status: 404, Code: "NOT_FOUND", Message: "n"}},
		{Internal("i"), legacyFault{Status: 500, Code: "INTERNAL", Message: "i"}},
		{Unavailable("WRITES_DISABLED", "u"), legacyFault{Status: 503, Code: "WRITES_DISABLED", Message: "u"}},
		{Coded(422, "X", "k"), legacyFault{Status: 422, Code: "X", Message: "k"}},
	}
	for _, c := range cases {
		if (legacyFault{c.got.Status, c.got.Code, c.got.Message, c.got.RetryAfter}) != c.want || c.got.Error() != c.want.Message {
			t.Fatalf("got %+v want %+v", *c.got, c.want)
		}
	}
	var nilFault *Fault
	if nilFault.Error() != "" {
		t.Fatal("nil fault")
	}
	own := Validation("x")
	for _, err := range []error{own, fmt.Errorf("w: %w", own)} {
		if f, ok := AsFault(err); !ok || f != own {
			t.Fatalf("AsFault(%v) = %v %v", err, f, ok)
		}
	}
	if f, ok := AsFault(errors.New("plain")); ok || f != nil {
		t.Fatal("AsFault plain")
	}
}
