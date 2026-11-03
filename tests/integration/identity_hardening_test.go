package integration

import (
	"context"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/xxww0098/podhub-go/internal/platform/db/tenantx"
)

// This file pins the 00009 hardening of the permission, user and
// supplier-chain user tables. Each test names the attack it closes and is
// written so that relaxing the matching constraint, trigger, policy or grant
// makes it fail. Every "must fail" case is paired with a control that must
// succeed, so a table that rejects everything cannot pass.

func hxExec(t *testing.T, ctx context.Context, pool *pgxpool.Pool, sql string, args ...any) {
	t.Helper()
	if _, err := pool.Exec(ctx, sql, args...); err != nil {
		t.Fatalf("setup %q: %v", sql, err)
	}
}

// hxRefused fails unless err is non-nil and mentions every want substring.
// The substrings are constraint or trigger names, so a refusal for some other
// reason does not count.
func hxRefused(t *testing.T, what string, err error, want ...string) {
	t.Helper()
	if err == nil {
		t.Fatalf("%s: accepted, want it refused (%s)", what, strings.Join(want, ", "))
	}
	for _, w := range want {
		if !strings.Contains(err.Error(), w) {
			t.Fatalf("%s: refused for the wrong reason, want %q in %v", what, w, err)
		}
	}
}

func hxUser(ctx context.Context, pool *pgxpool.Pool, id int64, publicID, email, hash, role string) error {
	_, err := pool.Exec(ctx, `INSERT INTO account_users (id, public_id, email, password_hash, role, name, target, supplier_id, plan, account_kind, created_at, updated_at)
		VALUES ($1, $2, $3, $4, $5, 'N', '/workspace', '', 'free', 'platform', clock_timestamp(), clock_timestamp())`,
		id, publicID, email, hash, role)
	return err
}

func hxOrg(t *testing.T, ctx context.Context, pool *pgxpool.Pool, id, owner int64) {
	t.Helper()
	hxExec(t, ctx, pool, `INSERT INTO organizations (id, owner_user_id, name, plan, created_at, updated_at) VALUES ($1, $2, 'O', 'free', clock_timestamp(), clock_timestamp())`, id, owner)
}

// asSupplier runs fn inside a podhub_app transaction that carries the
// supplier GUC, the same entry the supplier API uses.
func asSupplier(ctx context.Context, pool *pgxpool.Pool, userID int64, fn func(tx pgx.Tx) error) error {
	return pgx.BeginFunc(ctx, pool, func(tx pgx.Tx) error {
		if err := tenantx.EnterSupplier(ctx, tx, userID); err != nil {
			return err
		}
		return fn(tx)
	})
}

