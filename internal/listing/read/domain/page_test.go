package domain

import "testing"

func TestPageFetchClampsTheExtraRow(t *testing.T) {
	page, fetch := PageFetch(100)
	if page != 100 || fetch != 100 {
		t.Fatalf("limit 100 must not ask for 101 rows: %d %d", page, fetch)
	}
	page, fetch = PageFetch(1)
	if page != 1 || fetch != 2 {
		t.Fatalf("limit 1: %d %d", page, fetch)
	}
	page, fetch = PageFetch(0)
	if page != 1 || fetch != 2 {
		t.Fatalf("limit 0 clamps to 1: %d %d", page, fetch)
	}
	if n, ok := ParseLimit("abc", true); ok || n != 0 {
		t.Fatal("bad limit")
	}
	if n, ok := ParseLimit("", false); !ok || n != 50 {
		t.Fatalf("default %d", n)
	}
}

func TestParseCursorFallsBack(t *testing.T) {
	if micros, id := ParseCursor(""); micros != 0 || id != "" {
		t.Fatal("empty")
	}
	if micros, id := ParseCursor("nope"); micros != 0 || id != "" {
		t.Fatal("shape")
	}
	if micros, id := ParseCursor("12:not-a-uuid"); micros != 0 || id != "" {
		t.Fatal("id")
	}
	if micros, id := ParseCursor("-1:11111111-1111-4111-8111-111111111111"); micros != 0 || id != "" {
		t.Fatal("negative")
	}
	micros, id := ParseCursor("15:11111111111141118111111111111111")
	if micros != 15 || id != "11111111-1111-4111-8111-111111111111" {
		t.Fatalf("%d %s", micros, id)
	}
	if FormatCursor(15, id) != "15:"+id {
		t.Fatal(FormatCursor(15, id))
	}
}
