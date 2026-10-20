package app

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"

	access "github.com/xxww0098/podhub-go/internal/identity/contract"
	"github.com/xxww0098/podhub-go/internal/ops/contract"
	opshttp "github.com/xxww0098/podhub-go/internal/ops/http"
	opssvc "github.com/xxww0098/podhub-go/internal/ops/service"
	"github.com/xxww0098/podhub-go/internal/platform/config"
	"github.com/xxww0098/podhub-go/internal/seller"
)

func TestOpsWriteKillSwitchSendsNothing(t *testing.T) {
	var hits int
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits++
		http.Error(w, "down", http.StatusInternalServerError)
	}))
	t.Cleanup(srv.Close)
	member := access.FixedResolver{Principal: &access.Principal{UserID: 1, OrgID: 9, WorkspaceRole: "member"}}
	body := `{"operation_id":"00000000-0000-4000-8000-000000000001","store_id":"00000000-0000-4000-8000-0000000000a1","request":{"kind":"stock","items":[{"product_id":41,"offer_id":"ART-41","sku":90041,"warehouse_id":7,"stock":5}]}}`

	t.Run("closed", func(t *testing.T) {
		hits = 0
		var began int
		t.Setenv("CLOUD_SELLER_BASE_URL", srv.URL+"/")
		t.Setenv("OZON_WRITE_KILL_SWITCH", "1")
		eg := seller.New(config.Load())
		r := chi.NewRouter()
		opshttp.Mount(r, opshttp.Deps{Resolve: opsResolve(member), Screen: &opssvc.Screen{
			Stores: gateAdmit{}, Ledger: gateLedger{n: &began}, Seller: sellerPort{egress: eg},
		}})
		rec := httptest.NewRecorder()
		r.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/api/ops/products/mutate", strings.NewReader(body)))
		if rec.Code != http.StatusServiceUnavailable || !strings.Contains(rec.Body.String(), `"code":"writes_disabled"`) {
			t.Fatalf("%d %s", rec.Code, rec.Body.String())
		}
		send := httptest.NewRecorder()
		r.ServeHTTP(send, httptest.NewRequest(http.MethodPost, "/api/ops/message-center/send", strings.NewReader(`{"store_id":"00000000-0000-4000-8000-0000000000a1","chat_id":"c","text":"hi"}`)))
		if send.Code != http.StatusServiceUnavailable || hits != 0 || eg.WritePosts() != 0 || began != 0 {
			t.Fatalf("send %d hits %d posts %d began %d %s", send.Code, hits, eg.WritePosts(), began, send.Body.String())
		}
	})

	t.Run("open still does not dial a rejected body", func(t *testing.T) {
		hits = 0
		t.Setenv("CLOUD_SELLER_BASE_URL", srv.URL+"/")
		t.Setenv("OZON_WRITE_KILL_SWITCH", "0")
		eg := seller.New(config.Load())
		r := chi.NewRouter()
		opshttp.Mount(r, opshttp.Deps{Resolve: opsResolve(member), Screen: &opssvc.Screen{Seller: sellerPort{egress: eg}}})
		rec := httptest.NewRecorder()
		r.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/api/ops/products/mutate", strings.NewReader(`{}`)))
		if rec.Code != http.StatusNotImplemented || !strings.Contains(rec.Body.String(), `"error":"not_ported"`) {
			t.Fatalf("%d %s", rec.Code, rec.Body.String())
		}
		if hits != 0 || eg.WritePosts() != 0 {
			t.Fatalf("hits %d posts %d", hits, eg.WritePosts())
		}
	})
}

type gateAdmit struct{}

func (gateAdmit) Admit(context.Context, int64, int64, string, string, int64) (contract.Admitted, error) {
	return contract.Admitted{StorePK: 1, UUID: "00000000-0000-4000-8000-0000000000a1", Secret: contract.Secret{ClientID: "c", APIKey: "k"}}, nil
}

type gateLedger struct{ n *int }

func (g gateLedger) Begin(context.Context, int64, int64, string, string, string, []byte) (contract.LedgerRow, error) {
	*g.n++
	return contract.LedgerRow{Inserted: true, State: "dispatching"}, nil
}
func (gateLedger) Settle(context.Context, int64, int64, string, string, int, []byte) error {
	return nil
}
func (gateLedger) MarkUnknown(context.Context, int64, int64, string, string, string, string, int) error {
	return nil
}
func (gateLedger) Heartbeat(context.Context, int64, int64, string) error { return nil }
