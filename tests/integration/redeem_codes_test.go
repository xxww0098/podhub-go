package integration

import (
	"context"
	"fmt"
	"math"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	adminbillingrepo "github.com/xxww0098/podhub-go/internal/admin/billing/repo"
	admindomain "github.com/xxww0098/podhub-go/internal/admin/domain"
	"github.com/xxww0098/podhub-go/internal/app"
	billingrepo "github.com/xxww0098/podhub-go/internal/billing/repo"
)

func TestRedeemAlongsideWalletMovement(t *testing.T) {
	f := newRedeemFixture(t)
	code := f.create(t)
	tx, err := f.pool.Begin(f.ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(f.ctx)
	if _, err := tx.Exec(f.ctx, `SET LOCAL deadlock_timeout='50ms'`); err != nil {
		t.Fatal(err)
	}
	if _, err := tx.Exec(f.ctx, `SELECT org_id FROM workspace_wallets WHERE org_id=$1 FOR UPDATE`, f.org); err != nil {
		t.Fatal(err)
	}
	done := make(chan *httptest.ResponseRecorder, 1)
	go func() { done <- f.redeem(code.Code) }()
	waitRedeemBlocked(t, f.ctx, f.pool, int32(tx.Conn().PgConn().PID()), "FROM workspace_wallets", 1)

	// A wallet movement already holding the wallet must be able to append its
	// ledger row while redemption is waiting for that same wallet.
	_, moveErr := billingrepo.AdjustTx(f.ctx, tx, f.org, "redeem-concurrent-credit", 200_000_000, "test credit")
	if moveErr == nil {
		moveErr = tx.Commit(f.ctx)
	} else {
		_ = tx.Rollback(f.ctx)
	}
	response := <-done
	if moveErr != nil || response.Code != http.StatusOK {
		t.Fatalf("concurrent wallet movement=%v; redeem=%d %s", moveErr, response.Code, response.Body.String())
	}
	if got := walletBalance(t, f.ctx, f.pool, f.org); got != 300_000_000 {
		t.Fatalf("balance=%d, want both credits (300000000)", got)
	}
	var entries int
	if err := f.pool.QueryRow(f.ctx, `SELECT count(*) FROM wallet_ledger WHERE org_id=$1`, f.org).Scan(&entries); err != nil || entries != 2 {
		t.Fatalf("ledger entries=%d, err=%v", entries, err)
	}
}

func TestRedeemConcurrentCodeHasOneWinner(t *testing.T) {
	f := newRedeemFixture(t)
	code := f.create(t)
	other := f
	other.org, other.user = seedAITenant(t, f.ctx, f.pool, 96293)
	other.token = "redeem-other"
	if _, err := f.pool.Exec(f.ctx, `INSERT INTO account_sessions(token_hash,user_id,expires_at)
		VALUES($1,$2,clock_timestamp()+interval '1 day')`, admindomain.SessionHash(other.token), other.user); err != nil {
		t.Fatal(err)
	}
	if err := f.pool.QueryRow(f.ctx, `SELECT uuid::text FROM organizations WHERE id=$1`, other.org).Scan(&other.workspace); err != nil {
		t.Fatal(err)
	}
	blocker, err := f.pool.Begin(f.ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer blocker.Rollback(f.ctx)
	if _, err := blocker.Exec(f.ctx, `SELECT id FROM redeem_codes WHERE id=$1 FOR UPDATE`, code.ID); err != nil {
		t.Fatal(err)
	}
	responses := make(chan *httptest.ResponseRecorder, 2)
	go func() { responses <- f.redeem(strings.ToLower(code.Code)) }()
	go func() { responses <- other.redeem(code.Code) }()
	waitRedeemBlocked(t, f.ctx, f.pool, 0, "public.billing_lock_redeem_code", 2)
	if err := blocker.Commit(f.ctx); err != nil {
		t.Fatal(err)
	}
	var succeeded, refused int
	for range 2 {
		response := <-responses
		switch response.Code {
		case http.StatusOK:
			succeeded++
		case http.StatusBadRequest:
			refused++
		default:
			t.Errorf("concurrent redemption: %d %s", response.Code, response.Body.String())
		}
	}
	if succeeded != 1 || refused != 1 {
		t.Fatalf("success=%d refused=%d, want exactly one each", succeeded, refused)
	}
	for _, actor := range []redeemFixture{f, other} {
		if response := actor.redeem(code.Code); response.Code != http.StatusBadRequest {
			t.Fatalf("replay: %d %s", response.Code, response.Body.String())
		}
	}
	var used bool
	var usedUser, usedOrg, ledgerOrg, balance int64
	var entries int
	if err := f.pool.QueryRow(f.ctx, `SELECT used,used_by_user_id,used_by_org_id FROM redeem_codes WHERE id=$1`, code.ID).Scan(&used, &usedUser, &usedOrg); err != nil {
		t.Fatal(err)
	}
	if err := f.pool.QueryRow(f.ctx, `SELECT count(*),min(org_id) FROM wallet_ledger WHERE idempotency_key=$1`, fmt.Sprintf("redeem:%d", code.ID)).Scan(&entries, &ledgerOrg); err != nil {
		t.Fatal(err)
	}
	if err := f.pool.QueryRow(f.ctx, `SELECT COALESCE(sum(balance_microfen),0) FROM workspace_wallets WHERE org_id=ANY($1::bigint[])`, []int64{f.org, other.org}).Scan(&balance); err != nil {
		t.Fatal(err)
	}
	if !used || entries != 1 || usedOrg != ledgerOrg || balance != 100_000_000 {
		t.Fatalf("used=%v claimant=%d/%d ledger org=%d entries=%d balance=%d", used, usedUser, usedOrg, ledgerOrg, entries, balance)
	}
	// The winner's workspace holds the whole credit; the loser's workspace is untouched.
	loser := f.org
	if usedOrg == f.org {
		loser = other.org
	}
	var loserBalance int64
	if err := f.pool.QueryRow(f.ctx, `SELECT COALESCE((SELECT balance_microfen FROM workspace_wallets WHERE org_id=$1),0)`, loser).Scan(&loserBalance); err != nil || loserBalance != 0 {
		t.Fatalf("losing workspace balance=%d err=%v", loserBalance, err)
	}
}

func TestRedeemCreditsOnlyTheRedeemingWorkspace(t *testing.T) {
	f := newRedeemFixture(t)
	first, second := f.create(t), f.create(t)
	var siblingOrg int64
	var siblingUUID string
	if err := f.pool.QueryRow(f.ctx, `INSERT INTO organizations (owner_user_id, name, plan, created_at, updated_at)
		VALUES ($1, 'redeem-sibling', 'lite', clock_timestamp(), clock_timestamp()) RETURNING id, uuid::text`, f.user).Scan(&siblingOrg, &siblingUUID); err != nil {
		t.Fatal(err)
	}
	if _, err := billingrepo.Redeem(f.ctx, f.pool, siblingOrg, f.user, first.Code, siblingUUID); err != nil {
		t.Fatal(err)
	}
	if got := walletBalance(t, f.ctx, f.pool, siblingOrg); got != 100_000_000 {
		t.Fatalf("sibling balance=%d, want 100000000", got)
	}
	if got := walletBalance(t, f.ctx, f.pool, f.org); got != 0 {
		t.Fatalf("redeeming into the sibling changed this workspace: balance=%d", got)
	}
	if _, err := billingrepo.Redeem(f.ctx, f.pool, f.org, f.user, second.Code, f.workspace); err != nil {
		t.Fatal(err)
	}
	for org, want := range map[int64]int64{f.org: 100_000_000, siblingOrg: 100_000_000} {
		if got := walletBalance(t, f.ctx, f.pool, org); got != want {
			t.Fatalf("org %d balance=%d, want its own credit %d", org, got, want)
		}
	}
}

func TestRedeemWinsConcurrentDelete(t *testing.T) {
	f := newRedeemFixture(t)
	code := f.create(t)
	blocker, err := f.pool.Begin(f.ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer blocker.Rollback(f.ctx)
	if _, err := blocker.Exec(f.ctx, `SELECT org_id FROM workspace_wallets WHERE org_id=$1 FOR UPDATE`, f.org); err != nil {
		t.Fatal(err)
	}
	redeemed := make(chan *httptest.ResponseRecorder, 1)
	go func() { redeemed <- f.redeem(code.Code) }()
	waitRedeemBlocked(t, f.ctx, f.pool, int32(blocker.Conn().PgConn().PID()), "FROM workspace_wallets", 1)
	managed := make(chan *httptest.ResponseRecorder, 1)
	go func() { managed <- f.delete(code.ID, "redeem-admin") }()
	waitRedeemBlocked(t, f.ctx, f.pool, 0, "DELETE FROM redeem_codes", 1)
	if err := blocker.Commit(f.ctx); err != nil {
		t.Fatal(err)
	}
	if response := <-redeemed; response.Code != http.StatusOK {
		t.Fatalf("redeem: %d %s", response.Code, response.Body.String())
	}
	if response := <-managed; response.Code != http.StatusConflict {
		t.Fatalf("delete won after redemption: %d %s", response.Code, response.Body.String())
	}
	var valid bool
	if err := f.pool.QueryRow(f.ctx, `SELECT used AND revoked_at IS NULL FROM redeem_codes WHERE id=$1`, code.ID).Scan(&valid); err != nil || !valid {
		t.Fatalf("consumed code removed or revoked: valid=%v err=%v", valid, err)
	}
	if got := walletBalance(t, f.ctx, f.pool, f.org); got != 100_000_000 {
		t.Fatalf("balance=%d", got)
	}
}

func TestRedeemDeleteRequiresSuperAdmin(t *testing.T) {
	f := newRedeemFixture(t)
	code := f.create(t)
	for _, request := range []struct {
		token  string
		status int
	}{{"", http.StatusUnauthorized}, {"redeem-owner", http.StatusForbidden}} {
		if response := f.delete(code.ID, request.token); response.Code != request.status {
			t.Fatalf("delete as %q: %d %s", request.token, response.Code, response.Body.String())
		}
	}
	var remaining int
	if err := f.pool.QueryRow(f.ctx, `SELECT count(*) FROM redeem_codes WHERE id=$1`, code.ID).Scan(&remaining); err != nil || remaining != 1 {
		t.Fatalf("refused delete changed code: remaining=%d err=%v", remaining, err)
	}
	if response := f.delete(code.ID, "redeem-admin"); response.Code != http.StatusOK {
		t.Fatalf("authorized delete: %d %s", response.Code, response.Body.String())
	}
	if response := f.delete(code.ID, "redeem-admin"); response.Code != http.StatusNotFound {
		t.Fatalf("replayed delete: %d %s", response.Code, response.Body.String())
	}
	var audits int
	if err := f.pool.QueryRow(f.ctx, `SELECT count(*) FROM audit_logs
		WHERE action='redeem_code_deleted' AND user_id=96292 AND message NOT LIKE '%POD-%'`).Scan(&audits); err != nil || audits != 1 {
		t.Fatalf("delete audits=%d err=%v", audits, err)
	}
}

func TestRedeemRefusalsAreAtomic(t *testing.T) {
	for _, state := range []string{"expired", "revoked", "deleted", "wrong workspace", "dissolved", "wallet overflow"} {
		t.Run(state, func(t *testing.T) {
			f := newRedeemFixture(t)
			code := f.create(t)
			wantStatus := http.StatusBadRequest
			var wantBalance int64
			var err error
			switch state {
			case "expired":
				_, err = f.pool.Exec(f.ctx, `UPDATE redeem_codes SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1`, code.ID)
			case "revoked":
				_, err = adminbillingrepo.NewEntitlement(f.pool).RevokeRedeem(f.ctx, admindomain.Actor{UserID: 96292, OrgID: f.org}, code.ID)
			case "deleted":
				if response := f.delete(code.ID, "redeem-admin"); response.Code != http.StatusOK {
					t.Fatalf("delete: %d %s", response.Code, response.Body.String())
				}
			case "wrong workspace":
				f.workspace = "00000000-0000-0000-0000-000000000000"
				wantStatus = http.StatusConflict
			case "dissolved":
				_, err = f.pool.Exec(f.ctx, `UPDATE organizations SET dissolved_at=clock_timestamp() WHERE id=$1`, f.org)
				wantStatus = http.StatusForbidden
			case "wallet overflow":
				wantBalance = math.MaxInt64
				_, err = f.pool.Exec(f.ctx, `UPDATE workspace_wallets SET balance_microfen=$2 WHERE org_id=$1`, f.org, wantBalance)
				wantStatus = http.StatusInternalServerError
			}
			if err != nil {
				t.Fatal(err)
			}
			if response := f.redeem(code.Code); response.Code != wantStatus {
				t.Fatalf("%s: %d %s, want %d", state, response.Code, response.Body.String(), wantStatus)
			}
			var used, entries int
			if err := f.pool.QueryRow(f.ctx, `SELECT count(*) FROM redeem_codes WHERE id=$1 AND used`, code.ID).Scan(&used); err != nil {
				t.Fatal(err)
			}
			if err := f.pool.QueryRow(f.ctx, `SELECT count(*) FROM wallet_ledger WHERE org_id=$1`, f.org).Scan(&entries); err != nil {
				t.Fatal(err)
			}
			if balance := walletBalance(t, f.ctx, f.pool, f.org); balance != wantBalance || used != 0 || entries != 0 {
				t.Fatalf("rejected code wrote balance=%d used=%d entries=%d", balance, used, entries)
			}
			if state == "wallet overflow" {
				if _, err := f.pool.Exec(f.ctx, `UPDATE workspace_wallets SET balance_microfen=0 WHERE org_id=$1`, f.org); err != nil {
					t.Fatal(err)
				}
				if response := f.redeem(code.Code); response.Code != http.StatusOK {
					t.Fatalf("retry after rollback: %d %s", response.Code, response.Body.String())
				}
			}
		})
	}
}

func TestRedeemExpiryCheckedAfterCodeLock(t *testing.T) {
	f := newRedeemFixture(t)
	code := f.create(t)
	blocker, err := f.pool.Begin(f.ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer blocker.Rollback(f.ctx)
	if _, err := blocker.Exec(f.ctx, `SELECT id FROM redeem_codes WHERE id=$1 FOR UPDATE`, code.ID); err != nil {
		t.Fatal(err)
	}
	done := make(chan *httptest.ResponseRecorder, 1)
	go func() { done <- f.redeem(code.Code) }()
	waitRedeemBlocked(t, f.ctx, f.pool, int32(blocker.Conn().PgConn().PID()), "public.billing_lock_redeem_code", 1)
	if _, err := blocker.Exec(f.ctx, `UPDATE redeem_codes SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1`, code.ID); err != nil {
		t.Fatal(err)
	}
	if err := blocker.Commit(f.ctx); err != nil {
		t.Fatal(err)
	}
	if response := <-done; response.Code != http.StatusBadRequest || !strings.Contains(response.Body.String(), "兑换码已过期") {
		t.Fatalf("expired while waiting: %d %s", response.Code, response.Body.String())
	}
	if balance := walletBalance(t, f.ctx, f.pool, f.org); balance != 0 {
		t.Fatalf("expired code credited %d", balance)
	}
}

type redeemFixture struct {
	ctx       context.Context
	pool      *pgxpool.Pool
	handler   http.Handler
	user, org int64
	workspace string
	token     string
}

func newRedeemFixture(t *testing.T) redeemFixture {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
	t.Cleanup(cancel)
	pool := migratedPool(t, ctx)
	org, user := seedAITenant(t, ctx, pool, 96291)
	_, admin := seedAITenant(t, ctx, pool, 96292)
	if _, err := pool.Exec(ctx, `UPDATE account_users SET role='super_admin' WHERE id=$1`, admin); err != nil {
		t.Fatal(err)
	}
	for _, account := range []struct {
		user  int64
		token string
	}{{user, "redeem-owner"}, {admin, "redeem-admin"}} {
		if _, err := pool.Exec(ctx, `INSERT INTO account_sessions(token_hash,user_id,expires_at)
			VALUES($1,$2,clock_timestamp()+interval '1 day')`, admindomain.SessionHash(account.token), account.user); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := pool.Exec(ctx, `INSERT INTO workspace_wallets(org_id) VALUES($1)`, org); err != nil {
		t.Fatal(err)
	}
	seedMatchingLease(t, ctx, pool, "admin", "redeem codes test")
	f := redeemFixture{ctx: ctx, pool: pool, handler: app.Handler(pool), user: user, org: org, token: "redeem-owner"}
	if err := pool.QueryRow(ctx, `SELECT uuid::text FROM organizations WHERE id=$1`, org).Scan(&f.workspace); err != nil {
		t.Fatal(err)
	}
	return f
}

func (f redeemFixture) create(t *testing.T) issuedCode {
	t.Helper()
	response := adminPost(f.handler, "redeem-admin", "/api/admin/redeem-codes", `{"wallet_cents":100,"quantity":1}`)
	if response.Code != http.StatusCreated {
		t.Fatalf("create code: %d %s", response.Code, response.Body.String())
	}
	codes := decodeCodes(t, response.Body.Bytes())
	if len(codes) != 1 {
		t.Fatalf("created codes=%d, want 1", len(codes))
	}
	return codes[0]
}

func (f redeemFixture) redeem(code string) *httptest.ResponseRecorder {
	body := fmt.Sprintf(`{"code":%q,"expected_workspace_uuid":%q}`, code, f.workspace)
	req := httptest.NewRequest(http.MethodPost, "/api/redeem", strings.NewReader(body)).WithContext(f.ctx)
	req.Header.Set("Authorization", "Bearer "+f.token)
	req.Header.Set("Content-Type", "application/json")
	response := httptest.NewRecorder()
	f.handler.ServeHTTP(response, req)
	return response
}

func (f redeemFixture) delete(id int64, token string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(http.MethodDelete, fmt.Sprintf("/api/admin/redeem-codes/%d", id), nil).WithContext(f.ctx)
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	response := httptest.NewRecorder()
	f.handler.ServeHTTP(response, req)
	return response
}

func waitRedeemBlocked(t *testing.T, ctx context.Context, pool *pgxpool.Pool, blocker int32, query string, count int) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for {
		var waiting int
		if err := pool.QueryRow(ctx, `SELECT count(*) FROM pg_stat_activity
			WHERE datname=current_database() AND wait_event_type='Lock'
			  AND ($1=0 OR $1=ANY(pg_blocking_pids(pid))) AND query LIKE '%'||$2||'%'`, blocker, query).Scan(&waiting); err != nil {
			t.Fatal(err)
		}
		if waiting == count {
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("redeem did not wait on %q", query)
		}
		time.Sleep(10 * time.Millisecond)
	}
}
