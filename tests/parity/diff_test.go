package parity

import (
	"bytes"
	"testing"
)

func TestDiffHTTPMasksTimestampOnly(t *testing.T) {
	want := Exchange{Status: 503, Body: []byte(`{"ok":false,"db":"unavailable","ts":0,"writer_leases":[]}`)}
	got := Exchange{Status: 503, Body: []byte(`{"ok":false,"db":"unavailable","ts":1710000000000,"writer_leases":[]}`)}
	if err := DiffHTTP(got, want); err != nil {
		t.Fatal(err)
	}
	got.Body = append(got.Body, '\n')
	if err := DiffHTTP(got, want); err == nil {
		t.Fatal("trailing newline must remain a difference")
	}
	got = Exchange{Status: 200, Body: want.Body}
	if err := DiffHTTP(got, want); err == nil {
		t.Fatal("status mismatch must fail")
	}
}

func TestDiffCounts(t *testing.T) {
	before := map[string]int64{"banned_tags": 6, "plans": 5}
	after := map[string]int64{"banned_tags": 6, "plans": 5}
	if err := DiffCounts(before, after); err != nil {
		t.Fatal(err)
	}
	after["plans"] = 4
	if err := DiffCounts(before, after); err == nil {
		t.Fatal("changed count must fail")
	}
}

func TestCanonicalRowsSortsKeys(t *testing.T) {
	a, err := CanonicalRows([]byte(`[{"b":1,"a":2}]`))
	if err != nil {
		t.Fatal(err)
	}
	b, err := CanonicalRows([]byte(`[{"a":2,"b":1}]`))
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(a, b) {
		t.Fatalf("%s vs %s", a, b)
	}
}
