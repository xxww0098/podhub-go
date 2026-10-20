package adminrepo

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	corerepo "github.com/xxww0098/podhub-go/internal/admin/core/repo"
	"github.com/xxww0098/podhub-go/internal/admin/domain"
	"github.com/xxww0098/podhub-go/internal/platform/writer"
)

func TestAssertWriteLeaseMatchesLegacy(t *testing.T) {
	cases := []struct {
		name string
		err  error
		ever bool
		want error
	}{
		{name: "disabled", err: pgx.ErrNoRows, want: domain.Fail(503, "WRITES_DISABLED", "平台目录写入未启用")},
		{name: "db", err: errors.New("db"), want: domain.Fail(500, "INTERNAL", "服务暂不可用")},
		{name: "lock", err: &pgconn.PgError{Code: "55P03"}, want: &domain.APIError{Status: 503, Code: "INTERNAL", Message: "资源正在更新，请稍后重试", RetryAfter: "1"}},
	}
	for _, c := range cases {
		got := AssertWriteLease(context.Background(), &leaseTx{t: t, first: c.err, ever: c.ever}, "平台目录写入未启用")
		want := legacyAssertWriteLease(context.Background(), &leaseTx{t: t, first: c.err, ever: c.ever}, "平台目录写入未启用")
		direct := corerepo.AssertWriteLease(context.Background(), &leaseTx{t: t, first: c.err, ever: c.ever}, "平台目录写入未启用")
		if !sameAPI(got, want) || !sameAPI(direct, want) || !sameAPI(got, c.want) {
			t.Fatalf("%s: got %#v want %#v direct %#v", c.name, got, want, direct)
		}
	}
}

func TestAssertWriteLeaseActive(t *testing.T) {
	for _, entry := range []struct {
		name   string
		assert func(context.Context, pgx.Tx, string) error
	}{
		{"admin", AssertWriteLease},
		{"core", corerepo.AssertWriteLease},
	} {
		for _, c := range []struct {
			name         string
			expiresIn    int64
			heartbeatAgo int64
			tag          string
			execErr      error
			want         error
		}{
			{name: "live", expiresIn: 60000, tag: "UPDATE 1"},
			{name: "expired", expiresIn: -1, want: domain.Fail(503, "WRITES_DISABLED", "平台目录写入未启用")},
			{name: "stale heartbeat", expiresIn: 60000, heartbeatAgo: 60000, want: domain.Fail(503, "WRITES_DISABLED", "平台目录写入未启用")},
			{name: "no update", expiresIn: 60000, tag: "UPDATE 0", want: domain.Fail(500, "INTERNAL", "服务暂不可用")},
			{name: "multiple updates", expiresIn: 60000, tag: "UPDATE 2", want: domain.Fail(500, "INTERNAL", "服务暂不可用")},
			{name: "update error", expiresIn: 60000, execErr: errors.New("update"), want: domain.Fail(500, "INTERNAL", "服务暂不可用")},
			{name: "update lock", expiresIn: 60000, execErr: &pgconn.PgError{Code: "55P03"}, want: &domain.APIError{Status: 503, Code: "INTERNAL", Message: "资源正在更新，请稍后重试", RetryAfter: "1"}},
		} {
			t.Run(entry.name+"/"+c.name, func(t *testing.T) {
				before := time.Now().UnixMilli()
				id := writer.ProcessIdentity()
				tx := &leaseTx{
					t: t, ever: true, tag: pgconn.NewCommandTag(c.tag), execErr: c.execErr,
					row: writer.Active{ID: 37, Holder: id.Holder, Instance: id.InstanceID, Fence: 11,
						ExpiresAt: before + c.expiresIn, HeartbeatAt: before - c.heartbeatAgo},
				}
				t.Cleanup(func() { writer.Forget(tx) })
				got := entry.assert(context.Background(), tx, "平台目录写入未启用")
				after := time.Now().UnixMilli()
				if !sameAPI(got, c.want) || tx.calls != 2 {
					t.Fatalf("got %#v want %#v, queries %d", got, c.want, tx.calls)
				}
				wantExecs := 1
				if c.name == "expired" || c.name == "stale heartbeat" {
					wantExecs = 0
				}
				if tx.execs != wantExecs || (tx.execs != 0 && (tx.heartbeat < before || tx.heartbeat > after)) {
					t.Fatalf("updates %d want %d, heartbeat %d outside [%d, %d]", tx.execs, wantExecs, tx.heartbeat, before, after)
				}
				held := writer.Recall(tx)
				if got == nil {
					if held.ID == nil || *held.ID != tx.row.ID || held.Fence == nil || *held.Fence != tx.row.Fence {
						t.Fatalf("audit stamp %+v", held)
					}
				} else if held.ID != nil || held.Fence != nil {
					t.Fatalf("failed write stamped %+v", held)
				}
			})
		}
	}
}

