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

func TestNextRandomPinsFutureWithinLocalWindow(t *testing.T) {
	loc := time.FixedZone("catalog", 8*3600)
	for _, hour := range []int{0, 2, 3, 5, 23} {
		now := time.Date(2026, 10, 27, hour, 30, 15, 0, loc)
		for _, tomorrow := range []bool{false, true} {
			next, err := NextRandom(120, 240, 480, now, tomorrow)
			minute := next.In(loc).Hour()*60 + next.In(loc).Minute()
			if err != nil || !next.After(now) || minute < 120 || minute >= 240 {
				t.Fatalf("hour=%d next=%v err=%v", hour, next, err)
			}
			if tomorrow && next.In(loc).Day() != 28 {
				t.Fatalf("next daily run reused today: %v", next)
			}
		}
	}
	if _, err := NextRandom(240, 120, 480, time.Now(), false); err == nil {
		t.Fatal("invalid window accepted")
	}
}
