// Package corerepo is the SQL plumbing shared by admin and its topic units.
// tests/archtest lets only admin and admin/<topic> repo packages import it.
package corerepo

import (
	"context"
	"encoding/json"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"github.com/xxww0098/podhub-go/internal/admin/core/contract"
	"github.com/xxww0098/podhub-go/internal/platform/writer"
)

const MsgUnavailable = "服务暂不可用"

// Lease is the writer lease stamped on an audit row. The zero value writes NULL.
type Lease struct {
	ID    *int64
	Fence *int64
}

func AuditBill(ctx context.Context, tx pgx.Tx, orgID, userID int64, module, entityType, entityID, method, path, action, message string, held Lease) error {
	_, err := tx.Exec(ctx, `
		INSERT INTO audit_logs
		       (org_id, user_id, module, entity_type, entity_id, api_method, api_path,
		        action, status, result, message, shop_id, created_at_ms, created_at,
		        actor_kind, support_grant_id, writer_lease_id, writer_fence_token)
		VALUES ($1, $2, $3, $4, $5, $6, $7,
		        $8, 'success', 'applied', $9, NULL,
		        (EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::bigint,
		        clock_timestamp(), 'user', NULL, $10, $11)`,
		orgID, userID, module, entityType, entityID, method, path, action, message, held.ID, held.Fence)
	return err
}

func MapBill(err error, code string, lock bool) error {
	if err == nil {
		return nil
	}
	var fault *contract.Fault
	if errors.As(err, &fault) {
		return err
	}
	var pg *pgconn.PgError
	if errors.As(err, &pg) && pg.Code == "55P03" && lock {
		return contract.Locked(code, "")
	}
	if errors.As(err, &pg) && pg.Code == "P0M01" {
		return contract.Conflict(code, "媒体对象已进入回收，请重新上传")
	}
	return contract.Internal(code, MsgUnavailable)
}

func Data(v any) ([]byte, error) {
	body, err := json.Marshal(struct {
		Data any `json:"data"`
	}{Data: v})
	if err != nil {
		return nil, contract.Internal("INTERNAL", MsgUnavailable)
	}
	return body, nil
}

// EndLease drops the lease stamp remembered on this transaction. A pooled
// pgx.Tx can be reused, so every begin must forget before the pointer escapes.
func EndLease(tx pgx.Tx) { writer.Forget(tx) }

// Admit asserts the writer lease for domainName. A disabled domain returns
// disabled; any other failure is returned as is.
func Admit(ctx context.Context, tx pgx.Tx, domainName string, nowMS int64, disabled *contract.Fault) (Lease, error) {
	msg := ""
	if disabled != nil {
		msg = disabled.Message
	}
	held, err := writer.Assert(ctx, tx, domainName, writer.ProcessIdentity(), nowMS, msg)
	if writer.IsDisabled(err) {
		return Lease{}, disabled
	}
	if err != nil {
		return Lease{}, err
	}
	return Lease{ID: held.ID, Fence: held.Fence}, nil
}

func OrgAtLeast0(orgID int64) int64 {
	if orgID < 0 {
		return 0
	}
	return orgID
}

func RFC3339Millis(t time.Time) string {
	return t.UTC().Format("2006-01-02T15:04:05.000Z")
}
