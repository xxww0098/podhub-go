package delegaterepo

import (
	"context"
	"errors"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/xxww0098/podhub-go/internal/delegate/contract"
	"github.com/xxww0098/podhub-go/internal/delegate/gen"
	"github.com/xxww0098/podhub-go/internal/platform/db"
)

// BeginApp opens a podhub_app transaction for one org.
// The process passes tenant.BeginApp. This package does not import tenant.
type BeginApp func(ctx context.Context, begin func(context.Context) (pgx.Tx, error), orgID int64) (pgx.Tx, error)

// Repo calls the delegate SQL functions inside a podhub_app transaction.
type Repo struct {
	pool  *pgxpool.Pool
	begin BeginApp
}

// New keeps the pool and the tenant opener. A nil pool cannot open a transaction.
func New(pool *pgxpool.Pool, begin BeginApp) Repo {
	return Repo{pool: pool, begin: begin}
}

func (r Repo) Accept(ctx context.Context, orgID, userID int64, dispatchID string) (string, error) {
	if userID <= 0 {
		return "", contract.ErrForbidden
	}
	var state string
	err := r.withTx(ctx, orgID, userID, func(tx pgx.Tx) error {
		id, err := parseUUID(dispatchID)
		if err != nil {
			return err
		}
		state, err = sqlcgen.New(tx).AcceptDispatch(ctx, sqlcgen.AcceptDispatchParams{
			DispatchID: id, SupplierUserID: userID,
		})
		return mapDispatch(err)
	})
	return state, err
}

func (r Repo) Reject(ctx context.Context, orgID, userID int64, dispatchID, reason string) (string, error) {
	if userID <= 0 {
		return "", contract.ErrForbidden
	}
	var state string
	err := r.withTx(ctx, orgID, userID, func(tx pgx.Tx) error {
		id, err := parseUUID(dispatchID)
		if err != nil {
			return err
		}
		state, err = sqlcgen.New(tx).RejectDispatch(ctx, sqlcgen.RejectDispatchParams{
			DispatchID: id, SupplierUserID: userID, Reason: reason,
		})
		return mapDispatch(err)
	})
	return state, err
}

func (r Repo) Ship(ctx context.Context, orgID, userID int64, dispatchID, trackingNo, note string, nowMS int64) (string, error) {
	if userID <= 0 {
		return "", contract.ErrForbidden
	}
	var state string
	err := r.withTx(ctx, orgID, userID, func(tx pgx.Tx) error {
		id, err := parseUUID(dispatchID)
		if err != nil {
			return err
		}
		state, err = sqlcgen.New(tx).ShipDispatch(ctx, sqlcgen.ShipDispatchParams{
			DispatchID: id, SupplierUserID: userID, TrackingNo: trackingNo, Note: note, NowMs: nowMS,
		})
		return mapDispatch(err)
	})
	return state, err
}

func (r Repo) ListDispatches(ctx context.Context, orgID, supplierUserID int64) ([]contract.DispatchView, error) {
	var out []contract.DispatchView
	err := r.withTx(ctx, orgID, supplierUserID, func(tx pgx.Tx) error {
		rows, err := sqlcgen.New(tx).ListDispatchStates(ctx)
		if err != nil {
			return err
		}
		out = make([]contract.DispatchView, 0, len(rows))
		for _, row := range rows {
			out = append(out, contract.DispatchView{DispatchID: row.DispatchID, State: row.State})
		}
		return nil
	})
	return out, err
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
	return db.InTx(ctx, r.pool, session, fn)
}

func parseUUID(raw string) (pgtype.UUID, error) {
	var id pgtype.UUID
	if err := id.Scan(strings.TrimSpace(raw)); err != nil || !id.Valid {
		return pgtype.UUID{}, contract.ErrNotFound
	}
	return id, nil
}

func mapDispatch(err error) error {
	if err == nil {
		return nil
	}
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) {
		switch {
		case strings.Contains(pgErr.Message, "DELEGATE_NOT_FOUND"):
			return contract.ErrNotFound
		case strings.Contains(pgErr.Message, "DELEGATE_FORBIDDEN"):
			return contract.ErrForbidden
		case strings.Contains(pgErr.Message, "DELEGATE_TERMINAL"):
			return contract.ErrTerminal
		}
	}
	return err
}
