package integration

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/xxww0098/podhub-go/internal/app"
)

func TestAdminUsersAIAuth(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Minute)
	defer cancel()
	pool := migratedPool(t, ctx)
	seedMatchingLease(t, ctx, pool, "auth", "admin users test")
	seedMatchingLease(t, ctx, pool, "admin", "admin users test")
	t.Setenv("CLOUD_INTEGRATION_CONFIG_KEY", "admin-b-integration-key-32-characters")
	t.Setenv("CLOUD_AI_EGRESS_ALLOW_LOOPBACK", "1")

	var superID int64
	if err := pool.QueryRow(ctx, `
		INSERT INTO account_users
		    (public_id, email, password_hash, role, name, target, supplier_id, plan, created_at, updated_at)
		VALUES ('00000000-0000-4000-8000-0000000000b1', 'admin-b-super@example.invalid', 'x', 'super_admin', 'Super', '/workspace', '', 'lite', clock_timestamp(), clock_timestamp())
		RETURNING id`).Scan(&superID); err != nil {
		t.Fatal(err)
	}
	const token = "admin-b-super-token"
	hash := adminTokenHash(token)
	if _, err := pool.Exec(ctx, `
		INSERT INTO account_sessions (token_hash, user_id, expires_at)
		VALUES ($1, $2, clock_timestamp() + interval '8 hours')`, hash, superID); err != nil {
		t.Fatal(err)
	}
	handler := app.Handler(pool)

	anon := usersDo(handler, http.MethodGet, "/api/admin/users", "", "")
	if anon.Code != http.StatusUnauthorized || !strings.Contains(anon.Body.String(), `"code":"AUTH_INVALID"`) || !strings.Contains(anon.Body.String(), "未登录") {
		t.Fatalf("anon users %d %s", anon.Code, anon.Body.String())
	}
	aiAnon := usersDo(handler, http.MethodGet, "/api/admin/ai-requests", "", "")
	if aiAnon.Code != http.StatusUnauthorized || !strings.Contains(aiAnon.Body.String(), `"code":"AUTH_REQUIRED"`) {
		t.Fatalf("anon ai %d %s", aiAnon.Code, aiAnon.Body.String())
	}

	listed := usersDo(handler, http.MethodGet, "/api/admin/users", "", token)
	if listed.Code != http.StatusOK || !strings.Contains(listed.Body.String(), "admin-b-super@example.invalid") {
		t.Fatalf("list %d %s", listed.Code, listed.Body.String())
	}
	var audits int64
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM audit_logs WHERE action = 'accounts_listed'`).Scan(&audits); err != nil || audits != 1 {
		t.Fatalf("listed audits %d %v", audits, err)
	}

	badPass := usersDo(handler, http.MethodPost, "/api/admin/users", `{"email":"short@example.invalid","password":"short"}`, token)
	if badPass.Code != http.StatusBadRequest || !strings.Contains(badPass.Body.String(), "邮箱或密码不符合要求") {
		t.Fatalf("bad password %d %s", badPass.Code, badPass.Body.String())
	}
	missing := usersDo(handler, http.MethodPost, "/api/admin/users", `{"email":"a@b.c"}`, token)
	if missing.Code != http.StatusBadRequest || !strings.Contains(missing.Body.String(), "请求格式无效") {
		t.Fatalf("missing password %d %s", missing.Code, missing.Body.String())
	}
	created := usersDo(handler, http.MethodPost, "/api/admin/users", `{"email":" Ada@Example.invalid ","password":"correct-horse","name":"Ada","role":"user"}`, token)
	if created.Code != http.StatusCreated || !strings.Contains(created.Body.String(), `"email":"ada@example.invalid"`) || !strings.Contains(created.Body.String(), `"name":"Ada"`) {
		t.Fatalf("create %d %s", created.Code, created.Body.String())
	}
	user := jsonData(t, created.Body.Bytes())["user"].(map[string]any)
	userUUID, _ := user["uuid"].(string)
	if userUUID == "" {
		t.Fatal(created.Body.String())
	}
	dup := usersDo(handler, http.MethodPost, "/api/admin/users", `{"email":"ada@example.invalid","password":"correct-horse"}`, token)
	if dup.Code != http.StatusConflict || !strings.Contains(dup.Body.String(), "邮箱已注册") {
		t.Fatalf("dup %d %s", dup.Code, dup.Body.String())
	}

	var userID, orgID int64
	var orgUUID, orgName string
	if err := pool.QueryRow(ctx, `
		SELECT u.id, o.id, lower(o.uuid::text), o.name
		FROM account_users u
		JOIN organizations o ON o.owner_user_id = u.id
		WHERE u.email = 'ada@example.invalid'`).Scan(&userID, &orgID, &orgUUID, &orgName); err != nil {
		t.Fatal(err)
	}
	if orgName != "Ada 的工作空间" {
		t.Fatal(orgName)
	}
	var bound int64
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM audit_logs WHERE action = 'account_created' AND entity_id = $1`, userUUID).Scan(&bound); err != nil || bound != 1 {
		t.Fatalf("created audit %d %v", bound, err)
	}

	memberToken := "admin-b-member-token"
	if _, err := pool.Exec(ctx, `
		INSERT INTO account_sessions (token_hash, user_id, expires_at)
		VALUES ($1, $2, clock_timestamp() + interval '7 days')`, adminTokenHash(memberToken), userID); err != nil {
		t.Fatal(err)
	}
	staff := usersDo(handler, http.MethodGet, "/api/admin/users", "", memberToken)
	if staff.Code != http.StatusForbidden || !strings.Contains(staff.Body.String(), "需要超级管理员权限") {
		t.Fatalf("member %d %s", staff.Code, staff.Body.String())
	}

	last := usersDo(handler, http.MethodPost, "/api/admin/users/00000000-0000-4000-8000-0000000000b1/status", `{"enabled":false}`, token)
	if last.Code != http.StatusForbidden || !strings.Contains(last.Body.String(), "不能移除最后一个超级管理员") {
		t.Fatalf("last super %d %s", last.Code, last.Body.String())
	}
	noBool := usersDo(handler, http.MethodPost, "/api/admin/users/"+userUUID+"/status", `{}`, token)
	if noBool.Code != http.StatusBadRequest || !strings.Contains(noBool.Body.String(), "请求格式无效") {
		t.Fatalf("missing enabled %d %s", noBool.Code, noBool.Body.String())
	}
	off := usersDo(handler, http.MethodPost, "/api/admin/users/"+userUUID+"/status", `{"enabled":false}`, token)
	if off.Code != http.StatusOK || !strings.Contains(off.Body.String(), `"disabled":true`) {
		t.Fatalf("disable %d %s", off.Code, off.Body.String())
	}
	on := usersDo(handler, http.MethodPost, "/api/admin/users/"+userUUID+"/status", `{"enabled":true}`, token)
	if on.Code != http.StatusOK || !strings.Contains(on.Body.String(), `"status":"active"`) {
		t.Fatalf("enable %d %s", on.Code, on.Body.String())
	}
	role := usersDo(handler, http.MethodPost, "/api/admin/users/"+userUUID+"/admin", `{"role":"admin"}`, token)
	if role.Code != http.StatusOK || !strings.Contains(role.Body.String(), `"role":"admin"`) {
		t.Fatalf("role %d %s", role.Code, role.Body.String())
	}
	back := usersDo(handler, http.MethodPost, "/api/admin/users/"+userUUID+"/admin", `{"role":"user"}`, token)
	if back.Code != http.StatusOK || !strings.Contains(back.Body.String(), `"role":"user"`) {
		t.Fatalf("role back %d %s", back.Code, back.Body.String())
	}

	reset := usersDo(handler, http.MethodPost, "/api/admin/users/"+userUUID+"/password", `{"password":"  another-password  "}`, token)
	if reset.Code != http.StatusOK || !strings.Contains(reset.Body.String(), `"ok":true`) {
		t.Fatalf("reset %d %s", reset.Code, reset.Body.String())
	}
	var sessions int64
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM account_sessions WHERE user_id = $1`, userID).Scan(&sessions); err != nil || sessions != 0 {
		t.Fatalf("sessions after reset %d %v", sessions, err)
	}
	gone := usersDo(handler, http.MethodGet, "/api/admin/users", "", memberToken)
	if gone.Code != http.StatusUnauthorized {
		t.Fatalf("revoked session %d %s", gone.Code, gone.Body.String())
	}

	var firstJoiner, secondJoiner int64
	for i, target := range []*int64{&firstJoiner, &secondJoiner} {
		var joinerUser int64
		if err := pool.QueryRow(ctx, `
			INSERT INTO account_users (public_id, email, password_hash, role, name, target, supplier_id, plan, created_at, updated_at)
			VALUES ($1::text, $1::text || '@example.invalid', 'x', 'user', 'joiner', '/workspace', '', 'lite', clock_timestamp(), clock_timestamp())
			RETURNING id`, "seat-joiner-"+strconv.Itoa(i)).Scan(&joinerUser); err != nil {
			t.Fatal(err)
		}
		*target = seedCompanyMember(t, ctx, pool, orgID, joinerUser, "member", i+2)
	}
	memberState := func(membership int64) (suspended bool) {
		t.Helper()
		if err := pool.QueryRow(ctx, `SELECT quota_suspended FROM organization_members WHERE id = $1`, membership).Scan(&suspended); err != nil {
			t.Fatal(err)
		}
		return suspended
	}
	overrideState := func() (override *int64, revision int64) {
		t.Helper()
		if err := pool.QueryRow(ctx, `SELECT member_seat_limit_override, quota_revision FROM organizations WHERE id = $1`, orgID).Scan(&override, &revision); err != nil {
			t.Fatal(err)
		}
		return override, revision
	}
	var ownerSuspended bool
	_, revision := overrideState()

	for _, bad := range []string{`{"seats":0}`, `{"seats":11}`, `{"seats":"3"}`, `{}`, `{"seats":2,"store_limit":9}`} {
		rejected := usersDo(handler, http.MethodPost, "/api/admin/users/"+userUUID+"/seats", bad, token)
		if rejected.Code != http.StatusBadRequest {
			t.Fatalf("seats %s -> %d %s", bad, rejected.Code, rejected.Body.String())
		}
	}
	if override, got := overrideState(); override != nil || got != revision {
		t.Fatalf("rejected seats changed the workspace: override=%v revision=%d", override, got)
	}

	// Cap 1: the owner stays, every joiner is suspended.
	seats := usersDo(handler, http.MethodPost, "/api/admin/users/"+userUUID+"/seats", `{"seats":1}`, token)
	if seats.Code != http.StatusOK || !strings.Contains(seats.Body.String(), `"seat_limit":1`) {
		t.Fatalf("seats %d %s", seats.Code, seats.Body.String())
	}
	if override, got := overrideState(); override == nil || *override != 1 || got != revision+1 {
		t.Fatalf("override after seats=1: %v revision=%d want 1/%d", override, got, revision+1)
	}
	if err := pool.QueryRow(ctx, `SELECT quota_suspended FROM organization_members WHERE org_id = $1 AND role = 'owner'`, orgID).Scan(&ownerSuspended); err != nil || ownerSuspended {
		t.Fatalf("owner must never be quota-suspended: %v %v", ownerSuspended, err)
	}
	if !memberState(firstJoiner) || !memberState(secondJoiner) {
		t.Fatal("seats=1 must suspend both joiners")
	}

	// Cap 2: joiners are admitted in join order, so only the first returns.
	seats = usersDo(handler, http.MethodPost, "/api/admin/users/"+userUUID+"/seats", `{"seats":2}`, token)
	if seats.Code != http.StatusOK || !strings.Contains(seats.Body.String(), `"seat_limit":2`) {
		t.Fatalf("seats %d %s", seats.Code, seats.Body.String())
	}
	if memberState(firstJoiner) || !memberState(secondJoiner) {
		t.Fatalf("seats=2 must keep the first joiner and suspend the second: first=%v second=%v", memberState(firstJoiner), memberState(secondJoiner))
	}

	// null clears the override: the workspace follows the global cap again.
	cleared := usersDo(handler, http.MethodPost, "/api/admin/users/"+userUUID+"/seats", `{"seats":null}`, token)
	if cleared.Code != http.StatusOK || !strings.Contains(cleared.Body.String(), `"seat_limit":10`) {
		t.Fatalf("clear seats %d %s", cleared.Code, cleared.Body.String())
	}
	if override, got := overrideState(); override != nil || got != revision+3 {
		t.Fatalf("override after clear: %v revision=%d want nil/%d", override, got, revision+3)
	}
	if memberState(firstJoiner) || memberState(secondJoiner) {
		t.Fatal("following the global cap must restore every joiner")
	}
	var applied int64
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM audit_logs WHERE action = 'account_member_seats_applied' AND entity_id = $1 AND api_path = $2`, userUUID, "/api/admin/users/"+userUUID+"/seats").Scan(&applied); err != nil || applied != 3 {
		t.Fatalf("seat audits %d %v", applied, err)
	}
	for _, retired := range []string{"preview", "apply"} {
		gone := usersDo(handler, http.MethodPost, "/api/admin/users/"+userUUID+"/member-seats/"+retired, `{}`, token)
		if gone.Code != http.StatusNotFound && gone.Code != http.StatusMethodNotAllowed {
			t.Fatalf("retired member-seats/%s still answers %d %s", retired, gone.Code, gone.Body.String())
		}
	}

	grants := usersDo(handler, http.MethodGet, "/api/admin/support-grants?org_id=0", "", token)
	if grants.Code != http.StatusBadRequest || !strings.Contains(grants.Body.String(), "org_id 无效") {
		t.Fatalf("grants query %d %s", grants.Code, grants.Body.String())
	}
	issued := usersDo(handler, http.MethodPost, "/api/admin/support-grants", `{"org_id":`+strconv.FormatInt(orgID, 10)+`,"reason":"  代操作  "}`, token)
	if issued.Code != http.StatusOK || !strings.Contains(issued.Body.String(), `"live":true`) {
		t.Fatalf("issue %d %s", issued.Code, issued.Body.String())
	}
	leases := usersDo(handler, http.MethodGet, "/api/admin/writer-leases", "", token)
	if leases.Code != http.StatusOK || strings.Count(leases.Body.String(), `"domain"`) < 7 {
		t.Fatalf("leases %d %s", leases.Code, leases.Body.String())
	}
	badHolder := usersDo(handler, http.MethodPost, "/api/admin/writer-leases", `{"domain":"catalog","holder":"go","holderInstance":"box","reason":"take"}`, token)
	if badHolder.Code != http.StatusBadRequest || !strings.Contains(badHolder.Body.String(), "holder must be axum or hono") {
		t.Fatalf("holder %d %s", badHolder.Code, badHolder.Body.String())
	}
	granted := usersDo(handler, http.MethodPost, "/api/admin/writer-leases", `{"domain":"catalog","holder":"hono","holderInstance":"box","reason":"take"}`, token)
	if granted.Code != http.StatusOK || !strings.Contains(granted.Body.String(), `"authorityReleased":true`) {
		t.Fatalf("grant %d %s", granted.Code, granted.Body.String())
	}
	fence := int64(jsonData(t, granted.Body.Bytes())["lease"].(map[string]any)["fenceToken"].(float64))
	mismatch := usersDo(handler, http.MethodPost, "/api/admin/writer-leases",
		`{"domain":"catalog","holder":"axum","holderInstance":"other","reason":"steal","expectedFence":`+strconv.FormatInt(fence+1, 10)+`}`, token)
	if mismatch.Code != http.StatusConflict || !strings.Contains(mismatch.Body.String(), "Some("+strconv.FormatInt(fence+1, 10)+")") || !strings.Contains(mismatch.Body.String(), "Some("+strconv.FormatInt(fence, 10)+")") {
		t.Fatalf("fence %d %s", mismatch.Code, mismatch.Body.String())
	}
	var grantAudits int64
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM audit_logs WHERE action = 'writer_lease_granted' AND api_path = '/api/admin/writer-leases/grant'`).Scan(&grantAudits); err != nil || grantAudits < 1 {
		t.Fatalf("lease audit path %d %v", grantAudits, err)
	}

	ceiling := usersDo(handler, http.MethodPut, "/api/admin/ai/prices", `{
		"model":"gpt-test","input_microfen_per_million":1,"cached_input_microfen_per_million":0,
		"output_microfen_per_million":1600000,"reasoning_microfen_per_million":0,"max_request_microfen":26214
	}`, token)
	if ceiling.Code != http.StatusBadRequest || !strings.Contains(ceiling.Body.String(), "16384") {
		t.Fatalf("ceiling %d %s", ceiling.Code, ceiling.Body.String())
	}
	priced := usersDo(handler, http.MethodPut, "/api/admin/ai/prices", `{
		"model":"gpt-test","input_microfen_per_million":1,"cached_input_microfen_per_million":0,
		"output_microfen_per_million":1600000,"reasoning_microfen_per_million":0,"max_request_microfen":26216
	}`, token)
	if priced.Code != http.StatusOK || !strings.Contains(priced.Body.String(), `"model":"gpt-test"`) || strings.Contains(priced.Body.String(), "ocr_models") {
		t.Fatalf("price %d %s", priced.Code, priced.Body.String())
	}
	removed := usersDo(handler, http.MethodDelete, "/api/admin/ai/prices", `{"model":"gpt-test"}`, token)
	if removed.Code != http.StatusOK || strings.Contains(removed.Body.String(), `"model":"gpt-test"`) {
		t.Fatalf("unpublish %d %s", removed.Code, removed.Body.String())
	}
	missingPrice := usersDo(handler, http.MethodDelete, "/api/admin/ai/prices", `{"model":"gpt-test"}`, token)
	if missingPrice.Code != http.StatusNotFound || !strings.Contains(missingPrice.Body.String(), "没有已发布价格") {
		t.Fatalf("missing price %d %s", missingPrice.Code, missingPrice.Body.String())
	}

	usage := usersDo(handler, http.MethodGet, "/api/admin/ai-requests?page_size=0", "", token)
	if usage.Code != http.StatusBadRequest || !strings.Contains(usage.Body.String(), "page_size 必须是正整数") {
		t.Fatalf("usage %d %s", usage.Code, usage.Body.String())
	}
	summary := usersDo(handler, http.MethodGet, "/api/admin/ai-requests/summary", "", token)
	if summary.Code != http.StatusOK || !strings.Contains(summary.Body.String(), `"cache_hit_rate_bps"`) {
		t.Fatalf("summary %d %s", summary.Code, summary.Body.String())
	}

	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/models" {
			http.NotFound(w, r)
			return
		}
		if r.Header.Get("Authorization") != "Bearer sekret" {
			http.Error(w, "no", http.StatusUnauthorized)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"data":[{"id":"m2","owned_by":"z"},{"id":"m1","owned_by":"a"},{"id":"m1","owned_by":"b"}]}`)
	}))
	defer upstream.Close()
	models := usersDo(handler, http.MethodPost, "/api/admin/integrations/ai/models",
		`{"base_url":"`+upstream.URL+`","api_key":"sekret"}`, token)
	if models.Code != http.StatusOK || !strings.Contains(models.Body.String(), `"id":"m1"`) || strings.Index(models.Body.String(), `"id":"m1"`) > strings.Index(models.Body.String(), `"id":"m2"`) {
		t.Fatalf("models %d %s", models.Code, models.Body.String())
	}
	if strings.Count(models.Body.String(), `"id":"m1"`) != 1 {
		t.Fatalf("dedup %s", models.Body.String())
	}
	verify := usersDo(handler, http.MethodPost, "/api/admin/integrations/ai/verify",
		`{"base_url":"`+upstream.URL+`","api_key":"sekret","model":"missing"}`, token)
	if verify.Code != http.StatusOK || !strings.Contains(verify.Body.String(), `"verified":true`) || !strings.Contains(verify.Body.String(), `"model_present":false`) {
		t.Fatalf("verify %d %s", verify.Code, verify.Body.String())
	}

	cfg := usersDo(handler, http.MethodPut, "/api/admin/integrations/config", `{"expected_revision":0,"ai_accounts":[]}`, token)
	if cfg.Code != http.StatusOK || !strings.Contains(cfg.Body.String(), `"schema_version":1`) || !strings.Contains(cfg.Body.String(), `"revision":1`) || strings.Contains(cfg.Body.String(), "secret") {
		t.Fatalf("config %d %s", cfg.Code, cfg.Body.String())
	}

	badName := usersDo(handler, http.MethodPost, "/api/admin/workspaces/"+orgUUID+"/dissolve", `{"name":"nope"}`, token)
	if badName.Code != http.StatusBadRequest || !strings.Contains(badName.Body.String(), "请输入当前工作空间名称以确认解散") {
		t.Fatalf("bad dissolve %d %s", badName.Code, badName.Body.String())
	}
	dissolved := usersDo(handler, http.MethodPost, "/api/admin/workspaces/"+orgUUID+"/dissolve", `{"name":"`+orgName+`"}`, token)
	if dissolved.Code != http.StatusOK || !strings.Contains(dissolved.Body.String(), `"ok":true`) {
		t.Fatalf("dissolve %d %s", dissolved.Code, dissolved.Body.String())
	}
	goneOrg := usersDo(handler, http.MethodPost, "/api/admin/workspaces/"+orgUUID+"/dissolve", `{"name":"`+orgName+`"}`, token)
	if goneOrg.Code != http.StatusForbidden || !strings.Contains(goneOrg.Body.String(), "工作空间不存在") {
		t.Fatalf("redissolve %d %s", goneOrg.Code, goneOrg.Body.String())
	}

	var otherOrg int64
	if err := pool.QueryRow(ctx, `
		INSERT INTO organizations (owner_user_id, name, plan, created_at, updated_at)
		VALUES ($1, 'wallet-rls-other', 'free', clock_timestamp(), clock_timestamp()) RETURNING id`, superID).Scan(&otherOrg); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO workspace_wallets (org_id) VALUES ($1), ($2) ON CONFLICT (org_id) DO NOTHING`, otherOrg, orgID); err != nil {
		t.Fatal(err)
	}
	var walletlessOrg int64
	if err := pool.QueryRow(ctx, `
		INSERT INTO organizations (owner_user_id, name, plan, created_at, updated_at)
		VALUES ($1, 'wallet-rls-walletless', 'free', clock_timestamp(), clock_timestamp()) RETURNING id`, superID).Scan(&walletlessOrg); err != nil {
		t.Fatal(err)
	}
	tx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(ctx)
	if _, err := tx.Exec(ctx, `SET LOCAL ROLE podhub_app`); err != nil {
		t.Fatal(err)
	}
	var hidden int64
	if err := tx.QueryRow(ctx, `SELECT count(*) FROM workspace_wallets`).Scan(&hidden); err != nil || hidden != 0 {
		t.Fatalf("wallet without guc %d %v", hidden, err)
	}
	insertWallet := func(org int64) error {
		sp, err := tx.Begin(ctx)
		if err != nil {
			t.Fatal(err)
		}
		defer sp.Rollback(ctx)
		_, err = sp.Exec(ctx, `INSERT INTO workspace_wallets (org_id) VALUES ($1)`, org)
		return err
	}
	if err := insertWallet(walletlessOrg); err == nil {
		t.Fatal("wallet insert without org guc")
	}
	if _, err := tx.Exec(ctx, `SELECT set_config('app.current_org_id', $1, true)`, strconv.FormatInt(orgID, 10)); err != nil {
		t.Fatal(err)
	}
	var seen int64
	if err := tx.QueryRow(ctx, `SELECT count(*) FROM workspace_wallets WHERE org_id = $1`, orgID).Scan(&seen); err != nil || seen != 1 {
		t.Fatalf("wallet with guc %d %v", seen, err)
	}
	var other int64
	if err := tx.QueryRow(ctx, `SELECT count(*) FROM workspace_wallets WHERE org_id = $1`, otherOrg).Scan(&other); err != nil || other != 0 {
		t.Fatalf("other wallet %d %v", other, err)
	}
	if err := insertWallet(walletlessOrg); err == nil {
		t.Fatal("wallet insert for another org")
	}
}

func usersDo(h http.Handler, method, path, body, token string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(method, path, strings.NewReader(body))
	if body != "" || method != http.MethodGet {
		req.Header.Set("Content-Type", "application/json")
	}
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec
}

func jsonData(t *testing.T, body []byte) map[string]any {
	t.Helper()
	var env struct {
		Data json.RawMessage `json:"data"`
	}
	if err := json.Unmarshal(body, &env); err != nil {
		t.Fatal(err, string(body))
	}
	var data map[string]any
	if err := json.Unmarshal(env.Data, &data); err != nil {
		t.Fatal(err, string(body))
	}
	return data
}

func adminTokenHash(token string) string {
	sum := sha256.Sum256([]byte(token))
	return hex.EncodeToString(sum[:])
}