// TestSupplierCannotWriteOwnMembership: a supplier session could INSERT a
// membership for itself on any source and flip its own disabled membership
// back to active, because the self-isolation policy covered every command.
// Membership is granted by staff only; the supplier may read its own row.
func TestSupplierCannotWriteOwnMembership(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()
	pool := migratedPool(t, ctx)

	const staff, sup = 971001, 971002
	seedAccount(t, ctx, pool, staff, "hx-staff@test.example", "admin", "platform")
	seedAccount(t, ctx, pool, sup, "hx-sup@test.example", "user", "supplier")
	hxExec(t, ctx, pool, `INSERT INTO sc_factories (factory_id, name, created_at_ms, updated_at_ms) VALUES ('hx_s1','hx_s1',1,1),('hx_s2','hx_s2',1,1)`)
	hxExec(t, ctx, pool, `INSERT INTO sc_sources (source_id, name, factory_id, created_at_ms, updated_at_ms) VALUES ('hx_s1','hx_s1','hx_s1',1,1),('hx_s2','hx_s2','hx_s2',1,1)`)
	hxExec(t, ctx, pool, `INSERT INTO sc_factory_members (factory_id, user_id, status, created_by, created_at_ms) VALUES ('hx_s1', $1, 'disabled', $2, 1)`, sup, staff)

	err := asSupplier(ctx, pool, sup, func(tx pgx.Tx) error {
		_, e := tx.Exec(ctx, `INSERT INTO sc_factory_members (factory_id, user_id, created_by, created_at_ms) VALUES ('hx_s2', $1, $1, 2)`, sup)
		return e
	})
	hxRefused(t, "supplier self-grant on another source", err, "row-level security")

	var affected int64
	if err := asSupplier(ctx, pool, sup, func(tx pgx.Tx) error {
		tag, e := tx.Exec(ctx, `UPDATE sc_factory_members SET status = 'active' WHERE user_id = $1`, sup)
		affected = tag.RowsAffected()
		return e
	}); err != nil {
		t.Fatalf("self re-enable: %v", err)
	}
	if affected != 0 {
		t.Fatalf("a supplier re-enabled its own disabled membership (%d row)", affected)
	}
	var status string
	if err := pool.QueryRow(ctx, `SELECT status FROM sc_factory_members WHERE user_id = $1`, sup).Scan(&status); err != nil || status != "disabled" {
		t.Fatalf("membership status %q err %v, want disabled", status, err)
	}

	var deleted int64
	if err := asSupplier(ctx, pool, sup, func(tx pgx.Tx) error {
		tag, e := tx.Exec(ctx, `DELETE FROM sc_factory_members WHERE user_id = $1`, sup)
		deleted = tag.RowsAffected()
		return e
	}); err != nil {
		t.Fatalf("self delete: %v", err)
	}
	if deleted != 0 {
		t.Fatalf("a supplier deleted its own membership")
	}

	// Control: the supplier still reads its own row.
	var seen int
	if err := asSupplier(ctx, pool, sup, func(tx pgx.Tx) error {
		return tx.QueryRow(ctx, `SELECT count(*) FROM sc_factory_members`).Scan(&seen)
	}); err != nil || seen != 1 {
		t.Fatalf("supplier reads %d own membership rows, err %v, want 1", seen, err)
	}
}

