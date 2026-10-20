package adminrepo

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"reflect"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"github.com/xxww0098/podhub-go/internal/admin/domain"
)

// The legacy* functions are the bodies admin/repo had before they moved to
// admin/core/repo, kept verbatim so the tables compare old and new output.

type legacyFault struct{ Kind, Code, Message string }

func legacyFaultOf(kind, code, message string) *legacyFault {
	return &legacyFault{Kind: kind, Code: code, Message: message}
}

func (f *legacyFault) Error() string { return f.Message }

func legacyMapBill(err error, code string, lock bool) (error, *legacyFault) {
	if err == nil {
		return nil, nil
	}
	var fault *domain.Fault
	if errors.As(err, &fault) {
		return err, nil
	}
	var pg *pgconn.PgError
	if errors.As(err, &pg) && pg.Code == "55P03" && lock {
		return nil, legacyFaultOf("locked", code, "资源正在更新，请稍后重试")
	}
	if errors.As(err, &pg) && pg.Code == "P0M01" {
		return nil, legacyFaultOf("conflict", code, "媒体对象已进入回收，请重新上传")
	}
	return nil, legacyFaultOf("internal", code, "服务暂不可用")
}

func legacyData(v any) ([]byte, *legacyFault) {
	body, err := json.Marshal(struct {
		Data any `json:"data"`
	}{Data: v})
	if err != nil {
		return nil, legacyFaultOf("internal", "INTERNAL", "服务暂不可用")
	}
	return body, nil
}

func legacyAuditBill(ctx context.Context, tx pgx.Tx, orgID, userID int64, module, entityType, entityID, method, path, action, message string, held lease) error {
	_, err := tx.Exec(ctx, `
		INSERT INTO audit_logs
		       (org_id, user_id, module, entity_type, entity_id, api_method, api_path,
		        action, status, result, message, shop_id, created_at_ms, created_at,
		        actor_kind, support_grant_id, writer_lease_id, writer_fence_token)
		VALUES ($1, $2, $3, $4, $5, $6, $7,
		        $8, 'success', 'applied', $9, NULL,
		        (EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::bigint,
		        clock_timestamp(), 'user', NULL, $10, $11)`,
		orgID, userID, module, entityType, entityID, method, path, action, message, held.id, held.fence)
	return err
}

func sameFault(t *testing.T, name string, got error, want *legacyFault) {
	t.Helper()
	f, ok := got.(*domain.Fault)
	if !ok || f == nil {
		t.Fatalf("%s: got %#v, want fault %#v", name, got, want)
	}
	if f.Kind != want.Kind || f.Code != want.Code || f.Message != want.Message || f.Error() != want.Error() {
		t.Fatalf("%s: got %#v, want %#v", name, f, want)
	}
}

func TestMapBillMatchesLegacy(t *testing.T) {
	passFault := domain.Validation("VALIDATION", "x")
	cases := []struct {
		name string
		err  error
		lock bool
	}{
		{"nil", nil, true},
		{"fault", passFault, false},
		{"wrapped fault", fmt.Errorf("w: %w", passFault), true},
		{"lock busy, lock", &pgconn.PgError{Code: "55P03"}, true},
		{"lock busy, no lock", &pgconn.PgError{Code: "55P03"}, false},
		{"wrapped lock busy", fmt.Errorf("w: %w", &pgconn.PgError{Code: "55P03"}), true},
		{"media retired", &pgconn.PgError{Code: "P0M01"}, false},
		{"media retired, lock", fmt.Errorf("w: %w", &pgconn.PgError{Code: "P0M01"}), true},
		{"other pg", &pgconn.PgError{Code: "23505"}, true},
		{"no rows", pgx.ErrNoRows, false},
		{"plain", errors.New("boom"), true},
	}
	for _, code := range []string{"INTERNAL", "internal", "CONFLICT"} {
		for _, c := range cases {
			name := c.name + "/" + code
			got := mapBill(c.err, code, c.lock)
			passed, want := legacyMapBill(c.err, code, c.lock)
			if want == nil {
				if got != passed {
					t.Fatalf("%s: got %v, want %v", name, got, passed)
				}
				continue
			}
			sameFault(t, name, got, want)
		}
	}
}

func TestDataMatchesLegacy(t *testing.T) {
	for _, v := range []any{nil, 1, "x", []string{"a"}, map[string]any{"k": 1.5}, struct{ A int }{2}, make(chan int), func() {}} {
		got, err := data(v)
		want, fault := legacyData(v)
		if fault != nil {
			if got != nil {
				t.Fatalf("%T: body %q on error", v, got)
			}
			sameFault(t, fmt.Sprintf("%T", v), err, fault)
			continue
		}
		if err != nil || string(got) != string(want) {
			t.Fatalf("%T: got %q %v, want %q", v, got, err, want)
		}
	}
}

type execTx struct {
	pgx.Tx
	sql  string
	args []any
	err  error
}

func (e *execTx) Exec(_ context.Context, sql string, args ...any) (pgconn.CommandTag, error) {
	e.sql, e.args = sql, args
	return pgconn.CommandTag{}, e.err
}

func TestAuditBillMatchesLegacy(t *testing.T) {
	id, fence := int64(7), int64(9)
	for _, c := range []struct {
		held lease
		err  error
	}{
		{lease{}, nil},
		{lease{id: &id, fence: &fence}, nil},
		{lease{id: &id}, errors.New("exec failed")},
	} {
		got, want := &execTx{err: c.err}, &execTx{err: c.err}
		gotErr := auditBill(context.Background(), got, 1, 2, "m", "et", "eid", "GET", "/p", "act", "msg", c.held)
		wantErr := legacyAuditBill(context.Background(), want, 1, 2, "m", "et", "eid", "GET", "/p", "act", "msg", c.held)
		if gotErr != wantErr || got.sql != want.sql || !reflect.DeepEqual(got.args, want.args) {
			t.Fatalf("held %+v: got %q %#v %v, want %q %#v %v", c.held, got.sql, got.args, gotErr, want.sql, want.args, wantErr)
		}
	}
}

func TestFaultConstructorsMatchLegacy(t *testing.T) {
	cases := []struct {
		got  *domain.Fault
		want *legacyFault
	}{
		{domain.Validation("C", "m"), legacyFaultOf("validation", "C", "m")},
		{domain.Forbidden("C", "m"), legacyFaultOf("forbidden", "C", "m")},
		{domain.Conflict("C", "m"), legacyFaultOf("conflict", "C", "m")},
		{domain.NotFound("C", "m"), legacyFaultOf("not_found", "C", "m")},
		{domain.Internal("C", "m"), legacyFaultOf("internal", "C", "m")},
		{domain.WritesDisabled("C", "m"), legacyFaultOf("writes_disabled", "C", "m")},
		{domain.Unavailable("C", "m"), legacyFaultOf("unavailable", "C", "m")},
		{domain.Fulfillment("m"), legacyFaultOf("fulfillment", "INTERNAL", "m")},
		{domain.Upstream("C", "m"), legacyFaultOf("upstream", "C", "m")},
		{domain.Locked("C", "m"), legacyFaultOf("locked", "C", "资源正在更新，请稍后重试")},
	}
	for _, c := range cases {
		sameFault(t, c.want.Kind, c.got, c.want)
	}
	var nilFault *domain.Fault
	if nilFault.Error() != "" {
		t.Fatal("nil fault error text")
	}
}
