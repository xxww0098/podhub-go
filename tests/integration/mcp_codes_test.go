package integration

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/xxww0098/podhub-go/internal/admin/domain"
	"github.com/xxww0098/podhub-go/internal/app"
)

func TestMCPCodesMatchAdmin(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Minute)
	defer cancel()
	pool := migratedPool(t, ctx)
	t.Setenv("CLOUD_MCP_ALLOWED_HOSTS", "localhost")
	t.Setenv("CLOUD_MCP_ALLOWED_ORIGINS", "")

	// account_users_single_super_admin allows one super_admin row. The
	// missing-totp, missing-step-up, and expired cases mutate that row.
	if _, err := pool.Exec(ctx, `
		DELETE FROM account_sessions WHERE user_id IN (89101, 89102, 89103);
		DELETE FROM account_users WHERE id IN (89101, 89102, 89103)`); err != nil {
		t.Fatal(err)
	}
	type account struct {
		id    int64
		email string
		role  string
		token string
		totp  bool
		step  string
	}
	const superToken = "mcp-code-super"
	accounts := []account{
		{89101, "mcp-code-super@example.invalid", "super_admin", superToken, true, "clock_timestamp() + interval '10 minutes'"},
		{89102, "mcp-code-member@example.invalid", "user", "mcp-code-member", false, "NULL"},
		{89103, "mcp-code-staff@example.invalid", "admin", "mcp-code-staff", true, "clock_timestamp() + interval '10 minutes'"},
	}
	for _, item := range accounts {
		if _, err := pool.Exec(ctx, `
			INSERT INTO account_users (id, public_id, email, password_hash, role, name, target, supplier_id, plan, created_at, updated_at)
			VALUES ($1, $2, $3, 'x', $4, 'MCP', '/workspace', '', 'free', clock_timestamp(), clock_timestamp())`,
			item.id, item.email, item.email, item.role); err != nil {
			t.Fatal(err)
		}
		query := fmt.Sprintf(`
			INSERT INTO account_sessions (token_hash, user_id, expires_at, admin_step_up_until)
			VALUES ($1, $2, clock_timestamp() + interval '1 day', %s)`, item.step)
		if _, err := pool.Exec(ctx, query, domain.SessionHash(item.token), item.id); err != nil {
			t.Fatal(err)
		}
		if item.totp {
			if _, err := pool.Exec(ctx, `
				INSERT INTO account_admin_totp (user_id, secret_nonce, secret_ciphertext, confirmed_at)
				VALUES ($1, decode('00112233445566778899aabb', 'hex'), decode('00112233445566778899aabbccddeeff00', 'hex'), clock_timestamp())`, item.id); err != nil {
				t.Fatal(err)
			}
		}
	}
	seedMatchingLease(t, ctx, pool, "admin", "mcp code test")
	t.Cleanup(func() {
		_, _ = pool.Exec(context.Background(), `DELETE FROM writer_leases WHERE domain = 'admin' AND grant_reason = 'mcp code test'`)
	})

	handler := app.Handler(pool)
	var before int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM redeem_codes`).Scan(&before); err != nil {
		t.Fatal(err)
	}

	denied := []struct {
		name, token, tool, body, want string
	}{
		{"member", "mcp-code-member", "generateActivationCodes", seatBody, "需要超级管理员权限"},
		{"staff", "mcp-code-staff", "generateQuotaCards", walletBody, "需要超级管理员权限"},
		{"quantity", superToken, "generateQuotaCards", walletTooMany, "兑换码数量需在 1-500 之间"},
		{"bad tier", superToken, "generateActivationCodes", seatBadTier, "成员名额档位无效"},
	}
	for _, tc := range denied {
		t.Run(tc.name, func(t *testing.T) {
			rec := mcpCall(handler, tc.token, tc.tool, tc.body)
			if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), tc.want) || !strings.Contains(rec.Body.String(), `"isError":true`) {
				t.Fatalf("%d %s", rec.Code, rec.Body.String())
			}
		})
	}
	noToken := mcpCall(handler, "", "generateActivationCodes", seatBody)
	if noToken.Code != http.StatusUnauthorized {
		t.Fatalf("no token %d %s", noToken.Code, noToken.Body.String())
	}
	if _, err := pool.Exec(ctx, `DELETE FROM account_admin_totp WHERE user_id = 89101`); err != nil {
		t.Fatal(err)
	}
	noTotp := mcpCall(handler, superToken, "generateActivationCodes", seatBody)
	if noTotp.Code != http.StatusOK || !strings.Contains(noTotp.Body.String(), "请先绑定验证器") || !strings.Contains(noTotp.Body.String(), `"isError":true`) {
		t.Fatalf("no totp %d %s", noTotp.Code, noTotp.Body.String())
	}
	if _, err := pool.Exec(ctx, `
		INSERT INTO account_admin_totp (user_id, secret_nonce, secret_ciphertext, confirmed_at)
		VALUES (89101, decode('00112233445566778899aabb', 'hex'), decode('00112233445566778899aabbccddeeff00', 'hex'), clock_timestamp())`); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `UPDATE account_sessions SET admin_step_up_until = clock_timestamp() - interval '1 minute' WHERE user_id = 89101`); err != nil {
		t.Fatal(err)
	}
	noStep := mcpCall(handler, superToken, "generateQuotaCards", walletBody)
	if noStep.Code != http.StatusOK || !strings.Contains(noStep.Body.String(), "管理操作需要重新验证") || !strings.Contains(noStep.Body.String(), `"isError":true`) {
		t.Fatalf("no step-up %d %s", noStep.Code, noStep.Body.String())
	}
	if _, err := pool.Exec(ctx, `UPDATE account_sessions SET admin_step_up_until = clock_timestamp() + interval '10 minutes' WHERE user_id = 89101`); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `UPDATE account_sessions SET expires_at = clock_timestamp() - interval '1 minute' WHERE user_id = 89101`); err != nil {
		t.Fatal(err)
	}
	expired := mcpCall(handler, superToken, "listRedeemCodes", `{}`)
	if expired.Code != http.StatusUnauthorized {
		t.Fatalf("expired %d %s", expired.Code, expired.Body.String())
	}
	if _, err := pool.Exec(ctx, `UPDATE account_sessions SET expires_at = clock_timestamp() + interval '1 day' WHERE user_id = 89101`); err != nil {
		t.Fatal(err)
	}
	var mid int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM redeem_codes`).Scan(&mid); err != nil || mid != before {
		t.Fatalf("rejected calls wrote codes %d -> %d (%v)", before, mid, err)
	}

	adminQty := adminPost(handler, "mcp-code-super", "/api/admin/redeem-codes", walletTooMany)
	if adminQty.Code != http.StatusBadRequest || !strings.Contains(adminQty.Body.String(), "兑换码数量需在 1-500 之间") {
		t.Fatalf("admin quantity %d %s", adminQty.Code, adminQty.Body.String())
	}

	var buf bytes.Buffer
	prev := slog.Default()
	slog.SetDefault(slog.New(slog.NewTextHandler(&buf, nil)))
	t.Cleanup(func() { slog.SetDefault(prev) })

	pairs := []struct {
		name, tool, body, prefix string
	}{
		{"activation", "generateActivationCodes", seatBody, "POD-PLAN-"},
		{"quota", "generateQuotaCards", walletBody, "POD-WALLET-"},
	}
	var plains []string
	for _, pair := range pairs {
		t.Run(pair.name, func(t *testing.T) {
			adminRec := adminPost(handler, "mcp-code-super", "/api/admin/redeem-codes", pair.body)
			mcpRec := mcpCall(handler, "mcp-code-super", pair.tool, pair.body)
			if adminRec.Code != http.StatusCreated || mcpRec.Code != http.StatusOK {
				t.Fatalf("admin %d %s\nmcp %d %s", adminRec.Code, adminRec.Body.String(), mcpRec.Code, mcpRec.Body.String())
			}
			adminCodes := decodeCodes(t, adminRec.Body.Bytes())
			mcpCodes := decodeCodes(t, structured(t, mcpRec.Body.Bytes()))
			if len(adminCodes) == 0 || len(adminCodes) != len(mcpCodes) {
				t.Fatalf("len admin %d mcp %d", len(adminCodes), len(mcpCodes))
			}
			for i := range adminCodes {
				if !strings.HasPrefix(adminCodes[i].Code, pair.prefix) || !strings.HasPrefix(mcpCodes[i].Code, pair.prefix) {
					t.Fatalf("prefix %s %s", adminCodes[i].Code, mcpCodes[i].Code)
				}
				plains = append(plains, adminCodes[i].Code, mcpCodes[i].Code)
				adminCodes[i].ID, mcpCodes[i].ID = 0, 0
				adminCodes[i].Code, mcpCodes[i].Code = "", ""
				adminCodes[i].BatchID, mcpCodes[i].BatchID = "", ""
				if adminCodes[i] != mcpCodes[i] {
					t.Fatalf("admin %#v\nmcp %#v", adminCodes[i], mcpCodes[i])
				}
			}
		})
	}
	listMCP := mcpCall(handler, "mcp-code-super", "listRedeemCodes", `{}`)
	listStatus, listAdmin := adminDo(handler, http.MethodGet, "/api/admin/redeem-codes", "mcp-code-super", "")
	if listMCP.Code != http.StatusOK || listStatus != http.StatusOK {
		t.Fatalf("list mcp %d admin %d %s", listMCP.Code, listStatus, listAdmin)
	}
	for _, plain := range plains {
		if strings.Contains(listMCP.Body.String(), plain) || strings.Contains(listAdmin, plain) || strings.Contains(buf.String(), plain) {
			t.Fatal("plaintext leaked")
		}
	}
	if !strings.Contains(listMCP.Body.String(), "••••-") || !strings.Contains(listAdmin, "••••-") {
		t.Fatal("missing preview")
	}
	var audits int
	if err := pool.QueryRow(ctx, `
		SELECT count(*) FROM audit_logs
		WHERE user_id = 89101 AND action = 'redeem_codes_created' AND message NOT LIKE '%POD-%'`).Scan(&audits); err != nil || audits != 4 {
		t.Fatalf("audits %d %v", audits, err)
	}
	var leaked int
	if err := pool.QueryRow(ctx, `
		SELECT count(*) FROM audit_logs
		WHERE user_id = 89101 AND (message LIKE '%POD-PLAN-%' OR message LIKE '%POD-WALLET-%')`).Scan(&leaked); err != nil || leaked != 0 {
		t.Fatalf("audit leaked %d %v", leaked, err)
	}
}

