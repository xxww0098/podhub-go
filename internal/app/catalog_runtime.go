package app

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	outcome "github.com/xxww0098/podhub-go/internal/admin/core/contract/outcome"
	"github.com/xxww0098/podhub-go/internal/catalog"
	"github.com/xxww0098/podhub-go/internal/listing/core"
	corecontract "github.com/xxww0098/podhub-go/internal/listing/core/contract"
	"github.com/xxww0098/podhub-go/internal/platform/config"
	seller "github.com/xxww0098/podhub-go/internal/seller/ozon"
)

func catalogSnapshot(ctx context.Context, raw []byte) ([]byte, error) {
	mod, err := core.Shared(ctx)
	if err != nil {
		return nil, err
	}
	return mod.Snapshot(ctx, raw)
}

func validateSupplierConfig(ctx context.Context, material, config []byte) ([]byte, error) {
	mod, err := core.Shared(ctx)
	if err != nil {
		return nil, err
	}
	var input struct {
		Category int64           `json:"description_category_id"`
		TypeID   int64           `json:"type_id"`
		Fields   json.RawMessage `json:"fields"`
		Search   json.RawMessage `json:"searchMaterials"`
	}
	if err = json.Unmarshal(material, &input); err != nil {
		return nil, err
	}
	snapshotInput, _ := json.Marshal(map[string]any{"description_category_id": input.Category, "type_id": input.TypeID, "fields": input.Fields})
	snapshot, err := mod.Snapshot(ctx, snapshotInput)
	if err != nil {
		return nil, err
	}
	schema, _ := json.Marshal(map[string]any{"snapshot": json.RawMessage(snapshot), "searchMaterials": input.Search})
	result, err := mod.Call(ctx, corecontract.OpSupplierConfig, schema, config)
	if err != nil {
		if failure, ok := corecontract.AsCoreError(err); ok && failure.Code == corecontract.CodeDecode {
			return nil, &outcome.Fail{Kind: outcome.KindValidation, Message: "Ozon 配置的字段值或复杂组格式无效"}
		}
		return nil, err
	}
	var output struct {
		Issues json.RawMessage `json:"issues"`
	}
	if json.Unmarshal(result, &output) != nil || len(output.Issues) == 0 {
		return nil, fmt.Errorf("supplier config validation returned no issues")
	}
	return output.Issues, nil
}

func newCatalogFetcher(ctx context.Context, pool *pgxpool.Pool, cfg config.Config) *catalog.Fetcher {
	host := catalog.Host{Pool: pool, Now: time.Now, Seller: sellerPoster(seller.New(cfg).WithPool(pool)), Seals: sealRing(cfg), Snapshot: catalogSnapshot}
	return &catalog.Fetcher{Pool: pool, Context: ctx, Now: time.Now, Execute: host.Refresh}
}
