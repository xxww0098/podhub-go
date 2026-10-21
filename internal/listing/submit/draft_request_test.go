package submit

import (
	"bytes"
	"context"
	"encoding/json"
	"testing"
	"time"

	"github.com/xxww0098/podhub-go/internal/listing/core/contract"
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

type draftRequestModule struct {
	storedSubmitModule
	draft json.RawMessage
}

func (m *draftRequestModule) Call(ctx context.Context, op uint32, schema, body []byte) ([]byte, error) {
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
