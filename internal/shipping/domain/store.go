package domain

import (
	"context"
	"encoding/json"
)

// Store is the shipping-injection transaction port.
// The repository implements it. The service does not import the repository.
type Store interface {
	Reconcile(ctx context.Context, storeUUID, presetID string, now int64, ozon Ozon) (json.RawMessage, error)
	SafeContinue(ctx context.Context, storeUUID, presetID, actor string, now int64, ozon Ozon) (json.RawMessage, error)
}
