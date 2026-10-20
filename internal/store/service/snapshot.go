package service

import (
	"context"
	"encoding/json"
	"log/slog"
	"time"

	"github.com/xxww0098/podhub-go/internal/store/domain"
)

// The two snapshot windows. Upload quota moves far more slowly than a page
// revisit; the balance is a closed period-end figure, so neither needs
// per-second freshness. A transport failure is retried sooner than a refusal.
const (
	productQuotaFreshMS = int64(5 * 60 * 1000)
	financeReadyFreshMS = int64(30 * 60 * 1000)
	financeErrorFreshMS = int64(5 * 60 * 1000)
)

// SnapshotDirectory is the repo side of the two refresh loops: the Seller reads
// and the snapshot column they land in.
type SnapshotDirectory interface {
	ProductQuotaRead(ctx context.Context, clientID, apiKey string) (int, []byte, error)
	ArchivedCountRead(ctx context.Context, clientID, apiKey string) (int, []byte, error)
	FinanceBalanceRead(ctx context.Context, clientID, apiKey, from, to string) (int, []byte, error)
	PersistSnapshot(ctx context.Context, orgID, storeID, credentialRevision int64, column string, payload []byte) error
}

// WithSnapshots binds the snapshot reads and their writer.
func (s Service) WithSnapshots(dir SnapshotDirectory) Service {
	s.snapshots = dir
	return s
}

// refreshSnapshot reads one snapshot from Ozon and stores it. Best effort by
// contract: the credential is proven live, but the quota or balance endpoint
// may be unavailable without the key being wrong.
func (s Service) refreshSnapshot(ctx context.Context, orgID int64, uuid string, opened domain.OpenedCredential, nowMS int64, which refreshKind) {
	if s.snapshots == nil {
		return
	}
	column := "product_quota"
	payload, err := json.Marshal(s.readProductQuota(ctx, opened, nowMS))
	if which == refreshFinance {
		column = "finance_balance"
		payload, err = json.Marshal(s.readFinanceBalance(ctx, opened, nowMS))
	}
	if err != nil {
		slog.Warn("store snapshot not encoded", "store", uuid, "err", err.Error())
		return
	}
	if err := s.snapshots.PersistSnapshot(ctx, orgID, opened.StoreID, opened.CredentialRevision, column, payload); err != nil {
		slog.Warn("store snapshot not persisted", "store", uuid, "column", column, "err", err.Error())
	}
}

// readProductQuota reads /v4/product/info/limit plus the archived count. A
// failed archived read still yields the raw quota: it is a best-effort extra,
// and a flaky list endpoint must not throw away a good limit.
func (s Service) readProductQuota(ctx context.Context, opened domain.OpenedCredential, nowMS int64) domain.ProductQuota {
	out := domain.ProductQuota{FetchedAtMS: nowMS}
	status, body, err := s.snapshots.ProductQuotaRead(ctx, opened.ClientID, opened.APIKey)
	if err != nil || status < 200 || status >= 300 {
		return out
	}
	out = domain.ProductQuotaFromOzon(body, nil, nowMS)
	if status, archivedBody, err := s.snapshots.ArchivedCountRead(ctx, opened.ClientID, opened.APIKey); err == nil &&
		status >= 200 && status < 300 {
		if archived, ok := domain.ArchivedTotal(archivedBody); ok {
			out = domain.ProductQuotaFromOzon(body, &archived, nowMS)
		}
	}
	return out
}

// readFinanceBalance reads POST /v1/finance/balance for the closed Moscow day.
func (s Service) readFinanceBalance(ctx context.Context, opened domain.OpenedCredential, nowMS int64) domain.FinanceBalance {
	from, to := reportWindow(time.UnixMilli(nowMS))
	status, body, err := s.snapshots.FinanceBalanceRead(ctx, opened.ClientID, opened.APIKey, from, to)
	if err != nil || status == 0 {
		return domain.FinanceBalance{Outcome: domain.FinanceOutcomeError, PeriodTo: to, FetchedAtMS: nowMS}
	}
	return domain.FinanceBalanceFromOzon(status, body, to, nowMS)
}

// reportWindow is the report span ending on the previous Moscow calendar day.
// Moscow is UTC+3 year-round, and the span is six days — inside the method's
// thirty-day maximum, and never the day still in progress.
func reportWindow(now time.Time) (string, string) {
	moscow := now.UTC().Add(3 * time.Hour)
	today := time.Date(moscow.Year(), moscow.Month(), moscow.Day(), 0, 0, 0, 0, time.UTC)
	end := today.AddDate(0, 0, -1)
	start := end.AddDate(0, 0, -6)
	return start.Format("2006-01-02"), end.Format("2006-01-02")
}
