package rules

import (
	"context"
	"errors"
	"testing"
	"time"
)

func TestBannedTagCacheServesTheSameRulesUntilTheTTL(t *testing.T) {
	bannedMu.Lock()
	banned = nil
	bannedNow = func() time.Time { return time.Unix(1_700_000_000, 0) }
	bannedMu.Unlock()
	t.Cleanup(func() {
		bannedMu.Lock()
		banned = nil
		bannedNow = time.Now
		bannedMu.Unlock()
	})

	loads := 0
	load := func(context.Context) ([]Rule, error) {
		loads++
		return []Rule{{Term: "табак", MatchMode: "stem"}}, nil
	}
	first, err := EnabledBannedTags(context.Background(), load)
	if err != nil || len(first) != 1 || first[0].Term != "табак" {
		t.Fatalf("%v %v", first, err)
	}
	bannedNow = func() time.Time { return time.Unix(1_700_000_000, 0).Add(time.Second - time.Millisecond) }
	second, err := EnabledBannedTags(context.Background(), load)
	if err != nil || loads != 1 || second[0].Term != "табак" {
		t.Fatalf("hit loads=%d %v %v", loads, second, err)
	}
	bannedNow = func() time.Time { return time.Unix(1_700_000_000, 0).Add(time.Second) }
	if _, err := EnabledBannedTags(context.Background(), load); err != nil || loads != 2 {
		t.Fatalf("miss loads=%d %v", loads, err)
	}
	InvalidateBannedTags()
	if _, err := EnabledBannedTags(context.Background(), func(context.Context) ([]Rule, error) {
		return nil, errors.New("down")
	}); err == nil {
		t.Fatal("error should not be cached")
	}
}
