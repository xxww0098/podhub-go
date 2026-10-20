package integration

import (
	"context"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"

	admindomain "github.com/xxww0098/podhub-go/internal/admin/domain"
	adminrepo "github.com/xxww0098/podhub-go/internal/admin/repo"
	"github.com/xxww0098/podhub-go/internal/platform/db"
	tenant "github.com/xxww0098/podhub-go/internal/platform/db/tenantx"
	"github.com/xxww0098/podhub-go/internal/telemetry"
	"github.com/xxww0098/podhub-go/internal/telemetry/domain"
	telemetryrepo "github.com/xxww0098/podhub-go/internal/telemetry/repo"
	telemetrysvc "github.com/xxww0098/podhub-go/internal/telemetry/service"
)

func TestErrorDigestPruneParityAndRLS(t *testing.T) {
	ctx := context.Background()
	pool := migratedPool(t, ctx)
	userA, orgA := insertWorkspace(t, ctx, pool, "e1-a@example.invalid", "e1-a")
	userB, orgB := insertWorkspace(t, ctx, pool, "e1-b@example.invalid", "e1-b")
	if _, err := pool.Exec(ctx, `UPDATE public.account_users SET role = 'super_admin' WHERE id = $1`, userA); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		cctx := context.Background()
		_, _ = pool.Exec(cctx, `DELETE FROM public.error_digest WHERE org_id IN ($1, $2) OR org_id IS NULL`, orgA, orgB)
		_, _ = pool.Exec(cctx, `DELETE FROM public.event_inbox_events WHERE device_uid LIKE 'e1-%'`)
		_, _ = pool.Exec(cctx, `DELETE FROM public.client_listing_logs WHERE user_id IN ($1, $2)`, userA, userB)
		_, _ = pool.Exec(cctx, `DELETE FROM public.organizations WHERE id IN ($1, $2)`, orgA, orgB)
		_, _ = pool.Exec(cctx, `DELETE FROM public.account_credentials WHERE user_id IN ($1, $2)`, userA, userB)
		_, _ = pool.Exec(cctx, `DELETE FROM public.account_profiles WHERE user_id IN ($1, $2)`, userA, userB)
		_, _ = pool.Exec(cctx, `DELETE FROM public.account_users WHERE id IN ($1, $2)`, userA, userB)
	})

	now := time.Now().UTC()
	if _, err := pool.Exec(ctx, `
		INSERT INTO public.event_inbox_events
		    (device_uid, id, org_id, user_id, kind, payload_json, client_created_at, received_at)
		VALUES
		    ('e1-prune', 'err-old', $1, $2, 'desktop_error_log.v1', '{}', 't', $3),
		    ('e1-prune', 'err-new', $1, $2, 'error_feedback.v1', '{}', 't', $4),
		    ('e1-prune', 'bill-old', $1, $2, 'billing.ai-token-usage.v1', '{}', 't', $3),
		    ('e1-prune', 'bill-up', $1, $2, 'billing.object-upload-usage.v1', '{}', 't', $3),
		    ('e1-prune', 'unk-old', $1, $2, 'error', '{}', 't', $3),
		    ('e1-prune', 'unk-new', $1, $2, 'error', '{}', 't', $4)`,
		orgA, userA, now.Add(-2*time.Hour), now); err != nil {
		t.Fatal(err)
	}

	wide, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := wide.Exec(ctx, `SELECT set_config('role', 'podhub_error_prune', true)`); err != nil {
		t.Fatal(err)
	}
	_, err = wide.Exec(ctx, `DELETE FROM public.event_inbox_events WHERE device_uid = 'e1-prune'`)
	if err == nil || !strings.Contains(err.Error(), "permission denied") {
		t.Fatalf("prune role delete: %v", err)
	}
	_ = wide.Rollback(ctx)

	deleted, err := telemetry.PruneErrorLogs(ctx, pool, time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	var errOld, errNew, billOld, billUp, unkOld, unkNew int
	if err := pool.QueryRow(ctx, `
		SELECT count(*) FILTER (WHERE id = 'err-old'),
		       count(*) FILTER (WHERE id = 'err-new'),
		       count(*) FILTER (WHERE id = 'bill-old'),
		       count(*) FILTER (WHERE id = 'bill-up'),
		       count(*) FILTER (WHERE id = 'unk-old'),
		       count(*) FILTER (WHERE id = 'unk-new')
		  FROM public.event_inbox_events
		 WHERE device_uid = 'e1-prune'`).Scan(&errOld, &errNew, &billOld, &billUp, &unkOld, &unkNew); err != nil {
		t.Fatal(err)
	}
	if errOld != 0 || errNew != 1 || billOld != 0 || billUp != 0 || unkOld != 0 || unkNew != 1 {
		t.Fatalf("after prune deleted=%d errOld=%d errNew=%d billOld=%d billUp=%d unkOld=%d unkNew=%d", deleted, errOld, errNew, billOld, billUp, unkOld, unkNew)
	}
	aged := now.Add(-2 * time.Hour)
	cutoff := now.Add(-time.Hour)
	for _, kind := range []string{"desktop_error_log.v1", "billing.ai-token-usage.v1", "billing.object-upload-usage.v1", "error"} {
		if !domain.GoPruneDeletes(kind, aged, now, time.Hour) || !domain.RustPruneDeletes(kind, aged, now, time.Hour) {
			t.Fatalf("aged %s kept", kind)
		}
		if domain.GoPruneDeletes(kind, cutoff, now, time.Hour) || domain.RustPruneDeletes(kind, cutoff, now, time.Hour) {
			t.Fatalf("cutoff %s deleted", kind)
		}
	}

	if _, err := pool.Exec(ctx, `
		INSERT INTO public.client_listing_logs
		    (org_id, user_id, client_id, session_id, version, logged_at, level, module, event, received_at)
		VALUES
		    ($1, $2, 'e1-info', 's', '0', $3, 'info', 'm', 'e', $3),
		    ($1, $2, 'e1-error', 's', '0', $3, 'error', 'm', 'e', $3)`,
		orgA, userA, now.Add(-2*time.Hour)); err != nil {
		t.Fatal(err)
	}
	if _, err := telemetry.PruneErrorLogs(ctx, pool, time.Hour); err != nil {
		t.Fatal(err)
	}
	var logsLeft int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM public.client_listing_logs WHERE client_id LIKE 'e1-%'`).Scan(&logsLeft); err != nil || logsLeft != 0 {
		t.Fatalf("client logs left %d %v", logsLeft, err)
	}

	windowAt := time.Date(2026, 10, 17, 6, 30, 0, 0, time.UTC)
	secret := `{"code":"E1","apiPath":"/api/orders/4111111111111111?api_key=secret","apiStatus":500,"message":"Bearer abc sk-abcdefghijklmnopqrst","email":"user@example.com","phone":"13800138000","recipient":"Ada"}`
	if _, err := pool.Exec(ctx, `
		INSERT INTO public.event_inbox_events
		    (device_uid, id, org_id, user_id, kind, payload_json, client_created_at, received_at)
		VALUES
		    ('e1-digest', 'a1', $1, $2, 'desktop_error_log.v1', $5, 't', $6),
		    ('e1-digest', 'a2', $1, $2, 'desktop_error_log.v1', $5, 't', $6),
		    ('e1-digest', 'b1', $3, $4, 'desktop_error_log.v1', $5, 't', $6),
		    ('e1-digest', 'bill', $1, $2, 'billing.object-upload-usage.v1', $5, 't', $6)`,
		orgA, userA, orgB, userB, secret, windowAt); err != nil {
		t.Fatal(err)
	}
	if _, err := telemetrysvc.AggregateHour(ctx, telemetryrepo.New(pool), windowAt.Add(40*time.Minute)); err != nil {
		t.Fatal(err)
	}
	var stored string
	if err := pool.QueryRow(ctx, `
		SELECT coalesce(string_agg(fingerprint || route_template || summary || status_code::text || coalesce(org_id::text, ''), ''), '')
		  FROM public.error_digest`).Scan(&stored); err != nil {
		t.Fatal(err)
	}
	for _, marker := range []string{"Bearer", "sk-", "4111111111111111", "api_key", "secret", "user@example.com", "13800138000", "Ada"} {
		if strings.Contains(stored, marker) {
			t.Fatalf("digest stored %s in %s", marker, stored)
		}
	}
	var tenantA, tenantB, platform int
	if err := pool.QueryRow(ctx, `
		SELECT count(*) FILTER (WHERE org_id = $1),
		       count(*) FILTER (WHERE org_id = $2),
		       count(*) FILTER (WHERE org_id IS NULL)
		  FROM public.error_digest`, orgA, orgB).Scan(&tenantA, &tenantB, &platform); err != nil {
		t.Fatal(err)
	}
	if tenantA != 1 || tenantB != 1 || platform != 1 {
		t.Fatalf("tenantA %d tenantB %d platform %d", tenantA, tenantB, platform)
	}

	txA, err := tenant.BeginApp(ctx, pool.Begin, orgA)
	if err != nil {
		t.Fatal(err)
	}
	var seen int
	if err := txA.QueryRow(ctx, `SELECT count(*) FROM public.error_digest`).Scan(&seen); err != nil || seen != 1 {
		t.Fatalf("org A sees %d %v", seen, err)
	}
	if _, err := txA.Exec(ctx, `
		INSERT INTO public.error_digest (
		    org_id, fingerprint, route_template, status_code, event_count, first_at, last_at, summary, window_start)
		VALUES ($1, repeat('ab', 32), 'inbox/desktop_error_log.v1', 0, 1, $2, $2, 'desktop_error_log.v1 unclassified inbox/desktop_error_log.v1', $3)`,
		orgB, windowAt, windowAt.Truncate(time.Hour)); err == nil {
		t.Fatal("org A inserted org B")
	}
	_ = txA.Rollback(ctx)

	bare, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := bare.Exec(ctx, `SELECT set_config('role', 'podhub_app', true)`); err != nil {
		t.Fatal(err)
	}
	if err := bare.QueryRow(ctx, `SELECT count(*) FROM public.error_digest`).Scan(&seen); err != nil || seen != 0 {
		t.Fatalf("missing GUC sees %d %v", seen, err)
	}
	_, err = bare.Exec(ctx, `
		INSERT INTO public.error_digest (
		    org_id, fingerprint, route_template, status_code, event_count, first_at, last_at, summary, window_start)
		VALUES ($1, repeat('cd', 32), 'inbox/desktop_error_log.v1', 0, 1, $2, $2, 'desktop_error_log.v1 unclassified inbox/desktop_error_log.v1', $3)`,
		orgA, windowAt, windowAt.Truncate(time.Hour))
	if err == nil {
		t.Fatal("missing GUC inserted a digest row")
	}
	_ = bare.Rollback(ctx)

	legacy, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := legacy.Exec(ctx,
		`SELECT set_config('role', 'podhub_app', true), set_config('app.platform_observer_id', $1, true)`,
		strconv.FormatInt(userA, 10)); err != nil {
		t.Fatal(err)
	}
	oldUser, oldObserver, oldOrg := digestSnap(t, ctx, legacy)
	_ = legacy.Rollback(ctx)
	var newUser, newObserver, newOrg string
	if err := db.InTx(ctx, pool, db.Observer(userA), func(tx pgx.Tx) error {
		newUser, newObserver, newOrg = digestSnap(t, ctx, tx)
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if oldUser != newUser || oldObserver != newObserver || oldOrg != newOrg {
		t.Fatalf("observer session old %s %q %q new %s %q %q", oldUser, oldObserver, oldOrg, newUser, newObserver, newOrg)
	}

	body, err := adminrepo.NewBilling(pool, "").ListDigest(ctx, admindomain.Actor{UserID: userA})
	if err != nil {
		t.Fatal(err)
	}
	text := string(body)
	if strings.Contains(text, "org_id") || strings.Contains(text, "user@example.com") || strings.Contains(text, "Bearer") || !strings.Contains(text, `"digests"`) {
		t.Fatalf("admin body %s", text)
	}
	other, err := adminrepo.NewBilling(pool, "").ListDigest(ctx, admindomain.Actor{UserID: userB})
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(other), "fingerprint") {
		t.Fatalf("non-super admin read platform rows %s", other)
	}
}

func digestSnap(t *testing.T, ctx context.Context, tx pgx.Tx) (user, observer, org string) {
	t.Helper()
	var observerP, orgP *string
	if err := tx.QueryRow(ctx, `
		SELECT current_user,
		       current_setting('app.platform_observer_id', true),
		       current_setting('app.current_org_id', true)`).Scan(&user, &observerP, &orgP); err != nil {
		t.Fatal(err)
	}
	if observerP != nil {
		observer = *observerP
	}
	if orgP != nil {
		org = *orgP
	}
	return user, observer, org
}