const (
	seatBody      = `{"product":"member_seats","member_seats":2,"tier":"max","quantity":2,"duration_days":45,"expires_at":"2030-06-01T00:00:00Z"}`
	walletBody    = `{"product":"wallet_credits","member_seats":0,"wallet_cents":2500,"quantity":1,"duration_days":30,"expires_at":"2030-06-01T00:00:00Z"}`
	walletTooMany = `{"product":"wallet_credits","member_seats":0,"wallet_cents":100,"quantity":501,"duration_days":30}`
	seatBadTier   = `{"product":"member_seats","member_seats":1,"tier":"lite","quantity":1,"duration_days":30}`
)

func mcpCall(h http.Handler, token, tool, args string) *httptest.ResponseRecorder {
	body := `{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"` + tool + `","arguments":` + args + `}}`
	req := httptest.NewRequest(http.MethodPost, "/mcp", strings.NewReader(body))
	req.Host = "localhost"
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec
}

func adminPost(h http.Handler, token, path, body string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(http.MethodPost, path, strings.NewReader(body))
	req.Header.Set("Authorization", "Bearer "+token)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec
}

type issuedCode struct {
	ID           int64  `json:"id"`
	Code         string `json:"code"`
	Plan         string `json:"plan"`
	PlanName     string `json:"plan_name"`
	Product      string `json:"product"`
	MemberSeats  int64  `json:"member_seats"`
	Tier         string `json:"tier"`
	OcrCredits   int64  `json:"ocr_credits"`
	WalletCents  int64  `json:"wallet_cents"`
	DurationDays int32  `json:"duration_days"`
	BatchID      string `json:"batch_id"`
	ExpiresAt    string `json:"expires_at"`
}

func decodeCodes(t *testing.T, body []byte) []issuedCode {
	t.Helper()
	var env struct {
		Data struct {
			Codes []issuedCode `json:"codes"`
		} `json:"data"`
	}
	if err := json.Unmarshal(body, &env); err != nil {
		t.Fatal(err)
	}
	return env.Data.Codes
}

func structured(t *testing.T, body []byte) []byte {
	t.Helper()
	var env struct {
		Result struct {
			Structured json.RawMessage `json:"structuredContent"`
			IsError    bool            `json:"isError"`
		} `json:"result"`
	}
	if err := json.Unmarshal(body, &env); err != nil || env.Result.IsError {
		t.Fatalf("%v %s", err, body)
	}
	return env.Result.Structured
}
