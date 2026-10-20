package storerepo

import (
	"context"
	"encoding/json"
	"errors"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"github.com/xxww0098/podhub-go/internal/store/contract"
	"github.com/xxww0098/podhub-go/internal/store/domain"
)

// projectionColumns is the one Store roster projection. Every query path
// selects these columns, so a new credential column or verification rule is
// added once. The assignee display name is a scalar subquery rather than a
// LEFT JOIN because the mutation path takes FOR UPDATE, and PostgreSQL refuses
// FOR UPDATE on the nullable side of an outer join.
const projectionColumns = `
s.id, lower(s.uuid::text), s.create_order, s.name, s.client_id,
s.manual_disabled, s.quota_suspended, s.credential_revision,
EXISTS (SELECT 1 FROM public.store_seller_credentials c
         WHERE c.store_id = s.id AND c.credential_revision = s.credential_revision),
EXISTS (SELECT 1 FROM public.store_seller_credentials c WHERE c.store_id = s.id),
(SELECT COUNT(*) FILTER (WHERE v.verified)
   FROM public.store_credential_verifications v
  WHERE v.org_id = s.org_id AND v.store_id = s.id
    AND v.credential_revision = s.credential_revision),
(SELECT MAX(v.verified_at_ms) FILTER (WHERE v.verified)
   FROM public.store_credential_verifications v
  WHERE v.org_id = s.org_id AND v.store_id = s.id
    AND v.credential_revision = s.credential_revision),
(SELECT c.last_leased_at_ms FROM public.store_seller_credentials c
  WHERE c.store_id = s.id AND c.credential_revision = s.credential_revision),
(SELECT c.key_expires_at_ms FROM public.store_seller_credentials c
  WHERE c.store_id = s.id AND c.credential_revision = s.credential_revision),
s.assignee_membership_id, s.assignee_key_manage, s.product_quota, s.finance_balance,
(SELECT COALESCE(NULLIF(btrim(m.display_name), ''), u.email)
   FROM public.organization_members m
   JOIN public.account_users u ON u.id = m.user_id
  WHERE m.id = s.assignee_membership_id),
(SELECT u.email
   FROM public.organization_members m
   JOIN public.account_users u ON u.id = m.user_id
  WHERE m.id = s.assignee_membership_id),
s.revision, s.deleted_at_ms,
(SELECT COALESCE(jsonb_agg(jsonb_build_object('uuid', lower(t.uuid::text), 'name', t.name)
                           ORDER BY lower(t.name), t.id), '[]'::jsonb)
   FROM public.store_tag_links l
   JOIN public.organization_store_tags t ON t.id = l.tag_id
  WHERE l.store_id = s.id),
(SELECT jsonb_build_object('uuid', lower(g.uuid::text), 'name', g.name)
   FROM public.organization_store_groups g
  WHERE g.id = s.group_id)`

// scanProjection reads one projection row.
func scanProjection(row pgx.Row) (domain.Row, error) {
	var out domain.Row
	var tagsRaw []byte
	var groupRaw []byte
	err := row.Scan(
		&out.ID, &out.UUID, &out.CreateOrder, &out.Name, &out.ClientID,
		&out.ManualDisabled, &out.QuotaSuspended, &out.CredentialRevision,
		&out.CredentialConfigured, &out.CredentialAnyConfigured,
		&out.CredentialVerifiedOperators, &out.CredentialLastVerifiedAtMS,
		&out.CredentialLastUsedAtMS, &out.CredentialKeyExpiresAtMS,
		&out.AssigneeMembershipID, &out.AssigneeKeyManage,
		&out.ProductQuota, &out.FinanceBalance,
		&out.AssigneeName, &out.AssigneeEmail,
		&out.Revision, &out.DeletedAtMS,
		&tagsRaw, &groupRaw,
	)
	if err != nil {
		return domain.Row{}, err
	}
	out.Tags = decodeTagRefs(tagsRaw)
	out.Group = decodeTagRef(groupRaw)
	return out, nil
}

func decodeTagRefs(raw []byte) []domain.TagRef {
	if len(raw) == 0 {
		return nil
	}
	var rows []struct {
		UUID string `json:"uuid"`
		Name string `json:"name"`
	}
	if err := json.Unmarshal(raw, &rows); err != nil {
		return nil
	}
	out := make([]domain.TagRef, 0, len(rows))
	for _, row := range rows {
		out = append(out, domain.TagRef{UUID: row.UUID, Name: row.Name})
	}
	return out
}

func decodeTagRef(raw []byte) *domain.TagRef {
	if len(raw) == 0 {
		return nil
	}
	var row struct {
		UUID string `json:"uuid"`
		Name string `json:"name"`
	}
	if err := json.Unmarshal(raw, &row); err != nil {
		return nil
	}
	return &domain.TagRef{UUID: row.UUID, Name: row.Name}
}

// LoadActor reads the caller's usable membership of one Workspace. "Usable"
// means an active seat that is neither manually disabled nor quota suspended;
// anything else is MsgMemberUnusable. A row whose stored role this build does
// not know is MsgBadRole.
func (r Repo) LoadActor(ctx context.Context, userID, orgID int64) (domain.Actor, *contract.APIError) {
	var actor domain.Actor
	err := r.withOrg(ctx, orgID, func(tx pgx.Tx) error {
		var storedRole string
		scan := tx.QueryRow(ctx, `
			SELECT id, role FROM public.organization_members
			 WHERE user_id = $1 AND org_id = $2
			   AND status = 'active' AND NOT manual_disabled AND NOT quota_suspended
			 ORDER BY id
			 LIMIT 1`, userID, orgID).Scan(&actor.MembershipID, &storedRole)
		if errors.Is(scan, pgx.ErrNoRows) {
			return contract.Forbidden(contract.MsgMemberUnusable)
		}
		if scan != nil {
			return scan
		}
		actor.UserID = userID
		actor.Role = storedRole
		return nil
	})
	if err != nil {
		return domain.Actor{}, asAPIError(err, contract.MsgMemberUnusable)
	}
	return actor, nil
}

