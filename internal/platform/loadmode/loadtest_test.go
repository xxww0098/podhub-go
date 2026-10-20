package loadmode

import "testing"

func TestOnlyModeR(t *testing.T) {
	if err := Run(ModeR); err != nil {
		t.Fatal(err)
	}
	for _, mode := range []string{"", "r", "W", "live", "production"} {
		if err := Run(mode); err != ErrModeNotAllowed {
			t.Fatalf("mode %q: got %v", mode, err)
		}
	}
}
