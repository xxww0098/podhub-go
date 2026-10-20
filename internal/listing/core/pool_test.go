package core

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"runtime"
	"sort"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func TestConcurrentPoolMatchesFreezeOracle(t *testing.T) {
	mod, err := openSized(context.Background(), embedded, 2)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = mod.Close(context.Background()) })
	cse := firstFreezeCase(t)
	var wg sync.WaitGroup
	errc := make(chan error, 8)
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			got, err := mod.Call(context.Background(), cse.Op, []byte(cse.Schema), []byte(cse.Body))
			if err != nil {
				errc <- err
				return
			}
			if string(got) != cse.Result {
				errc <- fmt.Errorf("bytes differ")
			}
		}()
	}
	wg.Wait()
	close(errc)
	for err := range errc {
		t.Error(err)
	}
}

func TestTrapDropsOnlyThatGuest(t *testing.T) {
	mod, err := openSized(context.Background(), embedded, 2)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = mod.Close(context.Background()) })
	ctx := context.Background()
	a, err := mod.pool.Borrow(ctx)
	if err != nil {
		t.Fatal(err)
	}
	b, err := mod.pool.Borrow(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := mod.instance(ctx, a); err != nil {
		t.Fatal(err)
	}
	if _, err := mod.instance(ctx, b); err != nil {
		t.Fatal(err)
	}
	live := b.Guest
	a.Close(ctx)
	if a.Guest != nil {
		t.Fatal("trapped slot kept its guest")
	}
	mod.pool.Return(a)
	cse := firstFreezeCase(t)
	got, err := mod.Call(ctx, cse.Op, []byte(cse.Schema), []byte(cse.Body))
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != cse.Result {
		t.Fatal("result bytes differ after reinstantiating the trapped slot")
	}
	if b.Guest != live {
		t.Fatal("trap dropped the other instance")
	}
	mod.pool.Return(b)
}

func firstFreezeCase(t *testing.T) struct {
	Op     uint32
	Schema string
	Body   string
	Result string
} {
	t.Helper()
	raw, err := os.ReadFile("testdata/freeze_oracle.json")
	if err != nil {
		t.Fatal(err)
	}
	var file struct {
		Cases []struct {
			Op     uint32 `json:"op"`
			Schema string `json:"schema"`
			Body   string `json:"body"`
			Result string `json:"result"`
		} `json:"cases"`
	}
	if err := json.Unmarshal(raw, &file); err != nil {
		t.Fatal(err)
	}
	c := file.Cases[0]
	return struct {
		Op     uint32
		Schema string
		Body   string
		Result string
	}{c.Op, c.Schema, c.Body, c.Result}
}

func BenchmarkListingCorePool(b *testing.B) {
	cse := benchFreezeCase(b)
	call := func(mod *Module) error {
		got, err := mod.Call(context.Background(), cse.Op, []byte(cse.Schema), []byte(cse.Body))
		if err != nil {
			return err
		}
		if string(got) != cse.Result {
			return fmt.Errorf("bytes differ")
		}
		return nil
	}
	for _, size := range []int{2, runtime.GOMAXPROCS(0)} {
		for _, conc := range []int{1, 8} {
			b.Run(fmt.Sprintf("pool%d/conc%d", size, conc), func(b *testing.B) {
				mod, err := openSized(context.Background(), embedded, size)
				if err != nil {
					b.Fatal(err)
				}
				b.Cleanup(func() { _ = mod.Close(context.Background()) })
				reportPool(b, conc, func() error { return call(mod) })
			})
		}
	}
}

type benchCase struct {
	Op     uint32 `json:"op"`
	Schema string `json:"schema"`
	Body   string `json:"body"`
	Result string `json:"result"`
}

func benchFreezeCase(b *testing.B) benchCase {
	b.Helper()
	raw, err := os.ReadFile("testdata/freeze_oracle.json")
	if err != nil {
		b.Fatal(err)
	}
	var file struct {
		Cases []benchCase `json:"cases"`
	}
	if err := json.Unmarshal(raw, &file); err != nil {
		b.Fatal(err)
	}
	return file.Cases[0]
}

func reportPool(b *testing.B, conc int, call func() error) {
	b.Helper()
	total := b.N
	lat := make([]time.Duration, total)
	var idx atomic.Int64
	var wg sync.WaitGroup
	wg.Add(conc)
	b.ResetTimer()
	start := time.Now()
	for c := 0; c < conc; c++ {
		go func() {
			defer wg.Done()
			for {
				n := int(idx.Add(1)) - 1
				if n >= total {
					return
				}
				t0 := time.Now()
				if err := call(); err != nil {
					b.Error(err)
					return
				}
				lat[n] = time.Since(t0)
			}
		}()
	}
	wg.Wait()
	elapsed := time.Since(start)
	b.StopTimer()
	sort.Slice(lat, func(i, j int) bool { return lat[i] < lat[j] })
	p99 := lat[len(lat)*99/100]
	b.ReportMetric(float64(total)/elapsed.Seconds(), "ops/s")
	b.ReportMetric(float64(p99.Microseconds()), "p99-us")
}
