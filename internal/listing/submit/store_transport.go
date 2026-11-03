package submit

import (
	"context"

	sellercontract "github.com/xxww0098/podhub-go/internal/seller/contract"
)

func bindStoreTransport(ctx context.Context, tr Transport, scope sellercontract.StoreBinding) (Transport, error) {
	if bound, ok := tr.(sellercontract.StoreTransport); ok {
		return bound.BindStore(ctx, scope)
	}
	return tr, nil
}
