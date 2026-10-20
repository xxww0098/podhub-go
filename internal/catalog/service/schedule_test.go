package service

import (
	"testing"
	"time"
)

func TestNextFixedStaysAfterNow(t *testing.T) {
	loc := time.FixedZone("catalog", 8*60*60)
	now := time.Date(2026, 10, 16, 3, 0, 0, 0, loc)
	next := NextFixed(180, 480, now)
	if !next.After(now) {
		t.Fatalf("next %s is not after %s", next, now)
	}
	if next.In(loc).Hour() != 3 || next.In(loc).Minute() != 0 {
		t.Fatalf("want 03:00 local, got %s", next.In(loc))
	}
	exact := time.Date(2026, 10, 16, 3, 0, 0, 0, loc)
	rolled := NextFixed(180, 480, exact)
	if !rolled.After(exact) || rolled.Sub(exact) != 24*time.Hour {
		t.Fatalf("equal instant must roll a day, got %s", rolled)
	}
}
