package worker

import (
	"context"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	tenant "github.com/xxww0098/podhub-go/internal/platform/db/tenantx"
	"github.com/xxww0098/podhub-go/internal/platform/seal"
	sellercontract "github.com/xxww0098/podhub-go/internal/seller/contract"
	seller "github.com/xxww0098/podhub-go/internal/seller/ozon"
	storerepo "github.com/xxww0098/podhub-go/internal/store/repo"
)

// ListingTransport is shared by sending and ledger reconciliation. The opener
// commits its tenant transaction before the bound port can leave the process.
func ListingTransport(e *seller.Egress, pool *pgxpool.Pool, ring seal.Ring, keyID string) sellercontract.StoreTransport {
	return seller.NewListingTransport(e, func(ctx context.Context, binding sellercontract.StoreBinding) (seller.StoreScope, string, string, error) {
		if pool == nil {
			return seller.StoreScope{}, "", "", sellercontract.ErrNotSent
		}
		tx, err := tenant.BeginApp(ctx, pool.Begin, binding.OrgID)
		if err != nil {
			return seller.StoreScope{}, "", "", sellercontract.ErrNotSent
		}
		defer tx.Rollback(ctx)
		opened, err := storerepo.OpenListingCredentialTx(ctx, tx, ring, keyID, binding, time.Now())
		if err != nil {
			return seller.StoreScope{}, "", "", sellercontract.ErrNotSent
		}
		if err := tx.Commit(ctx); err != nil {
			return seller.StoreScope{}, "", "", sellercontract.ErrNotSent
		}
		return seller.StoreScope{OrgID: binding.OrgID, StorePK: opened.StoreID,
			StoreUUID: opened.UUID, CredentialRevision: opened.CredentialRevision}, opened.ClientID, opened.APIKey, nil
	})
}