// ListRows is list_store_rows: every live store the actor may see, in create
// order. A manager sees all; anyone else only their assignment.
func (r Repo) ListRows(ctx context.Context, orgID int64, actor domain.Actor) ([]domain.Row, *contract.APIError) {
	var out []domain.Row
	err := r.withOrg(ctx, orgID, func(tx pgx.Tx) error {
		rows, err := tx.Query(ctx, `
			SELECT `+projectionColumns+`
			  FROM public.organization_stores s
			 WHERE s.org_id = $1 AND s.deleted_at_ms IS NULL
			   AND ($2 OR s.assignee_membership_id = $3)
			 ORDER BY s.create_order ASC, s.id ASC`,
			orgID, actor.CanManageAll(), actor.MembershipID)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			row, err := scanProjection(rows)
			if err != nil {
				return err
			}
			out = append(out, row)
		}
		return rows.Err()
	})
	if err != nil {
		return nil, asAPIError(err, contract.MsgUnavailable)
	}
	return out, nil
}

// LoadMutationRow loads one store under a row lock. It deliberately does not
// filter tombstones: a deleted row must still lock and answer "Store 已删除"
// rather than "Store 不存在".
func (r Repo) LoadMutationRow(ctx context.Context, tx pgx.Tx, orgID int64, uuid string) (domain.Row, error) {
	row, err := scanProjection(tx.QueryRow(ctx, `
		SELECT `+projectionColumns+`
		  FROM public.organization_stores s
		 WHERE s.org_id = $1 AND s.uuid = $2::uuid
		 LIMIT 1
		 FOR UPDATE`, orgID, uuid))
	if errors.Is(err, pgx.ErrNoRows) {
		return domain.Row{}, contract.NotFound(contract.MsgStoreMissing)
	}
	if err != nil {
		return domain.Row{}, err
	}
	if row.DeletedAtMS != nil {
		return domain.Row{}, contract.NotFound(contract.MsgStoreDeleted)
	}
	return row, nil
}

// loadStoreForCredential is credential_store::load_store: the narrow row the
// credential writers need, locked for update.
func (r Repo) loadStoreForCredential(ctx context.Context, tx pgx.Tx, orgID int64, uuid string) (domain.Row, error) {
	var out domain.Row
	var deleted *int64
	err := tx.QueryRow(ctx, `
		SELECT s.id, lower(s.uuid::text), s.client_id, s.credential_revision, s.revision,
		       s.manual_disabled, s.quota_suspended, s.assignee_membership_id,
		       s.assignee_key_manage, s.deleted_at_ms
		  FROM public.organization_stores s
		 WHERE s.org_id = $1 AND s.uuid = $2::uuid
		 LIMIT 1
		 FOR UPDATE`, orgID, uuid).Scan(
		&out.ID, &out.UUID, &out.ClientID, &out.CredentialRevision, &out.Revision,
		&out.ManualDisabled, &out.QuotaSuspended, &out.AssigneeMembershipID,
		&out.AssigneeKeyManage, &deleted)
	if errors.Is(err, pgx.ErrNoRows) {
		return domain.Row{}, contract.NotFound(contract.MsgStoreMissing)
	}
	if err != nil {
		return domain.Row{}, err
	}
	out.DeletedAtMS = deleted
	if deleted != nil {
		return domain.Row{}, contract.NotFound(contract.MsgStoreDeleted)
	}
	return out, nil
}

// lockWorkspaceRow takes the Workspace row lock every roster write serialises
// on. The tenant GUC is already bound by tenantx.BeginApp, the only place it
// may be set. A missing or dissolved Workspace is one domain refusal.
func lockWorkspaceRow(ctx context.Context, tx pgx.Tx, orgID int64) *contract.APIError {
	var dissolved bool
	err := tx.QueryRow(ctx, `
		SELECT dissolved_at IS NOT NULL FROM public.organizations
		 WHERE id = $1
		 FOR NO KEY UPDATE`, orgID).Scan(&dissolved)
	if errors.Is(err, pgx.ErrNoRows) || dissolved {
		return contract.NotFound(contract.MsgWorkspaceMissing)
	}
	if err != nil {
		return contract.Internal()
	}
	return nil
}

// bumpQuotaRevision advances the Workspace quota revision every roster write
// that changes entitlement converges on.
func bumpQuotaRevision(ctx context.Context, tx pgx.Tx, orgID int64) error {
	_, err := tx.Exec(ctx, `
		UPDATE public.organizations
		   SET quota_revision = quota_revision + 1,
		       updated_at = clock_timestamp()
		 WHERE id = $1`, orgID)
	return err
}

// asAPIError keeps an already-typed refusal and turns anything else into the
// database answer the caller's route uses.
func asAPIError(err error, unavailable string) *contract.APIError {
	if api, ok := contract.AsAPIError(err); ok {
		return api
	}
	return &contract.APIError{
		Status:  500,
		Code:    contract.CodeInternal,
		Message: unavailable,
	}
}

// mapConflict turns a unique-index violation into the caller-facing refusal.
// A nil result means the error is a server fault.
func mapConflict(err error) error {
	var pg *pgconn.PgError
	if !errors.As(err, &pg) || pg.Code != "23505" {
		return err
	}
	if api := domain.ConflictByIndex(pg.ConstraintName); api != nil {
		return api
	}
	return err
}

// domainNowMS is the clock the roster writes stamp and compare with.
func domainNowMS() int64 { return domain.NowMS() }
