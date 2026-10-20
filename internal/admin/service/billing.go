package service

import (
	"context"

	"github.com/xxww0098/podhub-go/internal/admin/domain"
)

// BillingAPI is the admin billing and observation port.
// HTTP depends on it. The repo implements it. This package does not import repo.
type BillingAPI interface {
	Standing(ctx context.Context, userID int64, tokenHash string) (domain.Standing, error)
	PublicID(ctx context.Context, userID int64) (string, error)
	ListPlans(ctx context.Context, actor domain.Actor) ([]byte, error)
	ListOrders(ctx context.Context, actor domain.Actor) ([]byte, error)
	GetOrder(ctx context.Context, actor domain.Actor, publicID string) ([]byte, error)
	ConfirmOrder(ctx context.Context, actor domain.Actor, publicID string) ([]byte, error)
	CancelOrder(ctx context.Context, actor domain.Actor, publicID string) ([]byte, error)
	ListRedeem(ctx context.Context, actor domain.Actor) ([]byte, error)
	CreateRedeem(ctx context.Context, actor domain.Actor, spec domain.RedeemSpec) ([]byte, error)
	GetRedeem(ctx context.Context, actor domain.Actor, id int64) ([]byte, error)
	DeleteRedeem(ctx context.Context, actor domain.Actor, id int64) ([]byte, error)
	RevokeRedeem(ctx context.Context, actor domain.Actor, id int64) ([]byte, error)
	GetPayment(ctx context.Context, actor domain.Actor) ([]byte, error)
	PutPayment(ctx context.Context, actor domain.Actor, body domain.PaymentReplace) ([]byte, error)
	Wallet(ctx context.Context, actor domain.Actor, workspace string) ([]byte, error)
	GrantTopup(ctx context.Context, actor domain.Actor, grant domain.TopupGrant) ([]byte, error)
	RevokeTopup(ctx context.Context, actor domain.Actor, workspace, topupID string) ([]byte, error)
	Scopes(ctx context.Context, actor domain.Actor, scope domain.Scope) ([]byte, error)
	Snapshot(ctx context.Context, actor domain.Actor, scope domain.Scope) ([]byte, error)
	Overview(ctx context.Context, actor domain.Actor, scope domain.Scope) ([]byte, error)
	Products(ctx context.Context, actor domain.Actor, query domain.ProductQuery) ([]byte, error)
	Thumbnail(ctx context.Context, actor domain.Actor, thumb domain.Thumbnail) (domain.ImageBytes, error)
	ListErrors(ctx context.Context, actor domain.Actor, filter domain.ErrorFilter) ([]byte, error)
	DeleteErrors(ctx context.Context, actor domain.Actor, body domain.ErrorDelete) ([]byte, error)
	ListDigest(ctx context.Context, actor domain.Actor) ([]byte, error)
}
