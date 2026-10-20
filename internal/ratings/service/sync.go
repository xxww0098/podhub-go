package service

import (
	"context"
	"errors"
	"log/slog"
	"strings"
	"time"

	access "github.com/xxww0098/podhub-go/internal/identity/contract"
	"github.com/xxww0098/podhub-go/internal/ratings/contract"
	"github.com/xxww0098/podhub-go/internal/ratings/domain"
)

// Service reads ratings and runs one sync pass. River calls SyncDue and
// Prune. Neither call decides a listing or billing state.
type Service struct {
	Store     Store
	Source    SellerInfo
	Ranks     map[string]int
	Interval  time.Duration
	Retention time.Duration
	Now       func() time.Time
}

// New binds the store. Ranks nil uses the default UNKNOWN-only map.
func New(store Store) *Service {
	return &Service{Store: store, Ranks: domain.DefaultRanks(), Now: time.Now}
}

func (s *Service) now() time.Time {
	if s == nil || s.Now == nil {
		return time.Now()
	}
	return s.Now()
}

func (s *Service) ranks() map[string]int {
	if s == nil || len(s.Ranks) == 0 {
		return domain.DefaultRanks()
	}
	return s.Ranks
}

// List returns the latest snapshot for a store the caller can see.
func (s *Service) List(ctx context.Context, orgID, userID int64, storeID string) ([]domain.Snapshot, error) {
	if err := s.allow(ctx, orgID, userID, storeID); err != nil {
		return nil, err
	}
	if s.Store == nil {
		return nil, contract.ErrUnavailable
	}
	return s.Store.List(ctx, orgID, storeID)
}

// History returns a page of changes, newest id first.
func (s *Service) History(ctx context.Context, orgID, userID int64, storeID, ratingKey string, cursor int64, limit int) ([]domain.HistoryRow, error) {
	if err := s.allow(ctx, orgID, userID, storeID); err != nil {
		return nil, err
	}
	if s.Store == nil {
		return nil, contract.ErrUnavailable
	}
	return s.Store.History(ctx, orgID, storeID, ratingKey, cursor, limit)
}

func (s *Service) allow(ctx context.Context, orgID, userID int64, storeID string) error {
	if s == nil || s.Store == nil {
		return contract.ErrUnavailable
	}
	g, err := s.Store.Gate(ctx, orgID, userID, storeID)
	if err != nil {
		return err
	}
	if g.MemberID == 0 || strings.TrimSpace(g.Role) == "" {
		return contract.ErrForbidden
	}
	if !access.StoreVisible(g.Role, g.Assignee, g.MemberID) {
		return contract.ErrNotFound
	}
	return nil
}

// SyncDue claims a staggered batch and syncs each store. One store's
// failure is logged and does not stop the others. The returned error is
// only a claim failure. Per-store errors stay in the log.
func (s *Service) SyncDue(ctx context.Context) error {
	if s == nil || s.Store == nil {
		return contract.ErrUnavailable
	}
	now := s.now()
	interval := s.Interval
	if interval <= 0 {
		interval = domain.DefaultSyncInterval
	}
	tick := domain.Tick(interval)
	slots := domain.Slots(interval, tick)
	due, err := s.Store.ClaimDue(ctx, now, interval, slots, domain.TimeBucket(now, tick, slots), 25)
	if err != nil {
		return err
	}
	for _, st := range due {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		if err := s.syncOne(ctx, st, now); err != nil {
			slog.Error("store rating sync", "org", st.OrgID, "store", st.StoreID, "err", safeErr(err))
		}
	}
	return nil
}

func (s *Service) syncOne(ctx context.Context, st domain.Due, now time.Time) error {
	if s.Source == nil {
		_ = s.Store.Finish(ctx, st.OrgID, st.StoreID, now, false)
		return errors.New("seller info source is not wired")
	}
	body, err := s.Source.Post(ctx, st.OrgID, st.StoreID)
	if err != nil {
		_ = s.Store.Finish(ctx, st.OrgID, st.StoreID, now, false)
		return err
	}
	items, dropped, err := domain.Parse(body)
	if err != nil {
		_ = s.Store.Finish(ctx, st.OrgID, st.StoreID, now, false)
		return errors.New("seller info body was not ratings")
	}
	if dropped > 0 {
		slog.Error("store rating field dropped", "org", st.OrgID, "store", st.StoreID, "dropped", dropped)
	}
	if _, err := s.Store.Apply(ctx, st.OrgID, st.StoreID, items, now, s.ranks()); err != nil {
		_ = s.Store.Finish(ctx, st.OrgID, st.StoreID, now, false)
		return err
	}
	return s.Store.Finish(ctx, st.OrgID, st.StoreID, now, true)
}

// Prune deletes history older than the retention window.
func (s *Service) Prune(ctx context.Context) error {
	if s == nil || s.Store == nil {
		return contract.ErrUnavailable
	}
	keep := s.Retention
	if keep <= 0 {
		keep = domain.DefaultRetention
	}
	_, err := s.Store.Prune(ctx, s.now().Add(-keep))
	return err
}

func safeErr(err error) string {
	if err == nil {
		return ""
	}
	msg := err.Error()
	if domain.SecretLike(msg) {
		return "store rating sync failed"
	}
	return msg
}
