package supplierrepo

import (
	"context"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/xxww0098/podhub-go/internal/admin/contract"
	"github.com/xxww0098/podhub-go/internal/admin/domain"
	"github.com/xxww0098/podhub-go/internal/platform/db/tenantx"
)

// TestPatchAccountPasswordRaisesMustChange pins doc §4.2's staff-reset rule for
// the supplier portal. The admin users surface raises must_change_password in
// SetPassword; this endpoint is the same write point reached through a
// different door, so a super-admin reset here must raise it too. Before this
// test the UPDATE only swapped password_hash, which meant a supplier whose
// password staff had just reset could keep using the account indefinitely
// without ever choosing a password only they know.
func TestPatchAccountPasswordRaisesMustChange(t *testing.T) {
	pool, ctx := supParityDB(t)
	const actorID, memberUserID = int64(910301), int64(910302)
	t.Cleanup(func() {
		c := context.Background()
		_, _ = pool.Exec(c, `DELETE FROM sc_source_members WHERE source_id = 'src_admin_patch_910301'`)
		_, _ = pool.Exec(c, `DELETE FROM sc_sources WHERE source_id = 'src_admin_patch_910301'`)
		_, _ = pool.Exec(c, `DELETE FROM audit_logs WHERE entity_id IN (
			SELECT member_id::text FROM sc_source_members WHERE user_id = $1)`, memberUserID)
		_, _ = pool.Exec(c, `DELETE FROM account_users WHERE id = ANY($1)`, []int64{actorID, memberUserID})
	})
	supSeedLease(t, ctx, pool)
	seedAccountUser(t, ctx, pool, actorID, "a910301", "super_admin", "/workspace", "platform")
	// A supplier account: role must stay 'user' because 00360's
	// ck_account_users_supplier_is_user refuses any other role.
	seedAccountUser(t, ctx, pool, memberUserID, "a910302", "user", "/supplier", "supplier")
	if _, err := pool.Exec(ctx, `
		INSERT INTO sc_sources (source_id, name, created_at_ms, updated_at_ms)
		VALUES ('src_admin_patch_910301', '补丁测试厂', 1, 1)`); err != nil {
		t.Fatal(err)
	}
	var memberID string
	if err := pool.QueryRow(ctx, `
		INSERT INTO sc_source_members (source_id, user_id, created_by, created_at_ms)
		VALUES ('src_admin_patch_910301', $1, $2, 1)
		RETURNING member_id::text`, memberUserID, actorID).Scan(&memberID); err != nil {
		t.Fatal(err)
	}
	// A live session proves the reset also revokes it, and a false flag before
	// the call proves the assertion below observes the write rather than a
	// default.
	if _, err := pool.Exec(ctx, `INSERT INTO account_sessions (token_hash, user_id, expires_at)
		VALUES ('patch-test-token', $1, clock_timestamp() + interval '1 hour')`, memberUserID); err != nil {
		t.Fatal(err)
	}

	portal := Portal{Pool: pool, Begin: tenantx.BeginApp}
	actor := contract.Actor{UserID: actorID, Role: "super_admin"}
	password := "brand new passphrase"
	got, initial, err := portal.PatchAccount(ctx, actor, memberID, domain.AccountPatch{Password: &password}, "$2a$12$hash")
	if err != nil {
		t.Fatal(err)
	}
	if initial == nil || *initial != password {
		t.Fatalf("initial %v", initial)
	}
	if got.MemberID != memberID || got.Email != "a910302@example.invalid" {
		t.Fatalf("member %+v", got)
	}

	var mustChange, hashChanged bool
	if err := pool.QueryRow(ctx, `
		SELECT must_change_password, password_hash = '$2a$12$hash'
		  FROM account_users WHERE id = $1`, memberUserID).Scan(&mustChange, &hashChanged); err != nil {
		t.Fatal(err)
	}
	if !hashChanged {
		t.Fatal("password_hash was not replaced")
	}
	if !mustChange {
		t.Fatal("must_change_password was not raised by the supplier password reset")
	}
	var sessions int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM account_sessions WHERE user_id = $1`, memberUserID).Scan(&sessions); err != nil {
		t.Fatal(err)
	}
	if sessions != 0 {
		t.Fatalf("sessions left %d", sessions)
	}
	var action string
	if err := pool.QueryRow(ctx, `
		SELECT action FROM audit_logs
		 WHERE entity_id = $1 AND module = 'supplier_portal'
		 ORDER BY created_at_ms DESC LIMIT 1`, memberID).Scan(&action); err != nil {
		t.Fatal(err)
	}
	if action != "supplier_account_updated" {
		t.Fatalf("audit action %q", action)
	}
}

// TestDeleteAccountDisablesGrantsEverywhere pins doc §4.3's lifecycle rule and
// the decision recorded for task-7: deleting a member revokes every active
// source role the person still holds, on every source, because the account
// itself is going away. A grant left active would keep paying out to somebody
// whose membership no longer exists.
func TestDeleteAccountDisablesGrantsEverywhere(t *testing.T) {
	pool, ctx := supParityDB(t)
	const actorID, memberUserID = int64(910311), int64(910312)
	t.Cleanup(func() {
		c := context.Background()
		_, _ = pool.Exec(c, `DELETE FROM sc_source_fulfillers WHERE user_id = $1`, memberUserID)
		_, _ = pool.Exec(c, `DELETE FROM sc_source_members WHERE source_id = ANY($1)`,
			[]string{"src_admin_del_910311", "src_admin_del_910311_other"})
		_, _ = pool.Exec(c, `DELETE FROM sc_sources WHERE source_id = ANY($1)`,
			[]string{"src_admin_del_910311", "src_admin_del_910311_other"})
		_, _ = pool.Exec(c, `DELETE FROM account_users WHERE id = ANY($1)`, []int64{actorID, memberUserID})
	})
	supSeedLease(t, ctx, pool)
	seedAccountUser(t, ctx, pool, actorID, "a910311", "super_admin", "/workspace", "platform")
	seedAccountUser(t, ctx, pool, memberUserID, "a910312", "user", "/supplier", "supplier")
	if _, err := pool.Exec(ctx, `
		INSERT INTO sc_sources (source_id, name, created_at_ms, updated_at_ms)
		VALUES ('src_admin_del_910311', '删除测试厂', 1, 1),
		       ('src_admin_del_910311_other', '删除测试厂二', 1, 1)`); err != nil {
		t.Fatal(err)
	}
	var memberID string
	if err := pool.QueryRow(ctx, `
		INSERT INTO sc_source_members (source_id, user_id, created_by, created_at_ms)
		VALUES ('src_admin_del_910311', $1, $2, 1)
		RETURNING member_id::text`, memberUserID, actorID).Scan(&memberID); err != nil {
		t.Fatal(err)
	}
	// The doomed membership is on src_admin_del_910311; the grant is on the
	// other source, which is exactly the case a source-scoped cleanup would miss.
	if _, err := pool.Exec(ctx, `
		INSERT INTO sc_source_fulfillers (source_id, user_id, created_by, created_at_ms)
		VALUES ('src_admin_del_910311_other', $1, $2, 1)`, memberUserID, actorID); err != nil {
		t.Fatal(err)
	}

	portal := Portal{Pool: pool, Begin: tenantx.BeginApp}
	actor := contract.Actor{UserID: actorID, Role: "super_admin"}
	if err := portal.DeleteAccount(ctx, actor, memberID, 42); err != nil {
		t.Fatal(err)
	}
	var memberships int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM sc_source_members WHERE member_id = $1::uuid`, memberID).Scan(&memberships); err != nil {
		t.Fatal(err)
	}
	if memberships != 0 {
		t.Fatalf("membership left %d", memberships)
	}
	var status string
	var revokedBy *int64
	var revokedAt *int64
	if err := pool.QueryRow(ctx, `
		SELECT status, revoked_by, revoked_at_ms FROM sc_source_fulfillers WHERE user_id = $1`, memberUserID).
		Scan(&status, &revokedBy, &revokedAt); err != nil {
		t.Fatal(err)
	}
	if status != "disabled" || revokedBy == nil || *revokedBy != actorID || revokedAt == nil || *revokedAt != 42 {
		t.Fatalf("grant %q revokedBy %v revokedAt %v", status, revokedBy, revokedAt)
	}
}

func seedAccountUser(t *testing.T, ctx context.Context, pool *pgxpool.Pool, id int64, publicID, role, target, kind string) {
	t.Helper()
	_, err := pool.Exec(ctx, `
		INSERT INTO account_users (id, public_id, email, password_hash, role, name, target, supplier_id, plan, account_kind, created_at, updated_at)
		VALUES ($1, $2, $3, 'x', $4, '账号', $5, '', 'lite', $6, clock_timestamp(), clock_timestamp())`,
		id, publicID, publicID+"@example.invalid", role, target, kind)
	if err != nil {
		t.Fatal(err)
	}
}
