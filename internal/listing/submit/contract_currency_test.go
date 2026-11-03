package submit

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"github.com/xxww0098/podhub-go/internal/listing/core/contract"
)

func TestSendDraftsStampsTheStoreContractCurrency(t *testing.T) {
	f := newStoredRevisionFixture(t, 96217)
	setContractCurrency(t, f, "CNY")
	setDraftCurrency(t, f, `{"targetStoreId":"`+f.store+`"}`, "RUB")
	row := f.row(t, 1, "currency")
	if _, err := f.pool.Exec(f.ctx, `
		UPDATE listing_rows
		   SET payload = jsonb_set(payload, '{draft,values,currency_code}', '{"kind":"text","value":"RUB"}')
		 WHERE org_id = $1 AND id = $2::uuid`, f.org, row); err != nil {
		t.Fatal(err)
	}
	item := json.RawMessage(`{"rowId":"` + row + `","schemaRevision":"workflow:sha256:test","draft":{"values":{"currency_code":{"kind":"text","value":"RUB"}}}}`)
	body, err := json.Marshal(map[string]any{"store_id": f.store, "card_id": f.card, "items": []json.RawMessage{item}})
	if err != nil {
		t.Fatal(err)
	}
	mod := &draftRequestModule{}
	f.bind(t, mod)
	if _, err := testSubmit().SendDrafts(f.ctx, f.pool, f.org, f.user, body, time.Now()); err != nil {
		t.Fatal(err)
	}
	if got := valueAt(mod.draft, "draft", "currency_code"); got != "CNY" {
		t.Errorf("draft currency = %q, want the store contract CNY", got)
	}
	if got := valueAt(mod.card, "defaults", "currency_code"); got != "CNY" {
		t.Errorf("card defaults currency = %q, want the store contract CNY", got)
	}
}

func TestSendStoredStampsTheStoreContractCurrency(t *testing.T) {
	f := newStoredRevisionFixture(t, 96218)
	setContractCurrency(t, f, "CNY")
	setDraftCurrency(t, f, `{"targetStoreId":"`+f.store+`"}`, "RUB")
	row := f.row(t, 1, "currency")
	if _, err := f.pool.Exec(f.ctx, `
		UPDATE listing_rows
		   SET payload = jsonb_set(payload, '{draft,values,currency_code}', '{"kind":"text","value":"RUB"}')
		 WHERE org_id = $1 AND id = $2::uuid`, f.org, row); err != nil {
		t.Fatal(err)
	}
	mod := &contractCurrencyModule{}
	f.bind(t, mod)
	result, err := testSubmit().SendStored(f.ctx, f.pool, f.org, f.user, f.request(t, []string{row}, map[string]int64{row: 1}), time.Now())
	if err != nil {
		t.Fatal(err)
	}
	if len(result.Items) != 1 || !result.Items[0].Created {
		t.Fatalf("row did not enqueue: %+v", result.Items)
	}
	if got := valueAt(mod.row, "draft", "currency_code"); got != "CNY" {
		t.Errorf("row currency = %q, want the store contract CNY", got)
	}
	if got := valueAt(mod.card, "defaults", "currency_code"); got != "CNY" {
		t.Errorf("card defaults currency = %q, want the store contract CNY", got)
	}
}

func TestStampContractCurrencyDropsClearedAndHandEditedDecisions(t *testing.T) {
	payload := []byte(`{"handEditedKeys":["currency_code","name"],"draft":{"values":{"currency_code":{"kind":"text","value":"RUB"}},"cleared":["currency_code","price"]}}`)
	out, err := stampContractCurrency(payload, "draft", "CNY")
	if err != nil {
		t.Fatal(err)
	}
	var doc map[string]any
	if err := json.Unmarshal(out, &doc); err != nil {
		t.Fatal(err)
	}
	if got := valueAt(out, "draft", "currency_code"); got != "CNY" {
		t.Errorf("currency = %q, want CNY", got)
	}
	if keys := stringsIn(doc["handEditedKeys"]); len(keys) != 1 || keys[0] != "name" {
		t.Errorf("handEditedKeys = %v, want only name", keys)
	}
	draft, _ := doc["draft"].(map[string]any)
	if cleared := stringsIn(draft["cleared"]); len(cleared) != 1 || cleared[0] != "price" {
		t.Errorf("cleared = %v, want only price", cleared)
	}
}

func TestStampContractCurrencyLeavesAnUnknownContractAlone(t *testing.T) {
	payload := []byte(`{"draft":{"values":{"currency_code":{"kind":"text","value":"RUB"}}}}`)
	out, err := stampContractCurrency(payload, "draft", "")
	if err != nil {
		t.Fatal(err)
	}
	if got, want := string(out), string(payload); got != want {
		t.Fatalf("payload changed without a contract currency: got %s want %s", got, want)
	}
}

func setContractCurrency(t *testing.T, f storedRevisionFixture, currency string) {
	t.Helper()
	if _, err := f.pool.Exec(f.ctx, `UPDATE organization_stores SET company_currency = $1 WHERE org_id = $2 AND uuid = $3::uuid`, currency, f.org, f.store); err != nil {
		t.Fatal(err)
	}
}

func setDraftCurrency(t *testing.T, f storedRevisionFixture, payload, currency string) {
	t.Helper()
	if _, err := f.pool.Exec(f.ctx, `
		UPDATE listing_cards
		   SET payload = payload || $3::jsonb || jsonb_build_object('defaults', jsonb_build_object(
		       'values', jsonb_build_object('currency_code', jsonb_build_object('kind','text','value',$4::text))))
		 WHERE org_id = $1 AND id = $2::uuid`, f.org, f.card, payload, currency); err != nil {
		t.Fatal(err)
	}
}

func valueAt(payload []byte, holder, key string) string {
	var doc map[string]any
	if json.Unmarshal(payload, &doc) != nil {
		return ""
	}
	container, _ := doc[holder].(map[string]any)
	values, _ := container["values"].(map[string]any)
	value, _ := values[key].(map[string]any)
	text, _ := value["value"].(string)
	return text
}

func stringsIn(raw any) []string {
	list, _ := raw.([]any)
	out := make([]string, 0, len(list))
	for _, item := range list {
		if text, ok := item.(string); ok {
			out = append(out, text)
		}
	}
	return out
}

// contractCurrencyModule records the card and row the freeze ran with and
// returns an import carrying the row's own currency, so a missing stamp hits
// the local currency gate instead of passing silently.
type contractCurrencyModule struct {
	storedSubmitModule
	card, row json.RawMessage
}

func (m *contractCurrencyModule) Call(ctx context.Context, op uint32, schema, body []byte) ([]byte, error) {
	if op != contract.OpFreezeListing {
		return m.storedSubmitModule.Call(ctx, op, schema, body)
	}
	var input struct {
		Card  json.RawMessage `json:"card"`
		Row   json.RawMessage `json:"row"`
		RowID string          `json:"rowId"`
	}
	if err := json.Unmarshal(body, &input); err != nil {
		return nil, err
	}
	m.card, m.row = input.Card, input.Row
	currency := valueAt(input.Row, "draft", "currency_code")
	return json.Marshal(map[string]any{
		"status": "frozen", "digest": "digest-" + input.RowID,
		"clientOperationId": "op-" + input.RowID, "offerId": "offer-" + input.RowID,
		"import": map[string]any{"items": []map[string]string{{
			"offer_id": "offer-" + input.RowID, "currency_code": currency,
		}}},
	})
}
