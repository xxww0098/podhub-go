package service

import (
	"context"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/xxww0098/podhub-go/internal/billing/contract"
)

// Subscription is the repo surface the HTTP layer calls. internal/billing
// assigns these in init; service does not import repo.
var (
	SubscriptionView        func(ctx context.Context, pool *pgxpool.Pool, orgID int64, now time.Time) (contract.View, error)
	Quote                   func(ctx context.Context, pool *pgxpool.Pool, orgID int64, req contract.QuoteRequest, now time.Time) (contract.Offered, error)
	CreateSubscriptionOrder func(
		ctx context.Context, pool *pgxpool.Pool, orgID, userID int64,
		publicID, provider, currency, quoteID string,
		agreement []byte, now time.Time) (contract.OrderBrief, error)
	CreateTopupOrder func(
		ctx context.Context, pool *pgxpool.Pool, orgID, userID int64,
		publicID, provider string, amountMicrofen int64, now time.Time) (contract.OrderBrief, error)
	LoadOrder           func(ctx context.Context, tx pgx.Tx, publicID string) (contract.Order, error)
	MarkOrderPaid       func(ctx context.Context, tx pgx.Tx, orderID int64, providerRef string, now time.Time) (bool, error)
	MarkOrderReconciled func(ctx context.Context, tx pgx.Tx, orderID int64, reason string) error
	FulfillSubscription func(ctx context.Context, tx pgx.Tx, order contract.Order, now time.Time) error
)

// ErrNoSubscription means the workspace has no subscription row. The HTTP
// layer renders it as 409 SUBSCRIPTION_MISSING. internal/billing sets it to
// the repo sentinel so errors.Is keeps working across the seam.
var ErrNoSubscription error

// PaymentWindow is how long an unpaid order blocks a new one. The HTTP layer
// shows the deadline; the repo sets the same value on the row.
const PaymentWindow = 15 * time.Minute
