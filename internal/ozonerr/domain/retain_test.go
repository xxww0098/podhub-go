package domain

import (
	"testing"
	"time"
)

func TestSampleRetentionBoundaryDay(t *testing.T) {
	if SampleRetention != 180*24*time.Hour {
		t.Fatalf("retention %s", SampleRetention)
	}
	now := time.Date(2026, 10, 17, 12, 0, 0, 0, time.UTC)
	cutoff := SampleCutoff(now)
	if !cutoff.Equal(now.Add(-180 * 24 * time.Hour)) {
		t.Fatal(cutoff)
	}
	if SampleExpired(cutoff, now) {
		t.Fatal("the boundary instant is kept")
	}
	if SampleExpired(cutoff.Add(time.Microsecond), now) {
		t.Fatal("newer than the cutoff is kept")
	}
	if !SampleExpired(cutoff.Add(-time.Microsecond), now) {
		t.Fatal("strictly before the cutoff is expired")
	}
	if SampleExpired(now.Add(-179*24*time.Hour), now) {
		t.Fatal("day 179 is kept")
	}
	if !SampleExpired(now.Add(-181*24*time.Hour), now) {
		t.Fatal("day 181 is expired")
	}
}
