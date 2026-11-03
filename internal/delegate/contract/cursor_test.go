package contract

import (
	"strings"
	"testing"
)

func TestNormalizeUUID(t *testing.T) {
	id := "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"
	got, ok := NormalizeUUID("  " + strings.ToUpper(id) + "  ")
	if !ok || got != id {
		t.Fatalf("%q %v", got, ok)
	}
	for _, bad := range []string{"", "not-a-uuid", id[:35], strings.Replace(id, "-", "", 1)} {
		if _, ok := NormalizeUUID(bad); ok {
			t.Fatalf("%q accepted", bad)
		}
	}
}

func TestCursorRoundTrip(t *testing.T) {
	id := "11111111-1111-4111-8111-111111111111"
	raw := EncodeCursor(9, id)
	ms, got, ok := DecodeCursor(raw)
	if !ok || ms != 9 || got != id {
		t.Fatalf("%d %s %v", ms, got, ok)
	}
	if _, _, ok := DecodeCursor("nope"); ok {
		t.Fatal("bad cursor")
	}
}
