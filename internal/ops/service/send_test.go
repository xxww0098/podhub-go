package service

import (
	"context"
	"fmt"
	"testing"

	"github.com/xxww0098/podhub-go/internal/ops/contract"
)

type sendStore struct{}

func (sendStore) Admit(context.Context, int64, int64, string, string, int64) (contract.Admitted, error) {
	return contract.Admitted{StorePK: 1, UUID: "11111111-1111-4111-8111-111111111111"}, nil
}

type sendLedger struct {
	rows   map[string]contract.LedgerRow
	hashes map[string]string
}

func (l *sendLedger) Begin(_ context.Context, _, _ int64, key, hash, _ string, _ []byte) (contract.LedgerRow, error) {
	if row, ok := l.rows[key]; ok {
		if l.hashes[key] != hash {
			return contract.LedgerRow{}, &contract.Fail{Status: 409, Code: contract.CodeConflict}
		}
		return row, nil
	}
	l.hashes[key] = hash
	l.rows[key] = contract.LedgerRow{State: "dispatching"}
	return contract.LedgerRow{Inserted: true, State: "dispatching"}, nil
}
func (l *sendLedger) Settle(_ context.Context, _, _ int64, key, _ string, status int, body []byte) error {
	l.rows[key] = contract.LedgerRow{State: "settled", Status: status, Body: body}
	return nil
}
func (*sendLedger) MarkUnknown(context.Context, int64, int64, string, string, string, string, int) error {
	return nil
}
func (*sendLedger) Heartbeat(context.Context, int64, int64, string) error { return nil }

type sendSeller struct{ calls int }

func (s *sendSeller) Call(context.Context, contract.Lane, string, string, []byte, contract.Secret) (int, string, error) {
	s.calls++
	return 200, `{"result":"success"}`, nil
}
func (*sendSeller) WritesDisabled() bool { return false }

func TestMessageOperationSeparatesNewSendsFromRetries(t *testing.T) {
	upstream := &sendSeller{}
	screen := Screen{Stores: sendStore{}, Ledger: &sendLedger{rows: map[string]contract.LedgerRow{}, hashes: map[string]string{}}, Seller: upstream}
	actor := Actor{UserID: 1, OrgID: 1, Role: "member"}
	send := func(operation, text string) *contract.Fail {
		_, fail := screen.Send(context.Background(), actor, []byte(fmt.Sprintf(`{"operation_id":%q,"store_id":"11111111-1111-4111-8111-111111111111","chat_id":"buyer-1","text":%q}`, operation, text)))
		return fail
	}
	first, second := "11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222"
	for _, op := range []string{first, first, second} {
		if fail := send(op, "Спасибо"); fail != nil {
			t.Fatal(fail)
		}
	}
	if upstream.calls != 2 {
		t.Fatalf("two independent sends and one retry made %d writes", upstream.calls)
	}
	if fail := send(first, "different"); fail == nil || fail.Status != 409 {
		t.Fatal("operation accepted different content")
	}
	if fail := send("", "Спасибо"); fail == nil || fail.Status != 400 {
		t.Fatal("missing operation accepted")
	}
	if upstream.calls != 2 {
		t.Fatal("invalid or conflicting send reached upstream")
	}
}