// TestGrantTablesBindAccountKind: the platform/supplier split lived only in
// Go (grantableAccount). SQL accepted a platform admin as a source member and
// a supplier as a catalog manager, and let account_kind flip after the grant.
func TestGrantTablesBindAccountKind(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()
	pool := migratedPool(t, ctx)

	const admin, mgr, supA, supB = 971011, 971012, 971013, 971014
	seedAccount(t, ctx, pool, admin, "hx-admin@test.example", "admin", "platform")
	seedAccount(t, ctx, pool, mgr, "hx-mgr@test.example", "user", "platform")
	seedAccount(t, ctx, pool, supA, "hx-supa@test.example", "user", "supplier")
	seedAccount(t, ctx, pool, supB, "hx-supb@test.example", "user", "supplier")
	hxExec(t, ctx, pool, `INSERT INTO sc_factories (factory_id, name, created_at_ms, updated_at_ms) VALUES ('hx_k1','hx_k1',1,1),('hx_k2','hx_k2',1,1)`)
	hxExec(t, ctx, pool, `INSERT INTO sc_sources (source_id, name, factory_id, created_at_ms, updated_at_ms) VALUES ('hx_k1','hx_k1','hx_k1',1,1),('hx_k2','hx_k2','hx_k2',1,1)`)

	_, err := pool.Exec(ctx, `INSERT INTO sc_factory_members (factory_id, user_id, created_by, created_at_ms) VALUES ('hx_k1', $1, $2, 1)`, admin, admin)
	hxRefused(t, "platform admin as source member", err, "sc_factory_members_account_kind")
	_, err = pool.Exec(ctx, `INSERT INTO sc_source_fulfillers (source_id, user_id, created_by, created_at_ms) VALUES ('hx_k1', $1, $2, 1)`, mgr, admin)
	hxRefused(t, "platform account as fulfiller", err, "sc_source_fulfillers_account_kind")
	_, err = pool.Exec(ctx, `INSERT INTO sc_catalog_managers (source_id, user_id, created_by, created_at_ms) VALUES ('hx_k1', $1, $2, 1)`, supA, admin)
	hxRefused(t, "supplier as catalog manager", err, "sc_catalog_managers_account_kind")
	_, err = pool.Exec(ctx, `INSERT INTO sc_factory_members (factory_id, user_id, created_by, created_at_ms) VALUES ('hx_k1', $1, $2, 1)`, 999999999, admin)
	hxRefused(t, "membership for a missing account", err, "sc_factory_members_account_kind")

	// Controls: the right kind goes through.
	hxExec(t, ctx, pool, `INSERT INTO sc_factory_members (factory_id, user_id, created_by, created_at_ms) VALUES ('hx_k1', $1, $2, 1)`, supA, admin)
	hxExec(t, ctx, pool, `INSERT INTO sc_source_fulfillers (source_id, user_id, created_by, created_at_ms) VALUES ('hx_k1', $1, $2, 1)`, supA, admin)
	hxExec(t, ctx, pool, `INSERT INTO sc_catalog_managers (source_id, user_id, created_by, created_at_ms) VALUES ('hx_k1', $1, $2, 1)`, mgr, admin)

	// A grant cannot be re-pointed at another account or source.
	for _, c := range []struct{ name, sql string }{
		{"member user", `UPDATE sc_factory_members SET user_id = ` + fmt.Sprint(supB) + ` WHERE user_id = ` + fmt.Sprint(supA)},
		{"member source", `UPDATE sc_factory_members SET factory_id = 'hx_k2' WHERE user_id = ` + fmt.Sprint(supA)},
		{"fulfiller user", `UPDATE sc_source_fulfillers SET user_id = ` + fmt.Sprint(supB) + ` WHERE user_id = ` + fmt.Sprint(supA)},
		{"manager user", `UPDATE sc_catalog_managers SET user_id = ` + fmt.Sprint(admin) + ` WHERE user_id = ` + fmt.Sprint(mgr)},
		{"manager source", `UPDATE sc_catalog_managers SET source_id = 'hx_k2' WHERE user_id = ` + fmt.Sprint(mgr)},
	} {
		_, err := pool.Exec(ctx, c.sql)
		want := "grant_identity_immutable"
		if strings.HasPrefix(c.name, "member ") {
			want = "factory_member_identity_immutable"
		}
		hxRefused(t, "re-point "+c.name, err, want)
	}
	// Status changes (revoke and revive) stay legal.
	hxExec(t, ctx, pool, `UPDATE sc_catalog_managers SET status = 'disabled', revoked_by = $2, revoked_at_ms = 5 WHERE user_id = $1`, mgr, admin)

	// The kind that justified the grant cannot change afterwards.
	_, err = pool.Exec(ctx, `UPDATE account_users SET account_kind = 'platform' WHERE id = $1`, supA)
	hxRefused(t, "supplier turned platform after grant", err, "account_users_kind_immutable")
	_, err = pool.Exec(ctx, `UPDATE account_users SET account_kind = 'supplier' WHERE id = $1`, mgr)
	hxRefused(t, "platform turned supplier", err, "account_users_kind_immutable")
}