func TestWriterLeaseHeartbeatClock(t *testing.T) {
	const now int64 = 1700000000000
	id := writer.Identity{Holder: writer.HolderAxum, InstanceID: "clock-test"}
	for _, c := range []struct {
		name      string
		expiresAt int64
		heartbeat int64
		allow     bool
	}{
		{"live at boundary", now + 1, now - 60000 + 1, true},
		{"expires at boundary", now, now, false},
		{"heartbeat at boundary", now + 1, now - 60000, false},
	} {
		t.Run(c.name, func(t *testing.T) {
			tx := &leaseTx{
				t: t, ever: true, tag: pgconn.NewCommandTag("UPDATE 1"),
				row: writer.Active{ID: 83, Holder: id.Holder, Instance: id.InstanceID, Fence: 19,
					ExpiresAt: c.expiresAt, HeartbeatAt: c.heartbeat},
			}
			t.Cleanup(func() { writer.Forget(tx) })
			held, err := writer.Assert(context.Background(), tx, "admin", id, now, "disabled")
			if tx.calls != 2 {
				t.Fatalf("queries %d", tx.calls)
			}
			if c.allow {
				if err != nil || tx.execs != 1 || tx.heartbeat != now || held.ID == nil || *held.ID != tx.row.ID || held.Fence == nil || *held.Fence != tx.row.Fence {
					t.Fatalf("held %+v err %v updates %d heartbeat %d", held, err, tx.execs, tx.heartbeat)
				}
			} else if !writer.IsDisabled(err) || err.Error() != "disabled" || tx.execs != 0 || held.ID != nil || held.Fence != nil {
				t.Fatalf("refused lease: held %+v err %v updates %d", held, err, tx.execs)
			}
		})
	}
}

func legacyAssertWriteLease(ctx context.Context, tx pgx.Tx, disabledMessage string) error {
	_, err := writer.Assert(ctx, tx, "admin", writer.ProcessIdentity(), 0, disabledMessage)
	if writer.IsDisabled(err) {
		return domain.Fail(503, "WRITES_DISABLED", disabledMessage)
	}
	if err != nil {
		return mapAdmin(err, "INTERNAL")
	}
	return nil
}

func TestCatalogInsertAuditMatchesLegacy(t *testing.T) {
	row := domain.Audit{
		OrgID: 1, UserID: 2, Module: "admin", EntityType: "sc_product", EntityID: "p",
		Method: "POST", Path: "/api/admin/platform-catalog/products", Action: "sc_product_created", Message: `{"summary":"棉袜"}`,
	}
	got, want := &execTx{}, &execTx{}
	gotErr := InsertAudit(context.Background(), got, row)
	wantErr := legacyCatalogInsertAudit(context.Background(), want, row)
	if gotErr != wantErr || strings.Join(strings.Fields(got.sql), " ") != strings.Join(strings.Fields(want.sql), " ") || len(got.args) != len(want.args) {
		t.Fatalf("got %q %#v %v\nwant %q %#v %v", got.sql, got.args, gotErr, want.sql, want.args, wantErr)
	}
	for i := range got.args {
		if got.args[i] != want.args[i] {
			t.Fatalf("arg %d: %#v != %#v", i, got.args[i], want.args[i])
		}
	}
}

