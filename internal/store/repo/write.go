package storerepo

import (
	"context"
	"encoding/json"

	"github.com/jackc/pgx/v5"

	"github.com/xxww0098/podhub-go/internal/platform/writer"
	"github.com/xxww0098/podhub-go/internal/store/contract"
)

// The writer lease domain every Workspace Store roster write holds. Rust uses
// CapabilityDomain::Entitlement for the same routes.
const leaseDomain = "entitlement"

// Audit is one audit_logs row a Store write records. Module and entity type are
// per route; entity ID is the store or tag UUID the operator acted on.
type Audit struct {
	Module     string
	EntityType string
	EntityID   string
	Method     string
	Path       string
	Action     string
	Message    any
}

// writeTx runs fn inside one tenant transaction with the entitlement writer
// lease held and at least one audit row required. It is Go's shape of
// write_under_authority: a transaction whose closure records nothing is rolled
// back, because a write no operator can see afterwards is a bug.
func (r Repo) writeTx(ctx context.Context, orgID, userID int64, disabled string, fn func(context.Context, pgx.Tx) error) *contract.APIError {
	if orgID <= 0 {
		return contract.Internal()
	}
	if r.pool == nil || r.begin == nil {
		return contract.Internal()
	}
	var recorded int
	var fnErr error
	tx, err := r.begin(ctx, r.pool.Begin, orgID)
	if err != nil {
		return contract.Internal()
	}
	defer tx.Rollback(ctx)
	defer writer.Forget(tx)
	if _, err := writer.Assert(ctx, tx, leaseDomain, writer.ProcessIdentity(), domainNowMS(), disabled); err != nil {
		if writer.IsDisabled(err) {
			return contract.WritesDisabled(disabled)
		}
		return contract.Internal()
	}
	ctx = withAuditSink(ctx, &sink{tx: tx, orgID: orgID, userID: userID, recorded: &recorded})
	if fnErr = fn(ctx, tx); fnErr != nil {
		return asAPIError(fnErr, contract.MsgUnavailable)
	}
	if recorded == 0 {
		return contract.Internal()
	}
	if err := tx.Commit(ctx); err != nil {
		return contract.Internal()
	}
	return nil
}

type sinkKey struct{}

type sink struct {
	tx       pgx.Tx
	orgID    int64
	userID   int64
	recorded *int
}

func withAuditSink(ctx context.Context, s *sink) context.Context {
	return context.WithValue(ctx, sinkKey{}, s)
}

// Record inserts one audit row on the transaction running fn. A write path
// calls this exactly where Rust calls sink.record. The writer lease and fence
// come from the lease this transaction already asserted.
func Record(ctx context.Context, row Audit) error {
	s, ok := ctx.Value(sinkKey{}).(*sink)
	if !ok {
		return contract.Internal()
	}
	raw, err := json.Marshal(row.Message)
	if err != nil {
		return err
	}
	leaseID, fence := writer.AuditArgs(s.tx)
	if _, err := s.tx.Exec(ctx, `
		INSERT INTO audit_logs
		       (org_id, user_id, module, entity_type, entity_id, api_method, api_path,
		        action, status, result, message, shop_id, created_at_ms, created_at,
		        actor_kind, support_grant_id, writer_lease_id, writer_fence_token)
		VALUES ($1, $2, $3, $4, $5, $6, $7,
		        $8, 'success', 'applied', $9, NULL,
		        (EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::bigint,
		        clock_timestamp(), 'user', NULL, $10, $11)`,
		s.orgID, s.userID, row.Module, row.EntityType, row.EntityID,
		row.Method, row.Path, row.Action, string(raw), leaseID, fence); err != nil {
		return err
	}
	*s.recorded++
	return nil
}
