package submit

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"testing"
	"time"

	"github.com/xxww0098/podhub-go/internal/listing/core/contract"
	"github.com/xxww0098/podhub-go/tests/testkit"
)

func TestSendDraftsSnakeCaseEnvelopePreservesWASMItem(t *testing.T) {
	f := newStoredRevisionFixture(t, 96215)
	row := f.row(t, 1, "draft-wire")
	item := json.RawMessage(`{"rowId":"` + row + `","schemaRevision":"workflow:sha256:test","draft":{"values":{}}}`)
	body, err := json.Marshal(map[string]any{
		"store_id": f.store, "card_id": f.card, "items": []json.RawMessage{item},
	})
	if err != nil {
		t.Fatal(err)
	}
	mod := &draftRequestModule{}
	f.bind(t, mod)
	result, err := SendDrafts(f.ctx, f.pool, f.org, f.user, body, time.Now())
	if err != nil || len(result.Items) != 1 {
		t.Fatalf("draft result: %+v err=%v", result, err)
	}
	got := result.Items[0]
	if got.RowID != row || got.Outcome != "created" || got.Intent == nil || got.Intent.StoreID != f.store {
		t.Fatalf("draft envelope did not reach admission: %+v", got)
	}
	if !bytes.Equal(mod.draft, item) {
		t.Fatalf("HTTP envelope translation altered the WASM item: got=%s want=%s", mod.draft, item)
	}
}

func TestSendDraftsSuccessResponseContract(t *testing.T) {
	f := newStoredRevisionFixture(t, 96216)
	created := f.row(t, 1, "new")
	replayed := f.row(t, 1, "existing")
	blocked := f.row(t, 1, "blocked")
	seedIntent(t, f.ctx, f.pool, f.org, f.store, f.card, frozen{
		rowID: replayed, revision: 0, clientOp: "op-" + replayed,
		digest: "digest-" + replayed, offerID: "offer-" + replayed,
	}, Accepted, time.Date(2020, 1, 1, 0, 0, 0, 0, time.UTC))
	var drafts []json.RawMessage
	for _, row := range []string{created, replayed, blocked} {
		drafts = append(drafts, json.RawMessage(`{"rowId":"`+row+`","schemaRevision":"workflow:sha256:test","draft":{"values":{}}}`))
	}
	body, err := json.Marshal(map[string]any{"store_id": f.store, "card_id": f.card, "items": drafts})
	if err != nil {
		t.Fatal(err)
	}
	f.bind(t, &draftRequestModule{blockedRow: blocked})
	result, err := SendDrafts(f.ctx, f.pool, f.org, f.user, body, time.Now())
	if err != nil || len(result.Items) != 3 {
		t.Fatalf("draft result: %+v err=%v", result, err)
	}
	byRow := make(map[string]DraftItem, len(result.Items))
	for _, item := range result.Items {
		byRow[item.RowID] = item
	}
	if got := byRow[created]; got.Outcome != "created" || got.Intent == nil || got.Intent.State != Queued || got.Intent.StoreID != f.store || got.Intent.ListingRowID != created {
		t.Errorf("created result: %+v", got)
	}
	if got := byRow[replayed]; got.Outcome != "replayed" || got.Intent == nil || got.Intent.State != Accepted || got.Intent.StoreID != f.store || got.Intent.ListingRowID != replayed {
		t.Errorf("replay must preserve its accepted state: %+v", got)
	}
	if got := byRow[blocked]; got.Outcome != "skipped" || got.SkipReason != "blocked" || got.Intent != nil || !bytes.Equal(got.Issues, []byte(draftRequestIssues)) {
		t.Errorf("WASM refusal changed: %+v", got)
	}
	raw, err := json.Marshal(struct {
		Data DraftData `json:"data"`
	}{Data: result})
	if err != nil {
		t.Fatal(err)
	}
	spec, err := testkit.LoadOpenAPI()
	if err != nil {
		t.Fatal(err)
	}
	if err := spec.CheckResponse(http.MethodPost, "/api/listing/submit", http.StatusOK, http.Header{"Content-Type": {"application/json"}}, raw); err != nil {
		t.Errorf("persisted draft response: %s: %v", raw, err)
	}
	var intents, jobs, queued int
	if err := f.pool.QueryRow(f.ctx, `SELECT count(*) FROM submission_intents WHERE org_id = $1`, f.org).Scan(&intents); err != nil {
		t.Fatal(err)
	}
	if err := f.pool.QueryRow(f.ctx, `SELECT count(*), COALESCE(sum(jsonb_array_length(payload->'intents')), 0) FROM jobs WHERE org_id = $1`, f.org).Scan(&jobs, &queued); err != nil {
		t.Fatal(err)
	}
	if intents != 2 || jobs != 1 || queued != 1 {
		t.Errorf("replayed or skipped rows created work: intents=%d jobs=%d queued=%d", intents, jobs, queued)
	}
}

const draftRequestIssues = `[{"field_key":"name","code":"required","parameters":{},"severity":"blocking","address":{"kind":"plain","field_key":"name"},"message":"商品名称为必填项","remediation":"填写商品名称"}]`

type draftRequestModule struct {
	storedSubmitModule
	draft      json.RawMessage
	blockedRow string
}

func (m *draftRequestModule) Call(ctx context.Context, op uint32, schema, body []byte) ([]byte, error) {
	if op == contract.OpFreezeListing && m.blockedRow != "" {
		var input struct {
			RowID string `json:"rowId"`
		}
		if err := json.Unmarshal(body, &input); err != nil {
			return nil, err
		}
		if input.RowID == m.blockedRow {
			return []byte(`{"status":"refused","reason":"validation_failed","issues":` + draftRequestIssues + `}`), nil
		}
	}
	if op != contract.OpSubmitDraft {
		return m.storedSubmitModule.Call(ctx, op, schema, body)
	}
	var input struct {
		Draft json.RawMessage `json:"draft"`
	}
	if err := json.Unmarshal(body, &input); err != nil {
		return nil, err
	}
	m.draft = input.Draft
	return []byte(`{}`), nil
}