// TestFulfillerCannotWriteDispatch: the fulfiller policy covered every
// command, so a fulfiller session could set its own packet to shipped or
// rewrite the payload without going through delegate_supplier_ship.
func TestFulfillerCannotWriteDispatch(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()
	pool := migratedPool(t, ctx)

	const org, fulfillerUser = 971020, 971021
	const orderID = "00000000-0000-0000-0000-0000000f7001"
	const dispatchID = "00000000-0000-0000-0000-0000000f7002"
	seedAccount(t, ctx, pool, fulfillerUser, "hx-ful@test.example", "user", "supplier")
	hxOrg(t, ctx, pool, org, fulfillerUser)
	hxExec(t, ctx, pool, `INSERT INTO sc_sources (source_id, name, created_at_ms, updated_at_ms) VALUES ('hx_d1','hx_d1',1,1)`)
	var fulfillerID string
	if err := pool.QueryRow(ctx, `INSERT INTO sc_source_fulfillers (source_id, user_id, created_by, created_at_ms) VALUES ('hx_d1', $1, $1, 1) RETURNING fulfiller_id::text`, fulfillerUser).Scan(&fulfillerID); err != nil {
		t.Fatal(err)
	}
	hxExec(t, ctx, pool, `INSERT INTO delegate_orders (order_id, org_id, store_id, posting_number, state, created_at_ms, updated_at_ms) VALUES ($1::uuid, $2, '00000000-0000-0000-0000-0000000f7003'::uuid, 'P-H', 'dispatched', 1, 1)`, orderID, org)
	hxExec(t, ctx, pool, `INSERT INTO delegate_dispatches (dispatch_id, org_id, order_id, source_id, fulfiller_id, dispatch_no, payload, state, created_at_ms, updated_at_ms) VALUES ($1::uuid, $2, $3::uuid, 'hx_d1', $4::uuid, 'D-H', '{"lines":[]}'::jsonb, 'dispatched', 1, 1)`, dispatchID, org, orderID, fulfillerID)

	for _, c := range []struct{ name, sql string }{
		{"state", `UPDATE delegate_dispatches SET state = 'shipped'`},
		{"payload", `UPDATE delegate_dispatches SET payload = '{"lines":[{"x":1}]}'::jsonb`},
		{"delete", `DELETE FROM delegate_dispatches`},
	} {
		var affected int64
		if err := asSupplier(ctx, pool, fulfillerUser, func(tx pgx.Tx) error {
			tag, e := tx.Exec(ctx, c.sql)
			affected = tag.RowsAffected()
			return e
		}); err != nil {
			t.Fatalf("%s: %v", c.name, err)
		}
		if affected != 0 {
			t.Fatalf("a fulfiller session changed its own dispatch directly (%s, %d row)", c.name, affected)
		}
	}
	var state, payload string
	if err := pool.QueryRow(ctx, `SELECT state, payload::text FROM delegate_dispatches WHERE dispatch_id = $1::uuid`, dispatchID).Scan(&state, &payload); err != nil {
		t.Fatal(err)
	}
	if state != "dispatched" || strings.Contains(payload, "x") {
		t.Fatalf("dispatch changed: state %q payload %s", state, payload)
	}

	// Controls: the pinned fulfiller still reads the packet and still moves
	// it through the definer function.
	var seen int
	if err := asSupplier(ctx, pool, fulfillerUser, func(tx pgx.Tx) error {
		return tx.QueryRow(ctx, `SELECT count(*) FROM delegate_dispatches`).Scan(&seen)
	}); err != nil || seen != 1 {
		t.Fatalf("fulfiller reads %d packets, err %v, want 1", seen, err)
	}
	if err := asSupplier(ctx, pool, fulfillerUser, func(tx pgx.Tx) error {
		_, e := tx.Exec(ctx, `SELECT public.delegate_supplier_accept($1::uuid, $2, $3::uuid)`, dispatchID, fulfillerUser, fulfillerID)
		return e
	}); err != nil {
		t.Fatalf("accept through the function: %v", err)
	}
	if err := pool.QueryRow(ctx, `SELECT state FROM delegate_dispatches WHERE dispatch_id = $1::uuid`, dispatchID).Scan(&state); err != nil || state != "accepted" {
		t.Fatalf("state %q err %v, want accepted", state, err)
	}
}

