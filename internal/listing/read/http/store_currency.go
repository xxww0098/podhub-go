package readhttp

import (
	"context"
	"encoding/json"
	"errors"
	"strings"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// projectStoreCurrency writes the destination Store's contract currency into
// the Card defaults. Ozon fixes one currency per Seller contract, and the
// Card can be sent to more than one Store, so the value stored on the Card is
// only a default. The send resolves the real Store; this projection makes the
// workbench show and validate against that same value.
func projectStoreCurrency(ctx context.Context, tx pgx.Tx, orgID int64, payload []byte, fallback *string) ([]byte, error) {
	storeID := payloadStoreID(payload)
	if storeID == "" && fallback != nil {
		storeID = strings.TrimSpace(*fallback)
	}
	if _, err := uuid.Parse(storeID); err != nil {
		return payload, nil
	}
	var contract string
	err := tx.QueryRow(ctx, `
		SELECT COALESCE(company_currency, '')
		  FROM public.organization_stores
		 WHERE org_id = $1 AND uuid = $2::uuid AND deleted_at_ms IS NULL`, orgID, storeID).Scan(&contract)
	if errors.Is(err, pgx.ErrNoRows) {
		return payload, nil
	}
	if err != nil {
		return nil, err
	}
	contract = strings.ToUpper(strings.TrimSpace(contract))
	if contract == "" {
		return payload, nil
	}
	var doc map[string]any
	if err := json.Unmarshal(payload, &doc); err != nil {
		return nil, err
	}
	defaults, _ := doc["defaults"].(map[string]any)
	if defaults == nil {
		defaults = map[string]any{}
		doc["defaults"] = defaults
	}
	values, _ := defaults["values"].(map[string]any)
	if values == nil {
		values = map[string]any{}
		defaults["values"] = values
	}
	values["currency_code"] = map[string]any{"kind": "text", "value": contract}
	dropStringMember(defaults, "cleared", "currency_code")
	body, err := json.Marshal(doc)
	if err != nil {
		return nil, err
	}
	return body, nil
}

// payloadStoreID is the first Store a Card targets. A Card may fan out to
// several Stores; the projection shows the first one, and each send stamps its
// own destination.
func payloadStoreID(payload []byte) string {
	var doc struct {
		TargetStoreID string `json:"targetStoreId"`
	}
	if json.Unmarshal(payload, &doc) != nil {
		return ""
	}
	for _, id := range strings.Split(doc.TargetStoreID, ",") {
		if id = strings.TrimSpace(id); id != "" {
			return id
		}
	}
	return ""
}

func dropStringMember(doc map[string]any, field, want string) {
	list, _ := doc[field].([]any)
	if len(list) == 0 {
		return
	}
	kept := list[:0]
	for _, item := range list {
		if text, ok := item.(string); ok && text == want {
			continue
		}
		kept = append(kept, item)
	}
	if len(kept) == 0 {
		delete(doc, field)
		return
	}
	doc[field] = kept
}
