package service

import (
	"context"
	"time"

	"github.com/xxww0098/podhub-go/internal/admin/contract"
	"github.com/xxww0098/podhub-go/internal/admin/domain"
)

// DB is the SQL the admin service runs. The repo implements it. The service
// does not import the repo package.
type DB interface {
	ListDirectory(ctx context.Context, actor domain.Actor) (domain.Directory, *contract.Fault)
	ReadAccount(ctx context.Context, publicID string) (domain.Account, *contract.Fault)
	CreateUser(ctx context.Context, actor domain.Actor, publicID, email, name, role, hash string) (domain.Account, int64, *contract.Fault)
	SetStatus(ctx context.Context, actor domain.Actor, publicID string, enabled bool, path string) (domain.Account, *contract.Fault)
	SetRole(ctx context.Context, actor domain.Actor, publicID, role, path string) (domain.Account, *contract.Fault)
	SetPassword(ctx context.Context, actor domain.Actor, publicID, hash, path string, self bool) (int64, *contract.Fault)
	SetSeats(ctx context.Context, actor domain.Actor, publicID, path string, seats *int64) (domain.Account, *contract.Fault)
	Dissolve(ctx context.Context, actor domain.Actor, uuid, name, path string) *contract.Fault
	ListGrants(ctx context.Context, actor domain.Actor, orgFilter *int64) ([]domain.Grant, *contract.Fault)
	IssueGrant(ctx context.Context, actor domain.Actor, req domain.GrantRequest, expires time.Time) (domain.Grant, *contract.Fault)
	RevokeGrant(ctx context.Context, actor domain.Actor, id int64, path string) (bool, *contract.Fault)
	LeaseStatus(ctx context.Context, actor domain.Actor) ([]domain.LeaseRow, []bool, *contract.Fault)
	GrantLease(ctx context.Context, actor domain.Actor, name, holder, instance, reason string, expected *int64) (domain.LeaseRow, *contract.Fault)
	RevokeLease(ctx context.Context, actor domain.Actor, name, reason string, expected *int64) (*domain.LeaseRow, *contract.Fault)
	ListUsage(ctx context.Context, userID int64, f domain.UsageFilter, limit, offset int64) (int64, []domain.UsageRow, *contract.Fault)
	SummarizeUsage(ctx context.Context, userID int64, f domain.UsageFilter) (domain.UsageSummary, *contract.Fault)
	PublishPrice(ctx context.Context, actor domain.Actor, model string, price domain.Price) ([]domain.PriceRow, *contract.Fault)
	UnpublishPrice(ctx context.Context, actor domain.Actor, model string) (bool, []domain.PriceRow, *contract.Fault)
	LoadConfig(ctx context.Context) (domain.ConfigBlob, *contract.Fault)
	SaveConfig(ctx context.Context, actor domain.Actor, expected, next int64, nonce, cipher []byte, aiCount int) *contract.Fault
	RewriteSnapshot(ctx context.Context, revision int64, nonce, cipher []byte) *contract.Fault
	CurrentPrices(ctx context.Context) ([]domain.PriceRow, *contract.Fault)
}