// TestAccountUsersRejectConfusableIdentity: role compared case-insensitively
// in Go (gates.go EqualFold) but exactly in SQL, so 'Super_Admin' passed the
// admin gate while escaping the single-super-admin index. public_id and uuid
// are the lookup keys for admin routes and had no unique constraint.
func TestAccountUsersRejectConfusableIdentity(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()
	pool := migratedPool(t, ctx)

	hxExec(t, ctx, pool, `INSERT INTO account_users (id, public_id, email, password_hash, role, name, uuid, created_at, updated_at)
		VALUES (971031, 'hx-pub-1', 'hx-one@test.example', 'h', 'user', 'N', '00000000-0000-0000-0000-00000000a031', now(), now())`)

	for i, role := range []string{"Super_Admin", " admin", "ADMIN", "root", ""} {
		err := hxUser(ctx, pool, int64(971040+i), fmt.Sprintf("hx-r%d", i), fmt.Sprintf("hx-r%d@test.example", i), "h", role)
		hxRefused(t, fmt.Sprintf("role %q", role), err, "ck_account_users_role")
	}
	err := hxUser(ctx, pool, 971050, "hx-pub-1", "hx-dup-pub@test.example", "h", "user")
	hxRefused(t, "duplicate public_id", err, "account_users_public_id_key")
	_, err = pool.Exec(ctx, `INSERT INTO account_users (id, public_id, email, password_hash, role, name, uuid, created_at, updated_at)
		VALUES (971051, 'hx-pub-2', 'hx-dup-uuid@test.example', 'h', 'user', 'N', '00000000-0000-0000-0000-00000000a031', now(), now())`)
	hxRefused(t, "duplicate uuid", err, "account_users_uuid_key")
	for i, email := range []string{" pad@test.example ", "no-at-sign", "a@b", "a@@b.example", "a b@test.example", "a@.example", "a@test..example"} {
		err := hxUser(ctx, pool, int64(971060+i), fmt.Sprintf("hx-e%d", i), email, "h", "user")
		hxRefused(t, fmt.Sprintf("email %q", email), err, "ck_account_users_email_shape")
	}
	err = hxUser(ctx, pool, 971070, "hx-pub-3", "hx-empty-hash@test.example", "  ", "user")
	hxRefused(t, "blank password hash", err, "ck_account_users_password_hash")

	// Controls: ordinary mixed-case mail and each real role are accepted.
	for i, role := range []string{"user", "admin"} {
		if err := hxUser(ctx, pool, int64(971080+i), fmt.Sprintf("hx-ok%d", i), fmt.Sprintf("Mixed.Case+%d@Test.Example", i), "h", role); err != nil {
			t.Fatalf("valid %s account refused: %v", role, err)
		}
	}
	if err := hxUser(ctx, pool, 971090, "hx-super", "hx-super@test.example", "h", "super_admin"); err != nil {
		t.Fatalf("valid super_admin refused: %v", err)
	}
}

// TestAttributionRateFrozenOnceBound: only invited_by_agent_user_id was
// write-once, so the commission rate and source could be rewritten after the
// bind.
func TestAttributionRateFrozenOnceBound(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()
	pool := migratedPool(t, ctx)

	const agent, user = 971101, 971102
	seedAccount(t, ctx, pool, agent, "hx-agent@test.example", "user", "platform")
	seedAccount(t, ctx, pool, user, "hx-invitee@test.example", "user", "platform")

	// Control: the first bind writes all four columns together.
	hxExec(t, ctx, pool, `UPDATE account_users SET invited_by_agent_user_id = $2, agent_attributed_at = clock_timestamp(),
		agent_attribution_bps = 1000, agent_attribution_source = 'claim' WHERE id = $1`, user, agent)

	for _, c := range []struct{ name, set string }{
		{"rate", `agent_attribution_bps = 10000`},
		{"source", `agent_attribution_source = 'register'`},
		{"time", `agent_attributed_at = clock_timestamp() + interval '1 day'`},
		{"rate cleared", `agent_attribution_bps = NULL`},
		{"inviter cleared", `invited_by_agent_user_id = NULL`},
	} {
		_, err := pool.Exec(ctx, `UPDATE account_users SET `+c.set+` WHERE id = $1`, user)
		hxRefused(t, "rewrite attribution "+c.name, err, "write-once")
	}
	var bps int
	if err := pool.QueryRow(ctx, `SELECT agent_attribution_bps FROM account_users WHERE id = $1`, user).Scan(&bps); err != nil || bps != 1000 {
		t.Fatalf("bps %d err %v, want 1000", bps, err)
	}
	// An unbound account is unaffected.
	hxExec(t, ctx, pool, `UPDATE account_users SET agent_attribution_bps = 500 WHERE id = $1`, agent)
}