func legacyCatalogInsertAudit(ctx context.Context, tx pgx.Tx, a domain.Audit) error {
	leaseID, fence := writer.AuditArgs(tx)
	_, err := tx.Exec(ctx, `INSERT INTO audit_logs
		(org_id, user_id, module, entity_type, entity_id, api_method, api_path,
		 action, status, result, message, shop_id, created_at_ms, created_at,
		 actor_kind, support_grant_id, writer_lease_id, writer_fence_token)
		VALUES ($1, $2, $3, $4, $5, $6, $7,
		        $8, 'success', 'applied', $9, NULL,
		        (EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::bigint,
		        clock_timestamp(), 'user', NULL, $10, $11)`,
		a.OrgID, a.UserID, a.Module, a.EntityType, a.EntityID, a.Method, a.Path, a.Action, a.Message, leaseID, fence)
	return err
}

type leaseTx struct {
	pgx.Tx
	t         *testing.T
	calls     int
	first     error
	ever      bool
	row       writer.Active
	tag       pgconn.CommandTag
	execErr   error
	execs     int
	heartbeat int64
}

func (l *leaseTx) QueryRow(_ context.Context, sql string, args ...any) pgx.Row {
	l.t.Helper()
	l.calls++
	wantSQL := "SELECT EXISTS(SELECT 1 FROM writer_leases WHERE domain = $1)"
	if l.calls == 1 {
		wantSQL = "SELECT id, holder, holder_instance, fence_token, expires_at_ms, heartbeat_at_ms FROM writer_leases WHERE domain = $1 AND revoked_at_ms IS NULL FOR UPDATE"
	}
	if l.calls > 2 || strings.Join(strings.Fields(sql), " ") != wantSQL || len(args) != 1 || args[0] != "admin" {
		l.t.Fatalf("query %d: %q %#v", l.calls, sql, args)
	}
	if l.calls == 1 {
		return leaseRow{err: l.first, set: func(dest ...any) error {
			*(dest[0].(*int64)) = l.row.ID
			*(dest[1].(*string)) = l.row.Holder
			*(dest[2].(*string)) = l.row.Instance
			*(dest[3].(*int64)) = l.row.Fence
			*(dest[4].(*int64)) = l.row.ExpiresAt
			*(dest[5].(*int64)) = l.row.HeartbeatAt
			return nil
		}}
	}
	return leaseRow{set: func(dest ...any) error {
		*(dest[0].(*bool)) = l.ever
		return nil
	}}
}

func (l *leaseTx) Exec(_ context.Context, sql string, args ...any) (pgconn.CommandTag, error) {
	l.t.Helper()
	l.execs++
	const wantSQL = "UPDATE writer_leases SET heartbeat_at_ms = $2::bigint, expires_at_ms = $2::bigint + $3::bigint WHERE id = $1 AND revoked_at_ms IS NULL"
	if l.calls != 2 || strings.Join(strings.Fields(sql), " ") != wantSQL || len(args) != 3 || args[0] != l.row.ID || args[2] != int64(60000) {
		l.t.Fatalf("heartbeat query %q %#v after %d queries", sql, args, l.calls)
	}
	var ok bool
	l.heartbeat, ok = args[1].(int64)
	if !ok {
		l.t.Fatalf("heartbeat type %T", args[1])
	}
	return l.tag, l.execErr
}

type leaseRow struct {
	err error
	set func(...any) error
}

func (s leaseRow) Scan(dest ...any) error {
	if s.err != nil {
		return s.err
	}
	if s.set != nil {
		return s.set(dest...)
	}
	return nil
}

func sameAPI(got, want error) bool {
	if got == nil || want == nil {
		return got == want
	}
	g, ok1 := got.(*domain.APIError)
	w, ok2 := want.(*domain.APIError)
	if !ok1 || !ok2 {
		return false
	}
	return g.Status == w.Status && g.Code == w.Code && g.Message == w.Message && g.RetryAfter == w.RetryAfter
}
