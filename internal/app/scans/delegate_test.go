package scans

import (
	"testing"
	"time"
)

func TestDelegateBucket(t *testing.T) {
	at := time.UnixMilli(120_000)
	if got := DelegateBucket(at, time.Minute); got != 2 {
		t.Fatalf("bucket %d", got)
	}
	if got := DelegateBucket(at, 0); got != at.UnixMilli()/time.Minute.Milliseconds() {
		t.Fatalf("default interval bucket %d", got)
	}
	if DelegateBucket(at, time.Minute) != DelegateBucket(at.Add(30*time.Second), time.Minute) {
		t.Fatal("the same minute must share a bucket")
	}
}
