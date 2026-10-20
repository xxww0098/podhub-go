package rules

import (
	"context"
	"sync"
	"time"

	listing "github.com/xxww0098/podhub-go/internal/listing/core/contract"
)

// Rule is the listing-core rule. MatchMode is exact or stem.
type Rule = listing.Rule

// cacheTTL is the process cache lifetime. A write on this process drops the
// cache; other processes observe the row on the next read after the TTL.
const cacheTTL = time.Second

type cacheSlot struct {
	at    time.Time
	rules []Rule
}

var (
	bannedMu sync.Mutex
	banned   *cacheSlot
	// bannedNow is time.Now in production. Tests move it.
	bannedNow = time.Now
)

// InvalidateBannedTags drops the process cache. The read handlers do not
// write rows, so only tests call this.
func InvalidateBannedTags() {
	bannedMu.Lock()
	banned = nil
	bannedMu.Unlock()
}

// EnabledBannedTags returns the cached rules when they are younger than one
// second. load runs only on a miss and its result is what the next hit returns.
func EnabledBannedTags(ctx context.Context, load func(context.Context) ([]Rule, error)) ([]Rule, error) {
	now := bannedNow()
	bannedMu.Lock()
	if banned != nil && now.Sub(banned.at) < cacheTTL {
		out := append([]Rule(nil), banned.rules...)
		bannedMu.Unlock()
		return out, nil
	}
	bannedMu.Unlock()

	rules, err := load(ctx)
	if err != nil {
		return nil, err
	}
	stored := append([]Rule(nil), rules...)
	bannedMu.Lock()
	banned = &cacheSlot{at: bannedNow(), rules: stored}
	bannedMu.Unlock()
	return append([]Rule(nil), stored...), nil
}
