package slicepurge

import (
	"testing"
	"time"
)

func TestBoundaryIsFixedFourAMShanghai(t *testing.T) {
	// 2026-10-15T20:00Z is 2026-10-16 04:00 Asia/Shanghai.
	at := time.Date(2026, 10, 15, 19, 59, 59, 999_000_000, time.UTC)
	slot := BoundaryAt(at)
	if slot.Day.In(shanghai).Format("2006-01-02") != "2026-10-15" {
		t.Fatalf("day before the boundary: %s", slot.Day)
	}
	if !slot.Start.Equal(time.Date(2026, 10, 14, 20, 0, 0, 0, time.UTC)) {
		t.Fatalf("start %s", slot.Start)
	}
	slot = BoundaryAt(time.Date(2026, 10, 15, 20, 0, 0, 0, time.UTC))
	if slot.Day.In(shanghai).Format("2006-01-02") != "2026-10-16" ||
		!slot.Start.Equal(time.Date(2026, 10, 15, 20, 0, 0, 0, time.UTC)) {
		t.Fatalf("boundary itself: %s %s", slot.Day, slot.Start)
	}
	// No closing window: any instant after 04:00 belongs to the new day, and
	// a run completed before it is due again.
	boundary := time.Date(2026, 10, 15, 20, 0, 0, 0, time.UTC)
	if Due(boundary, boundary) {
		t.Fatal("a boundary is not after itself")
	}
	if Due(boundary.Add(time.Second), boundary) {
		t.Fatal("a run completed at the boundary is not due again that day")
	}
	if !Due(boundary.Add(time.Second), boundary.Add(-time.Second)) {
		t.Fatal("a run completed before the boundary is due again")
	}
	if Due(boundary.Add(-time.Second), boundary) {
		t.Fatal("before the boundary is not due")
	}
	if last := BoundaryAt(boundary.Add(-time.Second)).Start; !last.Equal(time.Date(2026, 10, 14, 20, 0, 0, 0, time.UTC)) {
		t.Fatalf("last boundary %s", last)
	}
	if next := NextBoundary(boundary.Add(time.Second)); !next.Equal(time.Date(2026, 10, 16, 20, 0, 0, 0, time.UTC)) {
		t.Fatalf("next boundary %s", next)
	}
}

func TestNextCheckTopsTheMinute(t *testing.T) {
	early := time.Date(2026, 10, 15, 19, 59, 59, 500_000_000, time.UTC)
	if NextCheck(early) != 500*time.Millisecond {
		t.Fatal(NextCheck(early))
	}
	start := time.Date(2026, 10, 15, 20, 0, 0, 0, time.UTC)
	if NextCheck(start) != time.Minute {
		t.Fatal(NextCheck(start))
	}
}

func TestGenerationChangesAtFourShanghai(t *testing.T) {
	before := time.Date(2026, 10, 15, 19, 59, 59, 999_000_000, time.UTC)
	boundary := time.Date(2026, 10, 15, 20, 0, 0, 0, time.UTC)
	key := func(issued time.Time) string {
		ms := issued.UnixMilli()
		return "root/uploads/" + issued.UTC().Format("2006-01-02") + "/" + itoa(ms) + "-550e8400-e29b-41d4-a716-446655440000/images/teams/550e8400-e29b-41d4-a716-446655440000/sha256/" + repeatA() + ".jpg"
	}
	if KeyCurrent(key(before), boundary) {
		t.Fatal("before the boundary must be stale")
	}
	if !KeyCurrent(key(boundary), boundary) {
		t.Fatal("the boundary itself is current")
	}
	completed := time.Date(2026, 10, 15, 20, 4, 13, 0, time.UTC)
	during := time.Date(2026, 10, 15, 20, 2, 0, 0, time.UTC)
	after := time.Date(2026, 10, 15, 20, 4, 14, 0, time.UTC)
	if KeyCurrent(key(during), completed) || !KeyCurrent(key(after), completed) {
		t.Fatal("completion fence")
	}
	if KeyCurrent("images/teams/old/sha256/old.jpg", completed) {
		t.Fatal("legacy key is not current")
	}
}

func itoa(n int64) string {
	if n == 0 {
		return "0"
	}
	var buf [20]byte
	i := len(buf)
	neg := n < 0
	if neg {
		n = -n
	}
	for n > 0 {
		i--
		buf[i] = byte('0' + n%10)
		n /= 10
	}
	if neg {
		i--
		buf[i] = '-'
	}
	return string(buf[i:])
}

func repeatA() string {
	return "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
}
