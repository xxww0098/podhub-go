package adminrepo

import (
	"context"
	"errors"

	"github.com/jackc/pgx/v5"

	"github.com/xxww0098/podhub-go/internal/admin/contract"
	"github.com/xxww0098/podhub-go/internal/admin/domain"
	"github.com/xxww0098/podhub-go/internal/platform/writer"
)

func scanLease(row pgx.Row) (domain.LeaseRow, error) {
	var rowLease domain.LeaseRow
	err := row.Scan(&rowLease.ID, &rowLease.Domain, &rowLease.Holder, &rowLease.HolderInstance, &rowLease.Fence,
		&rowLease.GrantedAt, &rowLease.ExpiresAt, &rowLease.HeartbeatAt, &rowLease.RevokedAt, &rowLease.Reason)
	return rowLease, err
}

const leaseCols = `
SELECT id, domain, holder, holder_instance, fence_token, granted_at_ms,
       expires_at_ms, heartbeat_at_ms, revoked_at_ms, grant_reason
FROM writer_leases`

// LeaseStatus reads the seven domains and audits {"count":7}.
func (s *Store) LeaseStatus(ctx context.Context, actor domain.Actor) ([]domain.LeaseRow, []bool, *contract.Fault) {
	var rows []domain.LeaseRow
	var ever []bool
	for _, name := range domain.LeaseDomains {
		var item domain.LeaseRow
		err := s.pool.QueryRow(ctx, leaseCols+`
WHERE domain = $1 AND revoked_at_ms IS NULL
ORDER BY id DESC LIMIT 1`, name).Scan(&item.ID, &item.Domain, &item.Holder, &item.HolderInstance, &item.Fence,
			&item.GrantedAt, &item.ExpiresAt, &item.HeartbeatAt, &item.RevokedAt, &item.Reason)
		if errors.Is(err, pgx.ErrNoRows) {
			item.Domain = name
			item.ID = 0
		} else if err != nil {
			return nil, nil, dbFault(err)
		}
		rows = append(rows, item)
		var exists bool
		if err := s.pool.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM writer_leases WHERE domain = $1)`, name).Scan(&exists); err != nil {
			return nil, nil, dbFault(err)
		}
		ever = append(ever, exists)
	}
	if err := s.auditAfter(ctx, auditRow{
		OrgID: orgFloor(actor.OrgID), UserID: actor.ID, Module: "admin", EntityType: "writer_lease",
		EntityID: "*", Method: "GET", Path: "/api/admin/writer-leases", Action: "writer_lease_status_listed",
		Message: `{"count":7}`,
	}); err != nil {
		return nil, nil, dbFault(err)
	}
	return rows, ever, nil
}

func (s *Store) lockLease(ctx context.Context, tx pgx.Tx, name string) (*domain.LeaseRow, error) {
	if name == "auth" {
		if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock_shared($1)`, writer.AuthGateKey); err != nil {
			return nil, err
		}
	}
	row, err := scanLease(tx.QueryRow(ctx, leaseCols+`
WHERE domain = $1 AND revoked_at_ms IS NULL
FOR UPDATE`, name))
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &row, nil
}

