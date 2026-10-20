package x1repo

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/testcontainers/testcontainers-go/modules/postgres"

	"github.com/xxww0098/podhub-go/internal/admin/contract"
	"github.com/xxww0098/podhub-go/internal/admin/domain"
	"github.com/xxww0098/podhub-go/internal/platform/config"
	"github.com/xxww0098/podhub-go/internal/platform/db"
	"github.com/xxww0098/podhub-go/internal/platform/db/tenantx"
)

func TestSupplierX1RevisionsRLSAndLease(t *testing.T) {
	pool, ctx := x1ParityDB(t)
	if _, err := pool.Exec(ctx, `DELETE FROM writer_leases WHERE domain = 'admin' AND revoked_at_ms IS NULL`); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `
		INSERT INTO writer_leases (
		    domain, holder, holder_instance, fence_token, granted_at_ms,
		    expires_at_ms, heartbeat_at_ms, grant_reason)
		VALUES ('admin', 'axum', $1, 1,
		        (EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::bigint,
		        (EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::bigint + 600000,
		        (EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::bigint,
		        'x1 test')`, fmt.Sprintf("axum-%d", os.Getpid())); err != nil {
		t.Fatal(err)
	}
	const (
		userA = int64(910201)
		userB = int64(910202)
		orgA  = int64(7)
		orgB  = int64(8)
		src   = "src_x1_910201"
	)
	pubA, pubB := "a910201", "a910202"
	x1SeedUser(t, ctx, pool, userA, pubA, "admin")
	x1SeedUser(t, ctx, pool, userB, pubB, "admin")
	t.Cleanup(func() { dropX1(context.Background(), pool, src, userA, userB) })

	rows := NewX1(pool, tenantx.BeginApp)
	actorA := contract.Actor{UserID: userA, OrgID: orgA, Role: "admin"}
	actorB := contract.Actor{UserID: userB, OrgID: orgB, Role: "admin"}
	if _, err := pool.Exec(ctx, `
		INSERT INTO public.sc_sources
		       (source_id, name, country, contact, internal_note, listed, icon,
		        accepts_delegate, view_prefs, created_at_ms, updated_at_ms,
		        created_by_account_uuid)
		VALUES ($1,$2,'CN','','',true,'',false,'{}'::jsonb,10,10,$3)`,
		src, "X1印花厂", pubA); err != nil {
		t.Fatal(err)
	}

	var aiBefore int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM public.ai_requests`).Scan(&aiBefore); err != nil {
		t.Fatal(err)
	}
	report, err := rows.SyncPrompts(ctx, actorA, 20)
	if err != nil {
		t.Fatal(err)
	}
	if report.Counts != (domain.SyncCounts{}) || len(report.Updated) != 0 || report.DetailsTruncated {
		t.Fatalf("sync %+v", report)
	}
	assertApplied(t, ctx, pool, userA, "sc_supplier_prompts_synced", `{"updated":0,"upToDate":0,"unmatched":0,"failed":0}`)

	emptyIn := decodeFixtureRow(t, "requests/post-row-staff-crud.json", nil)
	empty, err := rows.CreateRow(ctx, actorA, src, emptyIn, "scp_x1_empty", "scs_x1_empty", "DB-X1-EMPTY", 30)
	if err != nil {
		t.Fatal(err)
	}
	if empty.Revision != 1 || empty.Published || empty.Archived || empty.PlatformPriceCents != nil || empty.Denial != "sku_not_published" || empty.OzonConfigDenial != "catalog_missing" || empty.Readiness != (domain.RowReadiness{}) {
		t.Fatalf("empty row %+v", empty)
	}
	priced, err := rows.AdjustPrice(ctx, actorA, src, "scp_x1_empty", 2900, "首次定价", 40)
	if err != nil {
		t.Fatal(err)
	}
	if priced.Revision != 2 || priced.PlatformPriceCents == nil || *priced.PlatformPriceCents != 2900 || !priced.Readiness.PlatformPrice || priced.Denial != "sku_not_published" {
		t.Fatalf("price %+v", priced)
	}
	assertApplied(t, ctx, pool, userA, "sc_source_row_price_adjusted", `{"sourceId":"`+src+`","skuId":"scs_x1_empty","priceCents":2900,"note":"首次定价"}`)

	brief := decodeFixtureRow(t, "requests/post-row-staff-crud.json", map[string]any{
		"title": "马克杯", "platformCode": "DB-X1-BRIEF",
		"descriptionCategoryId": json.Number("17033561"), "typeId": json.Number("91497"),
		"promptContent": string(mustRepoRead(t, "brief-minimal.txt")),
	})
	created, err := rows.CreateRow(ctx, actorA, src, brief, "scp_x1_brief", "scs_x1_brief", "DB-X1-BRIEF", 50)
	if err != nil {
		t.Fatal(err)
	}
	if created.Revision != 2 || created.DraftPromptRevision == nil || *created.DraftPromptRevision != 1 || created.PublishedPromptRev == nil || *created.PublishedPromptRev != 1 {
		t.Fatalf("brief row rev %d draft %v published %v", created.Revision, created.DraftPromptRevision, created.PublishedPromptRev)
	}
	var state string
	var cfgRev int64
	var pointer int32
	if err := pool.QueryRow(ctx, `SELECT state, revision, published_revision FROM public.supplier_ozon_configs WHERE product_id = 'scp_x1_brief'`).Scan(&state, &cfgRev, &pointer); err != nil {
		t.Fatal(err)
	}
	if state != "needs_reconfiguration" || cfgRev != 1 || pointer != 1 {
		t.Fatalf("config %s %d %d", state, cfgRev, pointer)
	}

	patch, err := domain.DecodePromptPatch(mustRepoRead(t, "requests/patch-prompt-chernovik.json"))
	if err != nil {
		t.Fatal(err)
	}
	patched, err := rows.PatchPrompt(ctx, actorA, "scp_x1_brief", patch, 60)
	if err != nil {
		t.Fatal(err)
	}
	if patched.Revision != 4 || patched.DraftPromptRevision == nil || *patched.DraftPromptRevision != 2 || patched.PublishedPromptRevision == nil || *patched.PublishedPromptRevision != 1 || !contains(patched.PromptContent, "ЧЕРНОВИК") {
		t.Fatalf("patch %+v", patched)
	}
	diff, err := rows.PromptDiff(ctx, actorA, src, "scp_x1_brief", patched.DraftPromptRevision)
	if err != nil || diff.PublishedRevision == nil || *diff.PublishedRevision != 1 || !diff.FixedTagsChanged {
		t.Fatalf("diff %+v %v", diff, err)
	}
	published, err := rows.PublishPrompt(ctx, actorA, src, "scp_x1_brief", 2, 70)
	if err != nil {
		t.Fatal(err)
	}
	if published.Revision != 2 || published.PublishedRevision != 2 || published.ProductRevision != 5 || published.ConfigRevision != 3 {
		t.Fatalf("prompt publish %+v", published)
	}

	if _, err := rows.Detail(ctx, actorB, src, 80); err == nil || err.Error() != "记录不存在或已删除" {
		t.Fatalf("cross owner %v", err)
	}
	bare := NewX1(pool, func(ctx context.Context, begin func(context.Context) (pgx.Tx, error), _ int64) (pgx.Tx, error) {
		return begin(ctx)
	})
	if _, err := bare.CreateRow(ctx, actorA, src, emptyIn, "scp_x1_bare", "scs_x1_bare", "DB-X1-BARE", 90); err == nil || err.Error() != "服务暂不可用" {
		t.Fatalf("missing guc %v", err)
	}

	tx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if err := tenantx.EnterApp(ctx, tx, 99); err != nil {
		t.Fatal(err)
	}
	var seen int
	if err := tx.QueryRow(ctx, `SELECT count(*) FROM public.sc_products WHERE product_id = 'scp_x1_brief'`).Scan(&seen); err != nil || seen != 1 {
		t.Fatalf("no rls %d %v", seen, err)
	}
	_ = tx.Rollback(ctx)

	var aiAfter int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM public.ai_requests`).Scan(&aiAfter); err != nil || aiAfter != aiBefore {
		t.Fatalf("ai_requests %d %d %v", aiBefore, aiAfter, err)
	}

	if _, err := pool.Exec(ctx, `DELETE FROM public.writer_leases WHERE domain = 'admin' AND revoked_at_ms IS NULL`); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `
		INSERT INTO public.writer_leases
		    (domain, holder, holder_instance, fence_token, granted_at_ms, expires_at_ms, heartbeat_at_ms, grant_reason)
		VALUES ('admin', 'hono', 'x1-910201', 1, 1, 200, 1, 'x1')`); err != nil {
		t.Fatal(err)
	}
	if _, err := rows.CreateRow(ctx, actorA, src, emptyIn, "scp_x1_leased", "scs_x1_leased", "DB-X1-LEASED", 100); err == nil || err.Error() != "平台货源写入未启用" {
		t.Fatalf("lease %v", err)
	}
	if _, err := pool.Exec(ctx, `DELETE FROM public.writer_leases WHERE holder_instance = 'x1-910201'`); err != nil {
		t.Fatal(err)
	}
}

