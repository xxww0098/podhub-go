package adminrepo

import (
	"context"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"

	"github.com/xxww0098/podhub-go/internal/admin/contract"
	"github.com/xxww0098/podhub-go/internal/admin/domain"
)

// Dissolve runs the super-admin workspace dissolve sequence inside the admin gate.
func (s *Store) Dissolve(ctx context.Context, actor domain.Actor, uuid, name, path string) *contract.Fault {
	return s.withGate(ctx, "admin", "管理域写入未启用", func(ctx context.Context, tx pgx.Tx) error {
		var locked int64
		if err := tx.QueryRow(ctx, `SELECT id FROM account_users WHERE id = $1 FOR NO KEY UPDATE`, actor.ID).Scan(&locked); err != nil {
			return err
		}
		var orgID int64
		err := tx.QueryRow(ctx, `
SELECT id FROM organizations
WHERE uuid = lower($1)::uuid AND dissolved_at IS NULL
LIMIT 1`, uuid).Scan(&orgID)
		if errors.Is(err, pgx.ErrNoRows) {
			return contract.Forbidden("工作空间不存在")
		}
		if err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `SELECT set_config('app.current_org_id', $1, true)`, fmt.Sprint(orgID)); err != nil {
			return err
		}
		inv, err := tx.Query(ctx, `
SELECT i.id FROM org_invitations i
WHERE i.org_id = $1 AND i.accepted_at IS NULL AND i.revoked_at IS NULL AND i.declined_at IS NULL
ORDER BY i.id
FOR UPDATE`, orgID)
		if err != nil {
			return err
		}
		inv.Close()
		var dissolved bool
		err = tx.QueryRow(ctx, `
SELECT dissolved_at IS NOT NULL FROM organizations WHERE id = $1 FOR NO KEY UPDATE`, orgID).Scan(&dissolved)
		if errors.Is(err, pgx.ErrNoRows) || dissolved {
			return contract.Forbidden("工作空间不存在")
		}
		if err != nil {
			return err
		}
		var current string
		if err := tx.QueryRow(ctx, `SELECT name FROM organizations WHERE id = $1`, orgID).Scan(&current); err != nil {
			return err
		}
		if current != name {
			return contract.Validation("请输入当前工作空间名称以确认解散")
		}
		if _, err := tx.Exec(ctx, `SELECT set_config('app.current_org_id', $1, true)`, fmt.Sprint(orgID)); err != nil {
			return err
		}
		var owner int64
		if err := tx.QueryRow(ctx, `SELECT owner_user_id FROM organizations WHERE id = $1`, orgID).Scan(&owner); err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				return errors.New("workspace wallet owner missing")
			}
			return err
		}
		if _, err := tx.Exec(ctx, `SELECT set_config('app.current_wallet_user_id', $1, true)`, fmt.Sprint(owner)); err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `INSERT INTO user_wallets (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING`, owner); err != nil {
			return err
		}
		if err := tx.QueryRow(ctx, `
SELECT user_id FROM user_wallets
WHERE user_id = (SELECT owner_user_id FROM organizations WHERE id = $1)
FOR UPDATE`, orgID).Scan(&owner); err != nil {
			return err
		}
		var held int64
		if err := tx.QueryRow(ctx, `
SELECT COALESCE(SUM(held_delta_microfen), 0)::bigint FROM wallet_ledger WHERE org_id = $1`, orgID).Scan(&held); err != nil {
			return err
		}
		if held > 0 {
			return contract.Validation("有进行中的 AI 请求尚未结算，请稍后再解散")
		}
		pay, err := tx.Query(ctx, `SELECT id, provider FROM payment_orders WHERE org_id = $1 AND status = 'pending' FOR UPDATE`, orgID)
		if err != nil {
			return err
		}
		for pay.Next() {
			var id int64
			var provider string
			if err := pay.Scan(&id, &provider); err != nil {
				pay.Close()
				return err
			}
			if provider != "manual" {
				pay.Close()
				return contract.Validation("有线上支付订单尚未结清，请确认付款或渠道关单后再解散")
			}
		}
		if err := pay.Err(); err != nil {
			pay.Close()
			return err
		}
		pay.Close()
		if _, err := tx.Exec(ctx, `
UPDATE payment_orders
   SET status = 'canceled', canceled_at = clock_timestamp(),
       qr_code = NULL, pay_url = NULL, updated_at = clock_timestamp()
 WHERE org_id = $1 AND status = 'pending'`, orgID); err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `
UPDATE media_object_leases
   SET expires_at = LEAST(expires_at, clock_timestamp()), updated_at = clock_timestamp()
 WHERE org_id = $1 AND deleted_at IS NULL AND expires_at > clock_timestamp()`, orgID); err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `DELETE FROM store_seller_credentials WHERE org_id = $1`, orgID); err != nil {
			return err
		}
		now := s.Now().UnixMilli()
		if _, err := tx.Exec(ctx, `
UPDATE organization_stores
   SET deleted_at_ms = $1,
       assignee_membership_id = NULL,
       assignee_key_manage = false,
       assignee_key_read = false,
       assignee_key_write = false,
       assignee_key_edit = false,
       revision = revision + 1,
       updated_at = clock_timestamp()
 WHERE org_id = $2 AND deleted_at_ms IS NULL`, now, orgID); err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `
UPDATE org_invitations
   SET revoked_at = clock_timestamp()
 WHERE org_id = $1 AND accepted_at IS NULL AND revoked_at IS NULL AND declined_at IS NULL`, orgID); err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `
UPDATE organizations
   SET dissolved_at = clock_timestamp(), avatar_bytes = NULL, avatar_updated_at_ms = NULL,
       updated_at = clock_timestamp()
 WHERE id = $1 AND dissolved_at IS NULL`, orgID); err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `DELETE FROM organization_members WHERE org_id = $1`, orgID); err != nil {
			return err
		}
		msg := jsonText(struct {
			Summary string `json:"summary"`
			Name    string `json:"name"`
		}{"解散工作空间 " + current, current})
		if err := writeAudit(ctx, tx, auditRow{
			OrgID: orgID, UserID: actor.ID, Module: "admin", EntityType: "organization",
			EntityID: fmt.Sprint(orgID), Method: "POST", Path: path, Action: "workspace_dissolved", Message: msg,
		}); err != nil {
			return err
		}
		if actor.OrgID == orgID {
			var next int64
			if err := tx.QueryRow(ctx, `
SELECT COALESCE((
    SELECT o.id
    FROM organization_members m
    JOIN organizations o ON o.id = m.org_id
    JOIN account_profiles p ON p.user_id = m.user_id
    WHERE m.user_id = $1
      AND m.status = 'active'
      AND NOT m.manual_disabled
      AND NOT m.quota_suspended
      AND o.dissolved_at IS NULL
    ORDER BY (o.id = p.active_org_id) DESC NULLS LAST, (m.role = 'owner') DESC, o.id ASC
    LIMIT 1
), 0)`, actor.ID).Scan(&next); err != nil {
				return err
			}
			if _, err := tx.Exec(ctx, `UPDATE account_users SET active_org_id = $1, updated_at = clock_timestamp() WHERE id = $2`, next, actor.ID); err != nil {
				return err
			}
		}
		return nil
	})
}
