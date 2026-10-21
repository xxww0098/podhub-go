package supplierrepo

import (
	"context"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

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
	assets       *sign.Account
	catalogStore *sign.Account
}

// New keeps the pool and the tenant opener. A nil pool cannot open a transaction.
func New(pool *pgxpool.Pool, begin BeginApp) Repo {
	return Repo{pool: pool, begin: begin}
}

// WithBlobs keeps loopback object accounts. A nil account is "not configured".
func (r Repo) WithBlobs(assets, catalog *sign.Account) Repo {
	r.assets = assets
	r.catalogStore = catalog
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