func assertApplied(t *testing.T, ctx context.Context, pool interface {
	QueryRow(context.Context, string, ...any) pgx.Row
}, userID int64, action, message string) {
	t.Helper()
	var result, got string
	var org int64
	err := pool.QueryRow(ctx, `
		SELECT result, message, org_id FROM public.audit_logs
		 WHERE user_id = $1 AND action = $2
		 ORDER BY id DESC LIMIT 1`, userID, action).Scan(&result, &got, &org)
	if err != nil {
		t.Fatal(err)
	}
	if result != "applied" || got != message || org != 7 {
		t.Fatalf("audit %s result %s org %d message %s", action, result, org, got)
	}
}

func decodeFixtureRow(t *testing.T, name string, over map[string]any) domain.RowInput {
	t.Helper()
	var wrap struct {
		Body json.RawMessage `json:"body"`
	}
	raw := mustRepoRead(t, name)
	if err := json.Unmarshal(raw, &wrap); err != nil {
		t.Fatal(err)
	}
	body := wrap.Body
	if over != nil {
		var obj map[string]any
		if err := json.Unmarshal(wrap.Body, &obj); err != nil {
			t.Fatal(err)
		}
		for k, v := range over {
			obj[k] = v
		}
		encoded, err := json.Marshal(obj)
		if err != nil {
			t.Fatal(err)
		}
		body = encoded
	}
	in, err := domain.DecodeRow(body, false)
	if err != nil {
		t.Fatal(err)
	}
	return in
}

