package domain

import (
	"testing"
	"time"
)

func TestPeakSeats(t *testing.T) {
	t0 := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	t1 := t0.Add(10 * 24 * time.Hour)
	t2 := t0.Add(20 * 24 * time.Hour)
	peak := PeakSeats([]time.Time{t0, t0.Add(24 * time.Hour)}, []time.Time{t1, t2}, []int64{15, 6})
	if peak != 21 {
		t.Fatal(peak)
	}
}
