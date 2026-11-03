package integration

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

// The caller supplies its real app.Handler while its fixture session has a super-admin role.
func runAdminRuntimeRoleCases(t *testing.T, f listingMediaTest, apiPool *pgxpool.Pool, actual http.Handler) {
	t.Helper()
	t.Run("wallet_topup_replay_revoke_uses_normal_role", func(t *testing.T) {
		var login, effective string
		var privileged bool
		if err := apiPool.QueryRow(f.ctx, `SELECT session_user,current_user,rolsuper OR rolbypassrls FROM pg_roles WHERE rolname=session_user`).Scan(&login, &effective, &privileged); err != nil || login != "podhub_login_api" || effective != login || privileged {
			t.Fatalf("runtime role login=%q effective=%q privileged=%v err=%v", login, effective, privileged, err)
		}
		const reason = "normal-role admin wallet test"
		seedMatchingLease(t, f.ctx, f.pool, "entitlement", reason)
		t.Cleanup(func() {
			_, _ = f.pool.Exec(context.Background(), `DELETE FROM writer_leases WHERE domain='entitlement' AND grant_reason=$1`, reason)
		})
		path := "/api/admin/workspaces/" + f.workspace + "/wallet"
		invoke := func(method, target string, body any) *httptest.ResponseRecorder {
			t.Helper()
			var raw []byte
			if body != nil {
				var err error
				raw, err = json.Marshal(body)
				if err != nil {
					t.Fatal(err)
				}
			}
			req := httptest.NewRequest(method, target, strings.NewReader(string(raw)))
			req.Header.Set("Cookie", f.cookie)
			req.Header.Set("Content-Type", "application/json")
			rec := httptest.NewRecorder()
			actual.ServeHTTP(rec, req)
			return rec
		}
		type walletView struct {
			Balance   int64 `json:"balance_microfen"`
			Held      int64 `json:"held_microfen"`
			Available int64 `json:"available_microfen"`
			Topups    []struct {
				ID     string `json:"id"`
				Amount int64  `json:"amount_microfen"`
				Note   string `json:"note"`
			} `json:"topups"`
		}
		readWallet := func(rec *httptest.ResponseRecorder) walletView {
			t.Helper()
			return listingMediaData[walletView](t, rec)
		}
		before := readWallet(invoke(http.MethodGet, path, nil))
		operation := "normal-role-wallet-" + uuid.NewString()
		const cents int64 = 7
		const amount = cents * 1_000_000
		const note = "ordinary API role regression"
		grant := map[string]any{"operation_id": operation, "amount_cents": cents, "note": note}
		checkWallet := func(got walletView, wantBalance int64, hasTopup bool) {
			t.Helper()
			if got.Balance != wantBalance || got.Held != before.Held || got.Available != wantBalance-before.Held {
				t.Fatalf("wallet balance=%d held=%d available=%d, expected balance=%d held=%d", got.Balance, got.Held, got.Available, wantBalance, before.Held)
			}
			matches := 0
			for _, topup := range got.Topups {
				if topup.ID == operation {
					matches++
					if topup.Amount != amount || topup.Note != note {
						t.Fatalf("topup receipt changed: %+v", topup)
					}
				}
			}
			want := 0
			if hasTopup {
				want = 1
			}
			if matches != want {
				t.Fatalf("topup receipt count=%d want=%d", matches, want)
			}
		}
		checkWallet(readWallet(invoke(http.MethodPost, path+"/topups", grant)), before.Balance+amount, true)
		checkWallet(readWallet(invoke(http.MethodPost, path+"/topups", grant)), before.Balance+amount, true)
		conflict := invoke(http.MethodPost, path+"/topups", map[string]any{"operation_id": operation, "amount_cents": cents + 1, "note": note})
		if conflict.Code != http.StatusConflict {
			t.Fatalf("changed topup replay: %d %s", conflict.Code, conflict.Body.String())
		}
		checkWallet(readWallet(invoke(http.MethodGet, path, nil)), before.Balance+amount, true)
		checkWallet(readWallet(invoke(http.MethodPost, path+"/topups/"+operation+"/revoke", nil)), before.Balance, false)
		repeated := invoke(http.MethodPost, path+"/topups/"+operation+"/revoke", nil)
		if repeated.Code != http.StatusConflict {
			t.Fatalf("repeated revoke: %d %s", repeated.Code, repeated.Body.String())
		}
		checkWallet(readWallet(invoke(http.MethodGet, path, nil)), before.Balance, false)

		var grants, revokes int
		var net, heldDelta int64
		var allAdjustments bool
		if err := f.pool.QueryRow(f.ctx, `SELECT count(*) FILTER(WHERE idempotency_key=$2),count(*) FILTER(WHERE idempotency_key=$3),COALESCE(sum(amount_microfen),0)::bigint,COALESCE(sum(held_delta_microfen),0)::bigint,COALESCE(bool_and(entry_type='adjustment'),false) FROM wallet_ledger WHERE org_id=$1 AND idempotency_key IN($2,$3)`, f.org, "manual:"+operation, "manual:"+operation+":revoke").Scan(&grants, &revokes, &net, &heldDelta, &allAdjustments); err != nil || grants != 1 || revokes != 1 || net != 0 || heldDelta != 0 || !allAdjustments {
			t.Fatalf("wallet ledger grants=%d revokes=%d net=%d held=%d adjustments=%v err=%v", grants, revokes, net, heldDelta, allAdjustments, err)
		}
	})
}
