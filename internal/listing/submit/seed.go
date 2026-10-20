package submit

import (
	"context"

	"github.com/jackc/pgx/v5/pgxpool"

	tenant "github.com/xxww0098/podhub-go/internal/platform/db/tenantx"
)

// Seed is one intent the worker would see after freeze. The hash and the
// import body are the caller's. This package does not invent a freeze digest.
type Seed struct {
	OrgID       int64
	UserID      int64
	StorePK     int64
	StoreID     string
	IntentID    string
	RowID       string
	CardID      string
	OfferID     string
	ClientOp    string
	RequestHash string
	RowRevision int64
	Import      []byte
}

// InsertQueued writes the row, the queued intent, and nothing on the Seller
// ledger. The caller owns the import bytes.
func InsertQueued(ctx context.Context, pool *pgxpool.Pool, row Seed) error {
	tx, err := pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if err := tenant.EnterApp(ctx, tx, row.OrgID); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO public.listing_rows (id, org_id, card_id, revision, store_id)
		VALUES ($1::uuid, $2, $3::uuid, $4, $5::uuid)`,
		row.RowID, row.OrgID, row.CardID, row.RowRevision, row.StoreID); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO public.submission_intents (
			id, org_id, store_id, listing_row_id, row_revision, client_operation_id,
			request_hash, state, offer_id, card_id
		) VALUES (
			$1::uuid, $2, $3::uuid, $4::uuid, $5, $6, $7, 'queued', $8, $9::uuid
		)`,
		row.IntentID, row.OrgID, row.StoreID, row.RowID, row.RowRevision,
		row.ClientOp, row.RequestHash, row.OfferID, row.CardID); err != nil {
		return err
	}
	return tx.Commit(ctx)
}
