package supplierrepo

import (
	"context"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	bill "github.com/xxww0098/podhub-go/internal/billing/contract"
	"github.com/xxww0098/podhub-go/internal/platform/db"
	sign "github.com/xxww0098/podhub-go/internal/platform/r2/sigv4"
	"github.com/xxww0098/podhub-go/internal/platform/writer"
	"github.com/xxww0098/podhub-go/internal/supplier/contract"
)

// BeginApp opens a podhub_app transaction for one org.
// The process passes tenant.BeginApp. This package does not import tenant.
type BeginApp func(ctx context.Context, begin func(context.Context) (pgx.Tx, error), orgID int64) (pgx.Tx, error)

// Repo reads and writes supplier rows inside a podhub_app transaction.
type Repo struct {
	pool         *pgxpool.Pool
	begin        BeginApp
	assets       func(context.Context) (sign.Account, error)
	catalogStore *sign.Account
	profileValid func(string) bool
	holdTx       func(context.Context, pgx.Tx, int64, string, *int64, int64) (bill.WalletRow, error)
	settleTx     func(context.Context, pgx.Tx, int64, string, *int64, int64, int64) (bill.Settlement, error)
}

// New keeps the pool and the tenant opener. A nil pool cannot open a transaction.
func New(pool *pgxpool.Pool, begin BeginApp) Repo {
	return Repo{pool: pool, begin: begin}
}

func (r Repo) WithProfileValidation(validate func(string) bool) Repo {
	r.profileValid = validate
	return r
}

// WithBlobs resolves private storage on each download and captures catalog storage.
func (r Repo) WithBlobs(assets func(context.Context) (sign.Account, error), catalog *sign.Account) Repo {
	r.assets = assets
	r.catalogStore = catalog
	return r
}

// WithMoney injects the billing wallet functions dispatch settlement needs.
// The signatures match the billing repo functions internal/app passes. A nil
// function fails the settlement instead of calling through.
func (r Repo) WithMoney(
	hold func(context.Context, pgx.Tx, int64, string, *int64, int64) (bill.WalletRow, error),
	settle func(context.Context, pgx.Tx, int64, string, *int64, int64, int64) (bill.Settlement, error),
) Repo {
	r.holdTx = hold
	r.settleTx = settle
	return r
}

func (r Repo) withTx(ctx context.Context, orgID, supplierUserID int64, fn func(pgx.Tx) error) error {
	if orgID <= 0 && supplierUserID <= 0 {
		return contract.ErrNoTenant
	}
	if r.pool == nil || r.begin == nil {
		return contract.ErrUnavailable
	}
	session := db.App(orgID)
	switch {
	case orgID > 0 && supplierUserID > 0:
		session = db.SupplierUser(orgID, supplierUserID)
	case orgID <= 0:
		session = db.Supplier(supplierUserID)
	}
	return db.InTx(ctx, r.pool, session, func(tx pgx.Tx) error {
		defer writer.Forget(tx)
		return fn(tx)
	})
}
