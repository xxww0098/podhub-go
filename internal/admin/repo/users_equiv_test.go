package adminrepo

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"reflect"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"github.com/xxww0098/podhub-go/internal/admin/contract"
	"github.com/xxww0098/podhub-go/internal/platform/writer"
)

// The legacy* functions below are the admin/repo bodies before they moved to
// admin/core/repo, kept verbatim so the tables compare old and new output.

func legacyDBFault(err error) *contract.Fault {
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) {
		switch pgErr.Code {
		case "55P03":
			return &contract.Fault{Status: 503, Code: "INTERNAL", Message: "资源正在更新，请稍后重试", RetryAfter: 1}
		case "P0M01":
			return &contract.Fault{Status: 409, Code: "INTERNAL", Message: "媒体对象已进入回收，请重新上传"}
		}
	}
	return contract.Internal("服务暂不可用")
}

func legacyPlainFault(err error) *contract.Fault {
	if err == nil {
		return nil
	}
	if f, ok := contract.AsFault(err); ok {
		return f
	}
	return contract.Internal("服务暂不可用")
}

func legacyInsertAudit(ctx context.Context, tx pgx.Tx, row auditRow) error {
	leaseID, fence := writer.AuditArgs(tx)
	_, err := tx.Exec(ctx, `
INSERT INTO audit_logs
       (org_id, user_id, module, entity_type, entity_id, api_method, api_path,
        action, status, result, message, shop_id, created_at_ms, created_at,
        actor_kind, support_grant_id, writer_lease_id, writer_fence_token)
VALUES ($1, $2, $3, $4, $5, $6, $7,
        $8, 'success', 'applied', $9, NULL,
        (EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::bigint,
        clock_timestamp(), 'user', NULL, $10, $11)`,
		row.OrgID, row.UserID, row.Module, row.EntityType, row.EntityID,
		row.Method, row.Path, row.Action, row.Message, leaseID, fence)
	return err
}

func legacyOrgFloor(id int64) int64 {
	if id < 0 {
		return 0
	}
	return id
}

func legacyJSONText(v any) string {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	_ = enc.Encode(v)
	b := buf.Bytes()
	if len(b) > 0 && b[len(b)-1] == '\n' {
		b = b[:len(b)-1]
	}
	return string(b)
}

func faultErrs() []error {
	own := contract.Validation("x")
	return []error{
		nil,
		own,
		fmt.Errorf("wrap: %w", own),
		&pgconn.PgError{Code: "55P03"},
		fmt.Errorf("wrap: %w", &pgconn.PgError{Code: "P0M01"}),
		&pgconn.PgError{Code: "23505"},
		pgx.ErrNoRows,
		errors.New("boom"),
	}
}

func TestDBFaultMatchesLegacy(t *testing.T) {
	for _, err := range faultErrs() {
		if got, want := dbFault(err), legacyDBFault(err); !reflect.DeepEqual(got, want) {
			t.Fatalf("%v: got %+v want %+v", err, got, want)
		}
	}
}

func TestPlainFaultMatchesLegacy(t *testing.T) {
	for _, err := range faultErrs() {
		got, want := plainFault(err), legacyPlainFault(err)
		if !reflect.DeepEqual(got, want) {
			t.Fatalf("%v: got %+v want %+v", err, got, want)
		}
		if want != nil && want.Message == "x" && got != want {
			t.Fatalf("%v: passed-through fault is a different pointer", err)
		}
	}
}

func TestInsertAuditMatchesLegacy(t *testing.T) {
	row := auditRow{OrgID: 3, UserID: 4, Module: "admin", EntityType: "user", EntityID: "u1", Method: "PATCH", Path: "/p", Action: "role_changed", Message: `{"a":1}`}
	for _, execErr := range []error{nil, errors.New("exec failed")} {
		for _, write := range []bool{false, true} {
			got, want := &execTx{err: execErr}, &execTx{err: execErr}
			var gotErr error
			if write {
				gotErr = writeAudit(context.Background(), got, row)
			} else {
				gotErr = insertAudit(context.Background(), got, row)
			}
			wantErr := legacyInsertAudit(context.Background(), want, row)
			if gotErr != wantErr || got.sql != want.sql || !reflect.DeepEqual(got.args, want.args) {
				t.Fatalf("write=%v: got %q %#v %v, want %q %#v %v", write, got.sql, got.args, gotErr, want.sql, want.args, wantErr)
			}
		}
	}
}

func TestOrgFloorMatchesLegacy(t *testing.T) {
	for _, n := range []int64{math.MinInt64, -1, 0, 1, math.MaxInt64} {
		if got, want := orgFloor(n), legacyOrgFloor(n); got != want {
			t.Fatalf("%d: got %d want %d", n, got, want)
		}
	}
}

func TestJSONTextMatchesLegacy(t *testing.T) {
	for _, v := range []any{nil, 1, "<a&b>", []string{"x"}, map[string]any{"b": 1, "a": "é"}, struct {
		A string `json:"a"`
	}{"z"}, make(chan int), func() {}} {
		if got, want := jsonText(v), legacyJSONText(v); got != want {
			t.Fatalf("%T: got %q want %q", v, got, want)
		}
	}
}
