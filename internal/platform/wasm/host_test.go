package wasm

import (
	"bytes"
	"context"
	"fmt"
	"strings"
	"testing"
)

// Hand-encoded test-only module, independent of the Rust toolchain:
// (module
//
//	(import "env" "fill_random" (func $random (param i32 i32)))
//	(memory (export "memory") 1)
//	(func (export "fill") (param i32 i32) local.get 0 local.get 1 call $random)
//	(func (export "echo") (param i32) (result i32) local.get 0)
//	(func (export "boom") unreachable))
var hostTestModule = []byte{
	0, 97, 115, 109, 1, 0, 0, 0,
	1, 14, 3, 96, 2, 127, 127, 0, 96, 1, 127, 1, 127, 96, 0, 0,
	2, 19, 1, 3, 'e', 'n', 'v', 11, 'f', 'i', 'l', 'l', '_', 'r', 'a', 'n', 'd', 'o', 'm', 0, 0,
	3, 4, 3, 0, 1, 2,
	5, 3, 1, 0, 1,
	7, 31, 4, 6, 'm', 'e', 'm', 'o', 'r', 'y', 2, 0,
	4, 'f', 'i', 'l', 'l', 0, 1, 4, 'e', 'c', 'h', 'o', 0, 2, 4, 'b', 'o', 'o', 'm', 0, 3,
	10, 19, 3, 8, 0, 32, 0, 32, 1, 16, 0, 11, 4, 0, 32, 0, 11, 3, 0, 0, 11,
}

func hostTestGuest(t testing.TB) (*Compiled, *Guest) {
	t.Helper()
	ctx := context.Background()
	compiled, err := Compile(ctx, hostTestModule)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = compiled.Close(ctx) })
	guest, err := compiled.Instantiate(ctx, "host-test")
	if err != nil {
		t.Fatal(err)
	}
	return compiled, guest
}

func TestGuestRepeatedCallsPreserveResults(t *testing.T) {
	_, guest := hostTestGuest(t)
	ctx := context.Background()
	first, err := guest.Call(ctx, "echo", 7)
	if err != nil {
		t.Fatal(err)
	}
	for i := uint64(0); i < 100; i++ {
		got, err := guest.Call(ctx, "echo", i)
		if err != nil || len(got) != 1 || got[0] != i {
			t.Fatalf("echo(%d) = %v, %v", i, got, err)
		}
	}
	if len(first) != 1 || first[0] != 7 {
		t.Fatalf("later calls overwrote an earlier result: %v", first)
	}
	if !guest.Exported("echo") || guest.Exported("missing") {
		t.Fatal("function export lookup changed")
	}
	if _, err := guest.Call(ctx, "missing"); err == nil || !strings.Contains(err.Error(), "missing export") {
		t.Fatalf("missing export: %v", err)
	}
}

func TestGuestTrapAndReplacementAreInstanceLocal(t *testing.T) {
	compiled, first := hostTestGuest(t)
	ctx := context.Background()
	other, err := compiled.Instantiate(ctx, "other")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := first.Call(ctx, "boom"); err == nil {
		t.Fatal("unreachable must trap")
	}
	if err := first.Close(ctx); err != nil {
		t.Fatal(err)
	}
	if _, err := first.Call(ctx, "echo", 1); err == nil {
		t.Fatal("a cached function must not revive a closed guest")
	}
	replacement, err := compiled.Instantiate(ctx, "replacement")
	if err != nil {
		t.Fatal(err)
	}
	for _, guest := range []*Guest{other, replacement} {
		got, err := guest.Call(ctx, "echo", 42)
		if err != nil || len(got) != 1 || got[0] != 42 {
			t.Fatalf("live guest: %v, %v", got, err)
		}
	}
}

func TestGuestFunctionCacheKeepsMemoriesIsolated(t *testing.T) {
	compiled, first := hostTestGuest(t)
	ctx := context.Background()
	other, err := compiled.Instantiate(ctx, "isolated")
	if err != nil {
		t.Fatal(err)
	}
	sentinel := bytes.Repeat([]byte{0xa5}, 256)
	if !first.Write(0, sentinel) || !other.Write(0, sentinel) {
		t.Fatal("write fixture")
	}
	for _, guest := range []*Guest{first, other} {
		if !guest.Exported("fill") {
			t.Fatal("missing fill export")
		}
	}
	if _, err := first.Call(ctx, "fill", 0, uint64(len(sentinel))); err != nil {
		t.Fatal(err)
	}
	got, ok := other.Read(0, uint32(len(sentinel)))
	if !ok || !bytes.Equal(got, sentinel) {
		t.Fatal("calling one guest modified another guest's memory")
	}
}

func TestFillRandomOnlyWritesRequestedGuestRange(t *testing.T) {
	_, guest := hostTestGuest(t)
	const ptr, n = 16, 256
	before := bytes.Repeat([]byte{0xa5}, ptr+n+16)
	if !guest.Write(0, before) {
		t.Fatal("write fixture")
	}
	if _, err := guest.Call(context.Background(), "fill", ptr, n); err != nil {
		t.Fatal(err)
	}
	got, ok := guest.Read(0, uint32(len(before)))
	if !ok || !bytes.Equal(got[:ptr], before[:ptr]) || !bytes.Equal(got[ptr+n:], before[ptr+n:]) {
		t.Fatal("random import modified memory outside the requested range")
	}
	if bytes.Equal(got[ptr:ptr+n], before[ptr:ptr+n]) {
		t.Fatal("random import left the entire range unchanged")
	}
	if _, err := guest.Call(context.Background(), "fill", 0xffffffff, 0); err != nil {
		t.Fatalf("zero length must remain a no-op: %v", err)
	}
}

func TestFillRandomInvalidRangeTraps(t *testing.T) {
	for _, tc := range []struct{ ptr, n uint64 }{{65536, 1}, {65530, 16}, {0xffffffff, 2}} {
		t.Run(fmt.Sprintf("%d+%d", tc.ptr, tc.n), func(t *testing.T) {
			_, guest := hostTestGuest(t)
			if _, err := guest.Call(context.Background(), "fill", tc.ptr, tc.n); err == nil {
				t.Fatal("invalid guest range silently succeeded")
			}
		})
	}
}

func BenchmarkGuestCall(b *testing.B) {
	_, guest := hostTestGuest(b)
	ctx := context.Background()
	_, _ = guest.Call(ctx, "echo", 42)
	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		got, err := guest.Call(ctx, "echo", 42)
		if err != nil || got[0] != 42 {
			b.Fatalf("%v, %v", got, err)
		}
	}
}

func BenchmarkFillRandom(b *testing.B) {
	for _, size := range []uint32{16, 4096} {
		b.Run(fmt.Sprint(size), func(b *testing.B) {
			_, guest := hostTestGuest(b)
			ctx := context.Background()
			b.ReportAllocs()
			b.SetBytes(int64(size))
			b.ResetTimer()
			for i := 0; i < b.N; i++ {
				fillRandom(ctx, guest.mod, 0, size)
			}
		})
	}
}
