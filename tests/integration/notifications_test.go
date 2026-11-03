package integration

import (
	"context"
	"encoding/json"
	"net/http"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/xxww0098/podhub-go/internal/app"
	"github.com/xxww0098/podhub-go/internal/platform/config"
	"github.com/xxww0098/podhub-go/internal/platform/db"
)

func TestNotificationsHTTP(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	// Isolate the cluster before changing the production login's password.
	t.Setenv("PODHUB_PARITY_DSN", "")
	dsn := securityDSN(t, ctx)
	t.Setenv("PODHUB_ALLOW_SUPERUSER_DB", "1")
	pool, err := db.Connect(ctx, config.Config{DatabaseURL: dsn})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	if err := db.Migrate(ctx, pool); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `ALTER ROLE podhub_login_api PASSWORD 'notification-runtime-test'`); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PODHUB_ALLOW_SUPERUSER_DB", "")
	loginDSN, err := url.Parse(swapUser(dsn, "podhub_login_api", "notification-runtime-test"))
	if err != nil {
		t.Fatal(err)
	}
	query := loginDSN.Query()
	query.Set("pool_max_conns", "1")
	loginDSN.RawQuery = query.Encode()
	runtime, err := db.Connect(ctx, config.Config{DatabaseURL: loginDSN.String()})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(runtime.Close)
	assertRole := func() {
		t.Helper()
		var current, session, org, staff string
		var super, inherit, bypass bool
		if err := runtime.QueryRow(ctx, `SELECT current_user,session_user,rolsuper,rolinherit,rolbypassrls,COALESCE(current_setting('app.current_org_id',true),''),COALESCE(current_setting('app.staff_access',true),'') FROM pg_roles WHERE rolname=current_user`).Scan(&current, &session, &super, &inherit, &bypass, &org, &staff); err != nil {
			t.Fatal(err)
		}
		if current != "podhub_login_api" || session != current || super || inherit || bypass || org != "" || staff != "" {
			t.Fatalf("unsafe or leaked login role: current=%s session=%s super=%v inherit=%v bypass=%v org=%q staff=%q", current, session, super, inherit, bypass, org, staff)
		}
	}
	assertRole()
	var owner, other int64
	for i, row := range []struct{ public, email, token string }{
		{"00000000-0000-4000-8000-00000000a001", "notice-a@example.invalid", "notice-a-token"},
		{"00000000-0000-4000-8000-00000000a002", "notice-b@example.invalid", "notice-b-token"},
	} {
		var id int64
		if err := pool.QueryRow(ctx, `INSERT INTO account_users (public_id,email,password_hash,role,name,target,supplier_id,plan,created_at,updated_at) VALUES ($1,$2,'x','user','通知测试','/workspace','','lite',clock_timestamp(),clock_timestamp()) RETURNING id`, row.public, row.email).Scan(&id); err != nil {
			t.Fatal(err)
		}
		if _, err := pool.Exec(ctx, `INSERT INTO account_sessions(token_hash,user_id,expires_at) VALUES ($1,$2,clock_timestamp()+interval '1 hour')`, adminTokenHash(row.token), id); err != nil {
			t.Fatal(err)
		}
		if i == 0 {
			owner = id
		} else {
			other = id
		}
	}
	const rawSecret = "notification-proof-must-not-leak"
	var otherUUID string
	if err := pool.QueryRow(ctx, `INSERT INTO notifications(user_id,kind,payload) VALUES ($1,'delegate_order_event','{"event":"shipped","orderId":"other-order","postingNumber":"other-posting","sourceName":"other"}') RETURNING uuid::text`, other).Scan(&otherUUID); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 55; i++ {
		if _, err := pool.Exec(ctx, `INSERT INTO notifications(user_id,kind,payload,created_at) VALUES ($1,'delegate_order_event',jsonb_build_object('event','shipped','orderId','own-order','postingNumber','own-posting','sourceName','自有通知','token',$2::text),'2026-10-01T00:00:00Z')`, owner, rawSecret); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := pool.Exec(ctx, `INSERT INTO notifications(user_id,kind,payload,dismissed_at) VALUES ($1,'delegate_order_event','{}',clock_timestamp())`, owner); err != nil {
		t.Fatal(err)
	}
	handler := app.Handler(runtime)
	anon := usersDo(handler, http.MethodGet, "/api/notifications", "", "")
	if anon.Code != http.StatusUnauthorized {
		t.Fatalf("anonymous %d %s", anon.Code, anon.Body.String())
	}
	type page struct {
		Data struct {
			Notifications []struct {
				UUID   string `json:"uuid"`
				ReadAt *int64 `json:"read_at_ms"`
			} `json:"notifications"`
			Total, Unread int
			Next          *string `json:"next_cursor"`
		} `json:"data"`
	}
	read := func(cursor string) page {
		t.Helper()
		path := "/api/notifications"
		if cursor != "" {
			path += "?cursor=" + url.QueryEscape(cursor)
		}
		res := usersDo(handler, http.MethodGet, path, "", "notice-a-token")
		if res.Code != 200 {
			t.Fatalf("list %d %s", res.Code, res.Body.String())
		}
		if strings.Contains(res.Body.String(), rawSecret) || strings.Contains(res.Body.String(), "other-order") {
			t.Fatalf("notification projection leaked foreign/private fields: %s", res.Body.String())
		}
		var p page
		if err := json.Unmarshal(res.Body.Bytes(), &p); err != nil {
			t.Fatal(err)
		}
		return p
	}
	first := read("")
	if len(first.Data.Notifications) != 50 || first.Data.Total != 55 || first.Data.Unread != 55 || first.Data.Next == nil {
		t.Fatalf("first page %#v", first.Data)
	}
	second := read(*first.Data.Next)
	if len(second.Data.Notifications) != 5 || second.Data.Next != nil {
		t.Fatalf("second page %#v", second.Data)
	}
	seen := map[string]bool{}
	for _, row := range append(first.Data.Notifications, second.Data.Notifications...) {
		if seen[row.UUID] {
			t.Fatal("duplicate cursor row")
		}
		seen[row.UUID] = true
	}
	for _, cursor := range []string{"invalid", strings.Repeat("a", 300)} {
		res := usersDo(handler, http.MethodGet, "/api/notifications?cursor="+cursor, "", "notice-a-token")
		if res.Code != 400 {
			t.Fatalf("invalid cursor %d %s", res.Code, res.Body.String())
		}
	}
	hidden := usersDo(handler, http.MethodPost, "/api/notifications/"+otherUUID+"/read", "", "notice-a-token")
	if hidden.Code != 404 {
		t.Fatalf("foreign notification %d %s", hidden.Code, hidden.Body.String())
	}
	for range 2 {
		marked := usersDo(handler, http.MethodPost, "/api/notifications/"+first.Data.Notifications[0].UUID+"/read", "", "notice-a-token")
		if marked.Code != 200 || !strings.Contains(marked.Body.String(), `"unread":54`) {
			t.Fatalf("mark one %d %s", marked.Code, marked.Body.String())
		}
	}
	all := usersDo(handler, http.MethodPost, "/api/notifications/read-all", "", "notice-a-token")
	if all.Code != 200 || !strings.Contains(all.Body.String(), `"unread":0`) {
		t.Fatalf("mark all %d %s", all.Code, all.Body.String())
	}
	if got := read(""); got.Data.Unread != 0 || got.Data.Notifications[0].ReadAt == nil {
		t.Fatal("read state was not persisted")
	}
	otherView := usersDo(handler, http.MethodGet, "/api/notifications", "", "notice-b-token")
	if otherView.Code != 200 || !strings.Contains(otherView.Body.String(), `"unread":1`) {
		t.Fatalf("other account changed %d %s", otherView.Code, otherView.Body.String())
	}
	var readCount, untouched, audits int
	if err := pool.QueryRow(ctx, `SELECT
		(SELECT count(*) FROM notifications WHERE user_id=$1 AND dismissed_at IS NULL AND read_at IS NOT NULL),
		(SELECT count(*) FROM notifications WHERE user_id=$2 AND read_at IS NULL),
		(SELECT count(*) FROM audit_logs WHERE user_id=$1 AND action='notifications_read')`, owner, other).Scan(&readCount, &untouched, &audits); err != nil || readCount != 55 || untouched != 1 || audits != 3 {
		t.Fatalf("notification writes: read=%d otherUnread=%d audits=%d err=%v", readCount, untouched, audits, err)
	}
	if _, err := pool.Exec(ctx, `UPDATE account_users SET disabled_at=clock_timestamp() WHERE id=$1`, owner); err != nil {
		t.Fatal(err)
	}
	for _, method := range []string{http.MethodGet, http.MethodPost} {
		path := "/api/notifications"
		if method == http.MethodPost {
			path += "/read-all"
		}
		res := usersDo(handler, method, path, "", "notice-a-token")
		if res.Code != http.StatusUnauthorized {
			t.Fatalf("disabled account %s: %d %s", method, res.Code, res.Body.String())
		}
	}
	assertRole()
}