// GrantLease runs the grant transaction. It does not use the admin writer gate.
func (s *Store) GrantLease(ctx context.Context, actor domain.Actor, name, holder, instance, reason string, expected *int64) (domain.LeaseRow, *contract.Fault) {
	var out domain.LeaseRow
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return domain.LeaseRow{}, dbFault(err)
	}
	defer tx.Rollback(ctx)
	defer endLease(tx)
	current, err := s.lockLease(ctx, tx, name)
	if err != nil {
		return domain.LeaseRow{}, dbFault(err)
	}
	now := s.Now().UnixMilli()
	var live *domain.Lease
	if current != nil {
		live = &domain.Lease{
			ID: current.ID, Domain: current.Domain, Holder: current.Holder, HolderInstance: current.HolderInstance,
			Fence: current.Fence, GrantedAt: current.GrantedAt, ExpiresAt: current.ExpiresAt, HeartbeatAt: current.HeartbeatAt,
			RevokedAt: current.RevokedAt, Reason: current.Reason,
		}
	}
	same := current != nil && current.Holder == holder && current.HolderInstance == instance
	decision := domain.DecideGrant(live, same, expected, now, name)
	if decision.Fence != "" {
		return domain.LeaseRow{}, contract.Conflict(decision.Fence)
	}
	if decision.Conflict != "" {
		return domain.LeaseRow{}, contract.Conflict(decision.Conflict)
	}
	if decision.Reuse && current != nil {
		out = *current
	} else {
		if decision.RevokeFirst && current != nil {
			now = s.Now().UnixMilli()
			if _, err := tx.Exec(ctx, `UPDATE writer_leases SET revoked_at_ms = $2 WHERE id = $1 AND revoked_at_ms IS NULL`, current.ID, now); err != nil {
				return domain.LeaseRow{}, dbFault(err)
			}
		}
		var fence int64
		if err := tx.QueryRow(ctx, `SELECT nextval('public.writer_lease_fence_seq')::bigint`).Scan(&fence); err != nil {
			return domain.LeaseRow{}, dbFault(err)
		}
		out, err = scanLease(tx.QueryRow(ctx, `
INSERT INTO writer_leases
       (domain, holder, holder_instance, fence_token, granted_at_ms,
        expires_at_ms, heartbeat_at_ms, revoked_at_ms, grant_reason)
VALUES ($1, $2, $3, $4, $5, $6, $5, NULL, $7)
RETURNING id, domain, holder, holder_instance, fence_token, granted_at_ms,
          expires_at_ms, heartbeat_at_ms, revoked_at_ms, grant_reason`,
			name, holder, instance, fence, now, now+writer.LeaseTTLMS, reason))
		if err != nil {
			return domain.LeaseRow{}, dbFault(err)
		}
		if _, err := tx.Exec(ctx, `
INSERT INTO writer_lease_events
       (lease_id, domain, action, holder, holder_instance, fence_token,
        expected_fence, reason, created_at_ms)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
			out.ID, name, domain.GrantEvent(holder), holder, instance, out.Fence, expected, reason, now); err != nil {
			return domain.LeaseRow{}, dbFault(err)
		}
	}
	msg := jsonText(struct {
		Holder         string `json:"holder"`
		HolderInstance string `json:"holder_instance"`
		Reason         string `json:"reason"`
		ExpectedFence  *int64 `json:"expected_fence"`
	}{holder, instance, reason, expected})
	if err := insertAudit(ctx, tx, auditRow{
		OrgID: orgFloor(actor.OrgID), UserID: actor.ID, Module: "admin", EntityType: "writer_lease",
		EntityID: name, Method: "POST", Path: "/api/admin/writer-leases/grant", Action: "writer_lease_granted", Message: msg,
	}); err != nil {
		return domain.LeaseRow{}, dbFault(err)
	}
	if err := tx.Commit(ctx); err != nil {
		return domain.LeaseRow{}, dbFault(err)
	}
	return out, nil
}

// RevokeLease revokes the live row. A missing row with no expected fence still audits.
func (s *Store) RevokeLease(ctx context.Context, actor domain.Actor, name, reason string, expected *int64) (*domain.LeaseRow, *contract.Fault) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return nil, dbFault(err)
	}
	defer tx.Rollback(ctx)
	defer endLease(tx)
	current, err := s.lockLease(ctx, tx, name)
	if err != nil {
		return nil, dbFault(err)
	}
	var live *domain.Lease
	if current != nil {
		live = &domain.Lease{Fence: current.Fence, RevokedAt: current.RevokedAt}
	}
	skip, mismatch := domain.DecideRevoke(live, expected, name)
	if mismatch != "" {
		return nil, contract.Conflict(mismatch)
	}
	now := s.Now().UnixMilli()
	var out *domain.LeaseRow
	if !skip && current != nil {
		if _, err := tx.Exec(ctx, `UPDATE writer_leases SET revoked_at_ms = $2 WHERE id = $1 AND revoked_at_ms IS NULL`, current.ID, now); err != nil {
			return nil, dbFault(err)
		}
		copied := *current
		copied.RevokedAt = &now
		out = &copied
		if _, err := tx.Exec(ctx, `
INSERT INTO writer_lease_events
       (lease_id, domain, action, holder, holder_instance, fence_token,
        expected_fence, reason, created_at_ms)
VALUES ($1, $2, 'revoke', $3, $4, $5, $6, $7, $8)`,
			current.ID, name, current.Holder, current.HolderInstance, current.Fence, expected, reason, now); err != nil {
			return nil, dbFault(err)
		}
	}
	msg := jsonText(struct {
		Reason        string `json:"reason"`
		ExpectedFence *int64 `json:"expected_fence"`
	}{reason, expected})
	if err := insertAudit(ctx, tx, auditRow{
		OrgID: orgFloor(actor.OrgID), UserID: actor.ID, Module: "admin", EntityType: "writer_lease",
		EntityID: name, Method: "POST", Path: "/api/admin/writer-leases/revoke", Action: "writer_lease_revoked", Message: msg,
	}); err != nil {
		return nil, dbFault(err)
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, dbFault(err)
	}
	return out, nil
}