// TestSessionsAreBoundAndHashed: a session row for a user id that did not yet
// exist would resolve to whoever later received that id; raw bearer tokens
// could be stored where only SHA-256 digests belong.
func TestSessionsAreBoundAndHashed(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()
	pool := migratedPool(t, ctx)

	const user = 971201
	seedAccount(t, ctx, pool, user, "hx-sess@test.example", "user", "platform")
	good := strings.Repeat("ab", 32)

	_, err := pool.Exec(ctx, `INSERT INTO account_sessions (token_hash, user_id, expires_at) VALUES ($1, 999999999, now() + interval '1 day')`, good)
	hxRefused(t, "session for a missing user", err, "account_sessions_user_id_fkey")
	_, err = pool.Exec(ctx, `INSERT INTO account_sessions (token_hash, user_id, expires_at) VALUES ('raw-bearer-token', $1, now() + interval '1 day')`, user)
	hxRefused(t, "raw session token", err, "ck_account_sessions_token_hash")
	_, err = pool.Exec(ctx, `INSERT INTO account_sessions (token_hash, user_id, expires_at) VALUES ($1, $2, now() + interval '1 day')`, strings.ToUpper(good), user)
	hxRefused(t, "upper-case digest", err, "ck_account_sessions_token_hash")
	_, err = pool.Exec(ctx, `INSERT INTO auth_email_tokens (token_hash, user_id, purpose, expires_at, created_at) VALUES ('raw-reset-token', $1, 'reset', now() + interval '1 hour', now())`, user)
	hxRefused(t, "raw reset token", err, "ck_auth_email_tokens_token_hash")

	// Controls.
	hxExec(t, ctx, pool, `INSERT INTO account_sessions (token_hash, user_id, expires_at) VALUES ($1, $2, now() + interval '1 day')`, good, user)
	hxExec(t, ctx, pool, `INSERT INTO auth_email_tokens (token_hash, user_id, purpose, expires_at, created_at) VALUES ($1, $2, 'reset', now() + interval '1 hour', now())`, strings.Repeat("cd", 32), user)

	// Deleting the account takes its sessions with it.
	hxExec(t, ctx, pool, `DELETE FROM account_users WHERE id = $1`, user)
	var left int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM account_sessions WHERE user_id = $1`, user).Scan(&left); err != nil || left != 0 {
		t.Fatalf("%d sessions survive account deletion, err %v", left, err)
	}
}

// TestCredentialsHaveOneWriter: account_credentials.password_hash was a copy
// the app role could rewrite independently of account_users, and login reads
// the copy while change-password reads the original. Only the sync trigger
// may write it.
func TestCredentialsHaveOneWriter(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()
	pool := migratedPool(t, ctx)

	const user = 971301
	seedAccount(t, ctx, pool, user, "hx-cred@test.example", "user", "platform")

	for _, sql := range []string{
		`UPDATE account_credentials SET password_hash = 'planted' WHERE user_id = ` + fmt.Sprint(user),
		`INSERT INTO account_credentials (user_id, password_hash, updated_at) VALUES (1, 'x', now()) ON CONFLICT (user_id) DO NOTHING`,
		`DELETE FROM account_credentials WHERE user_id = ` + fmt.Sprint(user),
	} {
		err := pgx.BeginFunc(ctx, pool, func(tx pgx.Tx) error {
			if e := tenantx.EnterAppRole(ctx, tx); e != nil {
				return e
			}
			_, e := tx.Exec(ctx, sql)
			return e
		})
		hxRefused(t, "app write to account_credentials", err, "permission denied")
	}

	// Control: the legitimate path, writing account_users as the app role,
	// still lands in account_credentials through the trigger.
	if err := pgx.BeginFunc(ctx, pool, func(tx pgx.Tx) error {
		if e := tenantx.EnterAppRole(ctx, tx); e != nil {
			return e
		}
		if _, e := tx.Exec(ctx, `UPDATE account_users SET password_hash = 'rotated', updated_at = clock_timestamp() WHERE id = $1`, user); e != nil {
			return e
		}
		_, e := tx.Exec(ctx, `INSERT INTO account_users (id, public_id, email, password_hash, role, name, created_at, updated_at)
			VALUES (971302, 'hx-cred-2', 'hx-cred2@test.example', 'fresh', 'user', 'N', now(), now())`)
		return e
	}); err != nil {
		t.Fatalf("app role could not write account_users: %v", err)
	}
	for id, want := range map[int64]string{user: "rotated", 971302: "fresh"} {
		var got string
		if err := pool.QueryRow(ctx, `SELECT password_hash FROM account_credentials WHERE user_id = $1`, id).Scan(&got); err != nil || got != want {
			t.Fatalf("credentials for %d = %q err %v, want %q", id, got, err, want)
		}
	}
	_, err := pool.Exec(ctx, `UPDATE account_credentials SET password_hash = '' WHERE user_id = $1`, user)
	hxRefused(t, "blank credential hash", err, "ck_account_credentials_password_hash")
}

// TestSupportGrantsAreEvidence: a support grant could target a supplier or a
// plain user, last 30 days, be extended in place, un-revoked, rewritten and
// deleted by the app role.
func TestSupportGrantsAreEvidence(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()
	pool := migratedPool(t, ctx)

	const super, staff, plain, sup = 971401, 971402, 971403, 971404
	seedAccount(t, ctx, pool, super, "hx-super2@test.example", "super_admin", "platform")
	seedAccount(t, ctx, pool, staff, "hx-staff2@test.example", "admin", "platform")
	seedAccount(t, ctx, pool, plain, "hx-plain@test.example", "user", "platform")
	seedAccount(t, ctx, pool, sup, "hx-sup2@test.example", "user", "supplier")
	hxOrg(t, ctx, pool, 971410, plain)
	hxOrg(t, ctx, pool, 971411, plain)

	insert := func(org, target, by int64, ttl string) error {
		_, err := pool.Exec(ctx, `INSERT INTO support_grants (org_id, staff_user_id, reason, expires_at, created_by_user_id, created_at, updated_at)
			VALUES ($1, $2, 'case 42', clock_timestamp() + $4::interval, $3, clock_timestamp(), clock_timestamp())`, org, target, by, ttl)
		return err
	}
	hxRefused(t, "grant to a supplier", insert(971410, sup, super, "1 hour"), "support_grants_staff_only")
	hxRefused(t, "grant to a plain user", insert(971410, plain, super, "1 hour"), "support_grants_staff_only")
	hxRefused(t, "grant issued by non super admin", insert(971410, staff, staff, "1 hour"), "support_grants_issuer_super_admin")
	hxRefused(t, "30 day grant", insert(971411, staff, super, "30 days"), "ck_support_grants_ttl")
	hxRefused(t, "grant for a missing org", insert(999999999, staff, super, "1 hour"), "support_grants_org_id_fkey")

	// Control and mutation attempts.
	if err := insert(971410, staff, super, "1 hour"); err != nil {
		t.Fatalf("valid grant refused: %v", err)
	}
	for _, c := range []struct{ name, set string }{
		{"extend", `expires_at = expires_at + interval '1 hour'`},
		{"reason", `reason = 'rewritten'`},
		{"org", `org_id = 971411`},
		{"target", `staff_user_id = ` + fmt.Sprint(plain)},
		{"issuer", `created_by_user_id = ` + fmt.Sprint(staff)},
	} {
		_, err := pool.Exec(ctx, `UPDATE support_grants SET `+c.set+` WHERE staff_user_id = $1`, staff)
		hxRefused(t, "mutate grant "+c.name, err, "support_grants_immutable")
	}
	hxExec(t, ctx, pool, `UPDATE support_grants SET expires_at = expires_at - interval '30 minutes', updated_at = clock_timestamp() WHERE staff_user_id = $1`, staff)
	hxExec(t, ctx, pool, `UPDATE support_grants SET revoked_at = clock_timestamp(), updated_at = clock_timestamp() WHERE staff_user_id = $1`, staff)
	_, err := pool.Exec(ctx, `UPDATE support_grants SET revoked_at = NULL WHERE staff_user_id = $1`, staff)
	hxRefused(t, "un-revoke", err, "support_grants_immutable")

	var canDelete, canRead bool
	if err := pool.QueryRow(ctx, `SELECT has_table_privilege('podhub_app', 'public.support_grants', 'DELETE'), has_table_privilege('podhub_app', 'public.support_grants', 'SELECT')`).Scan(&canDelete, &canRead); err != nil {
		t.Fatal(err)
	}
	if canDelete || !canRead {
		t.Fatalf("podhub_app on support_grants: delete=%v select=%v, want false/true", canDelete, canRead)
	}
}

// TestMembershipAndOwnershipIntegrity: membership, invitation and owner rows
// had no foreign keys, so ghost rows could be planted for ids that a later
// signup would receive; a membership could be moved between orgs.
func TestMembershipAndOwnershipIntegrity(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()
	pool := migratedPool(t, ctx)

	const owner, member = 971501, 971502
	seedAccount(t, ctx, pool, owner, "hx-owner@test.example", "user", "platform")
	seedAccount(t, ctx, pool, member, "hx-member@test.example", "user", "platform")
	hxOrg(t, ctx, pool, 971510, owner)
	hxOrg(t, ctx, pool, 971511, owner)

	addMember := func(org, user int64) error {
		_, err := pool.Exec(ctx, `INSERT INTO organization_members (org_id, user_id, role, display_name, join_order, created_at, updated_at)
			VALUES ($1, $2, 'member', 'M', 1, now(), now())`, org, user)
		return err
	}
	hxRefused(t, "member of a missing org", addMember(999999999, member), "organization_members_org_id_fkey")
	hxRefused(t, "membership for a missing user", addMember(971510, 999999999), "organization_members_user_id_fkey")
	_, err := pool.Exec(ctx, `INSERT INTO organizations (owner_user_id, name, plan, created_at, updated_at) VALUES (999999999, 'ghost', 'free', now(), now())`)
	hxRefused(t, "org owned by a missing user", err, "organizations_owner_user_id_fkey")

	if err := addMember(971510, member); err != nil {
		t.Fatalf("valid membership refused: %v", err)
	}
	for _, set := range []string{`org_id = 971511`, `user_id = ` + fmt.Sprint(owner)} {
		_, err := pool.Exec(ctx, `UPDATE organization_members SET `+set+` WHERE user_id = $1`, member)
		hxRefused(t, "move membership "+set, err, "organization_members_identity_immutable")
	}
	hxExec(t, ctx, pool, `UPDATE organization_members SET manual_disabled = true, updated_at = now() WHERE user_id = $1`, member)

	invite := func(role string, accepted, revoked bool) error {
		_, err := pool.Exec(ctx, `INSERT INTO org_invitations (org_id, email, role, invited_by_user_id, invited_by_email, expires_at, accepted_at, revoked_at, created_at, updated_at)
			VALUES (971510, $1, $2, $3, 'hx-owner@test.example', now() + interval '1 day',
			        CASE WHEN $4 THEN now() END, CASE WHEN $5 THEN now() END, now(), now())`,
			fmt.Sprintf("inv-%s-%v-%v@test.example", role, accepted, revoked), role, owner, accepted, revoked)
		return err
	}
	hxRefused(t, "owner invitation", invite("owner", false, false), "ck_org_invitations_role")
	hxRefused(t, "invitation both accepted and revoked", invite("member", true, true), "ck_org_invitations_one_terminal_state")
	if err := invite("member", false, false); err != nil {
		t.Fatalf("valid invitation refused: %v", err)
	}
	_, err = pool.Exec(ctx, `INSERT INTO org_invitations (org_id, email, role, invited_by_user_id, invited_by_email, expires_at, created_at, updated_at)
		VALUES (971510, 'inv-ghost@test.example', 'member', 999999999, 'x@test.example', now() + interval '1 day', now(), now())`)
	hxRefused(t, "invitation by a missing user", err, "org_invitations_invited_by_user_id_fkey")

	// The app role cannot erase accounts or organizations.
	for _, table := range []string{"account_users", "organizations", "support_grants"} {
		var can bool
		if err := pool.QueryRow(ctx, `SELECT has_table_privilege('podhub_app', 'public.'||$1, 'DELETE') OR has_table_privilege('podhub_worker', 'public.'||$1, 'DELETE')`, table).Scan(&can); err != nil {
			t.Fatal(err)
		}
		if can {
			t.Fatalf("podhub_app or podhub_worker can DELETE FROM %s", table)
		}
	}
}