func mustRepoRead(t *testing.T, name string) []byte {
	t.Helper()
	for _, rel := range []string{
		filepath.Join("..", "domain", "testdata", "x1", name),
		filepath.Join("..", "..", "domain", "testdata", "x1", name),
	} {
		raw, err := os.ReadFile(rel)
		if err == nil {
			return raw
		}
	}
	t.Fatalf("fixture %s", name)
	return nil
}

func x1SeedUser(t *testing.T, ctx context.Context, pool *pgxpool.Pool, id int64, publicID, role string) {
	t.Helper()
	_, err := pool.Exec(ctx, `
		INSERT INTO account_users (id, public_id, email, password_hash, role, name, target, supplier_id, plan, created_at, updated_at)
		VALUES ($1, $2, $3, 'x', $4, '管理员', '/workspace', '', 'lite', clock_timestamp(), clock_timestamp())`,
		id, publicID, fmt.Sprintf("%s@example.invalid", publicID), role)
	if err != nil {
		t.Fatal(err)
	}
}

var (
	x1Once sync.Once
	x1Pool *pgxpool.Pool
	x1Err  error
)

func x1ParityDB(t testing.TB) (*pgxpool.Pool, context.Context) {
	t.Helper()
	dsn := os.Getenv("PODHUB_PARITY_DSN")
	if dsn == "" {
		if _, err := os.Stat("/var/run/docker.sock"); err != nil {
			t.Skip("docker daemon is not available")
		}
	}
	x1Once.Do(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Minute)
		defer cancel()
		if dsn == "" {
			container, err := postgres.Run(ctx, "postgres:16-alpine",
				postgres.WithDatabase("podhub"),
				postgres.WithUsername("postgres"),
				postgres.WithPassword("postgres"),
				postgres.BasicWaitStrategies(),
			)
			if err != nil {
				x1Err = err
				return
			}
			dsn, err = container.ConnectionString(ctx, "sslmode=disable")
			if err != nil {
				x1Err = err
				return
			}
		}
		cfg := config.Config{DatabaseURL: dsn}
		if err := cfg.CheckDatabase(); err != nil {
			x1Err = err
			return
		}
		_ = os.Setenv("PODHUB_ALLOW_SUPERUSER_DB", "1")
		pool, err := db.Connect(ctx, cfg)
		if err != nil {
			x1Err = err
			return
		}
		if err := db.Migrate(ctx, pool); err != nil {
			pool.Close()
			x1Err = err
			return
		}
		x1Pool = pool
	})
	if x1Err != nil {
		t.Fatal(x1Err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	t.Cleanup(cancel)
	return x1Pool, ctx
}

func contains(s, part string) bool {
	return len(s) >= len(part) && (s == part || len(part) == 0 || (func() bool { return stringIndex(s, part) >= 0 })())
}

func stringIndex(s, part string) int {
	for i := 0; i+len(part) <= len(s); i++ {
		if s[i:i+len(part)] == part {
			return i
		}
	}
	return -1
}

func dropX1(ctx context.Context, pool *pgxpool.Pool, source string, ids ...int64) {
	_, _ = pool.Exec(ctx, `DELETE FROM public.sc_price_versions WHERE sku_id IN ('scs_x1_empty','scs_x1_brief','scs_x1_bare','scs_x1_leased')`)
	_, _ = pool.Exec(ctx, `DELETE FROM public.sc_source_offers WHERE source_id = $1`, source)
	_, _ = pool.Exec(ctx, `DELETE FROM public.sc_skus WHERE sku_id IN ('scs_x1_empty','scs_x1_brief','scs_x1_bare','scs_x1_leased')`)
	_, _ = pool.Exec(ctx, `DELETE FROM public.sc_products WHERE source_id = $1`, source)
	_, _ = pool.Exec(ctx, `DELETE FROM public.audit_logs WHERE user_id = ANY($1) OR entity_id IN ('supplier-prompts',$2)`, ids, source)
	_, _ = pool.Exec(ctx, `DELETE FROM public.sc_sources WHERE source_id = $1`, source)
	_, _ = pool.Exec(ctx, `DELETE FROM public.writer_leases WHERE holder_instance = 'x1-910201'`)
	_, _ = pool.Exec(ctx, `DELETE FROM public.account_users WHERE id = ANY($1)`, ids)
}
