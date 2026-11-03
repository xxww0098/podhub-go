package service

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/xxww0098/podhub-go/internal/mcp/domain"
)

type listingStateStore struct {
	grantStore
	calls int
}

func (s *listingStateStore) ListingState(_ context.Context, _ domain.Grant, _ domain.Claim, card, row, store string) (json.RawMessage, error) {
	s.calls++
	return json.Marshal(map[string]string{"cardId": card, "rowId": row, "storeId": store})
}

func TestListingStateIsScopedAndValidatesExactIdentifiers(t *testing.T) {
	store := &listingStateStore{grantStore: grantStore{grant: sampleCodeGrant()}}
	svc := New(store)
	code := "return await sdk.workspace.listingRows.getState(input);"
	good := json.RawMessage(`{"cardId":"11111111-1111-4111-8111-111111111111","rowId":"22222222-2222-4222-8222-222222222222","storeId":"33333333-3333-4333-8333-333333333333"}`)
	status, value, herr, calls := svc.run(context.Background(), store.grant, domain.Claim{}, code, good)
	if status != "completed" || herr != nil || calls != 1 || store.calls != 1 || len(value) == 0 {
		t.Fatalf("status=%s error=%v calls=%d", status, herr, calls)
	}
	for _, bad := range []string{`{"cardId":"no"}`, `{"cardId":"11111111-1111-4111-8111-111111111111","rowId":"22222222-2222-4222-8222-222222222222","storeId":"33333333-3333-4333-8333-333333333333","extra":true}`} {
		status, _, herr, _ = svc.run(context.Background(), store.grant, domain.Claim{}, code, json.RawMessage(bad))
		if status != "failed" || herr == nil || herr.Code != "invalid_arguments" {
			t.Fatalf("bad arguments: status=%s error=%v", status, herr)
		}
	}
	withoutRead := store.grant
	withoutRead.Actions = nil
	status, _, herr, _ = svc.run(context.Background(), withoutRead, domain.Claim{}, code, good)
	if status != "failed" || herr == nil || herr.Code != "method_not_allowed" || store.calls != 1 {
		t.Fatalf("permission: status=%s error=%v calls=%d", status, herr, store.calls)
	}
}
