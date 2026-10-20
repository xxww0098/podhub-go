package engine

import (
	"sort"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func reportTags(b *testing.B, conc int, call func() error) {
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
