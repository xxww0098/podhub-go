package integration

import (
	"context"
	"crypto/sha256"
	"encoding/base32"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/xxww0098/podhub-go/internal/admin/domain"
	"github.com/xxww0098/podhub-go/internal/app"
)

func TestAdminUsersAIAuth(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Minute)
	defer cancel()
	pool := migratedPool(t, ctx)
	seedMatchingLease(t, ctx, pool, "auth", "admin users test")
	seedMatchingLease(t, ctx, pool, "admin", "admin users test")
	t.Setenv("CLOUD_ADMIN_TOTP_KEY", "admin-b-totp-key-at-least-32-characters")
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

	enroll := usersDo(handler, http.MethodPost, "/api/admin/totp/enroll", "", token)
	if enroll.Code != http.StatusOK || enroll.Header().Get("X-Content-Type-Options") != "nosniff" {
		t.Fatalf("enroll %d %s", enroll.Code, enroll.Body.String())
	}
	enrollData := jsonData(t, enroll.Body.Bytes())
	secretRaw, _ := enrollData["secretBase32"].(string)
	secret, err := base32.StdEncoding.WithPadding(base32.NoPadding).DecodeString(secretRaw)
	if err != nil || len(secret) != 20 {
		t.Fatalf("secret %q %v", secretRaw, err)
	}
	codes, _ := enrollData["recoveryCodes"].([]any)
	if len(codes) != 8 {
		t.Fatalf("codes %#v", enrollData["recoveryCodes"])
	}
	if !strings.Contains(enrollData["otpauthUrl"].(string), "otpauth://totp/") {
		t.Fatal(enrollData["otpauthUrl"])
	}
	code := domain.Hotp(secret, uint64(time.Now().Unix()/30))
	empty := usersDo(handler, http.MethodPost, "/api/admin/totp/confirm", `{"code":"   "}`, token)
	if empty.Code != http.StatusUnauthorized || !strings.Contains(empty.Body.String(), `"code":"TOTP_REQUIRED"`) {
		t.Fatalf("empty code %d %s", empty.Code, empty.Body.String())
	}
	bad := usersDo(handler, http.MethodPost, "/api/admin/totp/confirm", `{"code":"000000"}`, token)
	if bad.Code != http.StatusUnauthorized || !strings.Contains(bad.Body.String(), "验证器验证码错误") {
		t.Fatalf("bad code %d %s", bad.Code, bad.Body.String())
	}
	confirm := usersDo(handler, http.MethodPost, "/api/admin/totp/confirm", `{"code":"`+code+`"}`, token)
	if confirm.Code != http.StatusOK || !strings.Contains(confirm.Body.String(), `"ok":true`) {
		t.Fatalf("confirm %d %s", confirm.Code, confirm.Body.String())
	}
	again := usersDo(handler, http.MethodPost, "/api/admin/totp/confirm", `{"code":"`+code+`"}`, token)
	if again.Code != http.StatusConflict || !strings.Contains(again.Body.String(), `"code":"VALIDATION"`) || !strings.Contains(again.Body.String(), "验证器已绑定") {
		t.Fatalf("reconfirm %d %s", again.Code, again.Body.String())
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

	seats := usersDo(handler, http.MethodPost, "/api/admin/users/"+userUUID+"/seats", `{"seats":2}`, token)
	if seats.Code != http.StatusOK || !strings.Contains(seats.Body.String(), `"seat_limit":2`) {
		t.Fatalf("seats %d %s", seats.Code, seats.Body.String())
	}
	preview := usersDo(handler, http.MethodPost, "/api/admin/users/"+userUUID+"/member-seats/preview", `{"member_seats_override":3}`, token)
	if preview.Code != http.StatusOK || !strings.Contains(preview.Body.String(), `"storeSlots"`) {
		t.Fatalf("preview %d %s", preview.Code, preview.Body.String())
	}
	prev := jsonData(t, preview.Body.Bytes())
	revision := int64(prev["revision"].(float64))
	slots := prev["storeSlots"].(map[string]any)
	effective := int64(slots["effective"].(float64))
	stale := usersDo(handler, http.MethodPost, "/api/admin/users/"+userUUID+"/member-seats/apply",
		`{"revision":`+strconv.FormatInt(revision+9, 10)+`,"expected_store_limit":`+strconv.FormatInt(effective, 10)+`}`, token)
	if stale.Code != http.StatusConflict || !strings.Contains(stale.Body.String(), "配额状态已变化，请重新预览") {
		t.Fatalf("stale %d %s", stale.Code, stale.Body.String())
	}
	apply := usersDo(handler, http.MethodPost, "/api/admin/users/"+userUUID+"/member-seats/apply",
		`{"revision":`+strconv.FormatInt(revision, 10)+`,"expected_store_limit":`+strconv.FormatInt(effective, 10)+`,"member_seats_override":3}`, token)
	if apply.Code != http.StatusOK || !strings.Contains(apply.Body.String(), `"revision":`+strconv.FormatInt(revision+1, 10)) {
		t.Fatalf("apply %d %s", apply.Code, apply.Body.String())
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
		`{"baseUrl":"`+upstream.URL+`","apiKey":"sekret"}`, token)
	if models.Code != http.StatusOK || !strings.Contains(models.Body.String(), `"id":"m1"`) || strings.Index(models.Body.String(), `"id":"m1"`) > strings.Index(models.Body.String(), `"id":"m2"`) {
		t.Fatalf("models %d %s", models.Code, models.Body.String())
	}
	if strings.Count(models.Body.String(), `"id":"m1"`) != 1 {
		t.Fatalf("dedup %s", models.Body.String())
	}
	verify := usersDo(handler, http.MethodPost, "/api/admin/integrations/ai/verify",
		`{"baseUrl":"`+upstream.URL+`","apiKey":"sekret","model":"missing"}`, token)
	if verify.Code != http.StatusOK || !strings.Contains(verify.Body.String(), `"verified":true`) || !strings.Contains(verify.Body.String(), `"modelPresent":false`) {
		t.Fatalf("verify %d %s", verify.Code, verify.Body.String())
	}

	cfg := usersDo(handler, http.MethodPut, "/api/admin/integrations/config", `{"expectedRevision":0,"aiAccounts":[],"storageBuckets":[]}`, token)
	if cfg.Code != http.StatusOK || !strings.Contains(cfg.Body.String(), `"schemaVersion":1`) || !strings.Contains(cfg.Body.String(), `"revision":1`) || strings.Contains(cfg.Body.String(), "secret") {
		t.Fatalf("config %d %s", cfg.Code, cfg.Body.String())
	}

	recovery := codes[0].(string)
	step := usersDo(handler, http.MethodPost, "/api/admin/step-up", `{"code":"`+recovery+`"}`, token)
	if step.Code != http.StatusOK || !strings.Contains(step.Body.String(), `"ok":true`) {
		t.Fatalf("step %d %s", step.Code, step.Body.String())
	}
	spent := usersDo(handler, http.MethodPost, "/api/admin/step-up", `{"code":"`+recovery+`"}`, token)
	if spent.Code != http.StatusUnauthorized || !strings.Contains(spent.Body.String(), "验证器验证码错误") {
		t.Fatalf("spent recovery %d %s", spent.Code, spent.Body.String())
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

	if _, err := pool.Exec(ctx, `INSERT INTO user_wallets (user_id) VALUES ($1), ($2) ON CONFLICT (user_id) DO NOTHING`, superID, userID); err != nil {
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
	if err := tx.QueryRow(ctx, `SELECT count(*) FROM user_wallets`).Scan(&hidden); err != nil || hidden != 0 {
		t.Fatalf("wallet without guc %d %v", hidden, err)
	}
	if _, err := tx.Exec(ctx, `SELECT set_config('app.current_wallet_user_id', $1, true)`, strconv.FormatInt(userID, 10)); err != nil {
		t.Fatal(err)
	}
	var seen int64
	if err := tx.QueryRow(ctx, `SELECT count(*) FROM user_wallets WHERE user_id = $1`, userID).Scan(&seen); err != nil || seen != 1 {
		t.Fatalf("wallet with guc %d %v", seen, err)
	}
	var other int64
	if err := tx.QueryRow(ctx, `SELECT count(*) FROM user_wallets WHERE user_id = $1`, superID).Scan(&other); err != nil || other != 0 {
		t.Fatalf("other wallet %d %v", other, err)
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
