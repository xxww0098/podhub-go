package domain

import (
	"hash/fnv"
	"math"
	"math/big"
	"strconv"
	"testing"
)

func TestLaneAdmissionRejectsInvalidAndOverflowedCosts(t *testing.T) {
	for _, kind := range []string{"ai.recognize", "media.upload", "listing.submit.batch", "other"} {
		if LaneAdmitsLimit(math.MaxInt64, kind, 256) {
			t.Errorf("overflow admitted %s", kind)
		}
		if LaneAdmitsLimit(-1, kind, 256) {
			t.Errorf("negative cost admitted %s", kind)
		}
		cost := int64(CostUnits(kind))
		if !LaneAdmitsLimit(256-cost, kind, 256) || LaneAdmitsLimit(257-cost, kind, 256) {
			t.Errorf("boundary %s", kind)
		}
	}
}

func TestNegativeAttemptUsesFirstBackoff(t *testing.T) {
	for _, kind := range []string{"listing.submit", "listing.reconcile", "other"} {
		got := RequeueDelay(kind, math.MinInt32, ReasonSafeToRetry, 0, 7)
		want := RequeueDelay(kind, 0, ReasonSafeToRetry, 0, 7)
		if got != want {
			t.Errorf("%s got=%v want=%v", kind, got, want)
		}
	}
}

func TestJitterSeedIncludesFullSignedInteger(t *testing.T) {
	for _, epoch := range []int64{math.MinInt64, -1, 0, 1, math.MaxInt64} {
		h := fnv.New64a()
		h.Write([]byte("job" + strconv.FormatInt(epoch, 10) + "-2147483648"))
		if got := JitterSeed("job", epoch, math.MinInt32); got != h.Sum64() {
			t.Errorf("epoch=%d got=%d want=%d", epoch, got, h.Sum64())
		}
	}
}

func FuzzLaneAdmissionBoundaries(f *testing.F) {
	f.Add(int64(math.MaxInt64), int64(256), uint8(0))
	f.Add(int64(-1), int64(256), uint8(1))
	f.Add(int64(248), int64(256), uint8(2))
	f.Fuzz(func(t *testing.T, queued, limit int64, index uint8) {
		kinds := []string{"ai.recognize", "media.upload", "listing.submit.batch", "other"}
		kind := kinds[int(index)%len(kinds)]
		effective := limit
		if effective <= 0 {
			effective = AccountLaneQueuedCostLimit
		}
		total := new(big.Int).Add(big.NewInt(queued), big.NewInt(int64(CostUnits(kind))))
		want := queued >= 0 && total.Cmp(big.NewInt(effective)) <= 0
		if got := LaneAdmitsLimit(queued, kind, limit); got != want {
			t.Fatalf("queued=%d limit=%d kind=%s got=%v want=%v", queued, limit, kind, got, want)
		}
	})
}
