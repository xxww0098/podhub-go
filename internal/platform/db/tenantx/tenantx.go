// Package tenant is the SaaS isolation seam.
//
// Rust sets transaction-local role podhub_app and app.current_org_id before
// a tenant statement (src/listing/kernel/tenant.rs). RLS policy tenant_isolation
// compares org_id to that GUC (migration/src/rls.rs). Worker claim uses
// podhub_worker, which is BYPASSRLS, and then opens a tenant transaction for
// the claimed org. BeginApp and BeginWorker are those two calls. The Enter
// functions below set the other transaction-local values with the same
// set_config shape. This package does not invent a second tenant key.
package tenantx

import (
	"context"
	"errors"
	"strconv"
	"strings"

	"github.com/jackc/pgx/v5"
)

// ErrOrgUnset is returned when the tenant GUC is missing on the transaction.
var ErrOrgUnset = errors.New("tenant org is unset")

// ErrUserUnset is returned when a session that names a user was given no id.
var ErrUserUnset = errors.New("tenant user is unset")

// ErrGrantUnset is returned when an automation-grant session has no grant id.
var ErrGrantUnset = errors.New("automation grant is unset")

const (
	// RoleApp is the request role. RLS applies to it.
	RoleApp = "podhub_app"
	// RoleWorker is the claim role. Rust grants it BYPASSRLS.
	RoleWorker = "podhub_worker"
	// RoleCatalog is the global Ozon error-catalog writer role.
	RoleCatalog = "podhub_ozon_catalog"
	// GUCCurrentOrgID is the transaction-local tenant setting.
	GUCCurrentOrgID = "app.current_org_id"
	// GUCStaffAccess is set to staffAccessOn for a staff session.
	GUCStaffAccess = "app.staff_access"
	// GUCPlatformObserverID is the super-admin observer user id.
	GUCPlatformObserverID = "app.platform_observer_id"
	// GUCCurrentWalletUserID is the wallet owner user id.
	GUCCurrentWalletUserID = "app.current_wallet_user_id"
	// GUCCurrentSupplierUserID is the supplier user id.
	GUCCurrentSupplierUserID = "app.current_supplier_user_id"
	// GUCAutomationGrantID is the automation grant uuid.
	GUCAutomationGrantID = "app.automation_grant_id"
	// staffAccessOn is the only value policies compare for a staff session.
	staffAccessOn = "1"
)

// EnterApp sets the app role and the org id for this transaction only.
func EnterApp(ctx context.Context, tx pgx.Tx, orgID int64) error {
	_, err := tx.Exec(ctx,
		"SELECT set_config('role', $1, true), set_config($2, $3, true)",
		RoleApp, GUCCurrentOrgID, strconv.FormatInt(orgID, 10),
	)
	return err
}

// EnterWorker sets the worker role for a cross-tenant claim. The caller
// must open EnterApp before writing one org's rows.
func EnterWorker(ctx context.Context, tx pgx.Tx) error {
	_, err := tx.Exec(ctx, "SELECT set_config('role', $1, true)", RoleWorker)
	return err
}

// EnterAppRole sets the app role and leaves app.current_org_id unset. It is
// for platform tables that carry no org_id and have no tenant RLS
// (banned_tags, platform_catalog_fetch_config). A tenant read must use
// EnterApp instead: without the org GUC, tenant_isolation matches no row.
func EnterAppRole(ctx context.Context, tx pgx.Tx) error {
	_, err := tx.Exec(ctx, "SELECT set_config('role', $1, true)", RoleApp)
	return err
}

// BeginApp starts a transaction and enters the app role for one org.
// Commit and rollback both clear the local settings.
func BeginApp(ctx context.Context, begin func(context.Context) (pgx.Tx, error), orgID int64) (pgx.Tx, error) {
	tx, err := begin(ctx)
	if err != nil {
		return nil, err
	}
	if err := EnterApp(ctx, tx, orgID); err != nil {
		_ = tx.Rollback(ctx)
		return nil, err
	}
	return tx, nil
}

// RequireOrg fails when this transaction has no tenant GUC.
// Tables without RLS still have to go through BeginApp; a bare session must not pass.
func RequireOrg(ctx context.Context, tx pgx.Tx) error {
	var got string
	if err := tx.QueryRow(ctx, `SELECT current_setting($1, true)`, GUCCurrentOrgID).Scan(&got); err != nil {
		return ErrOrgUnset
	}
	if strings.TrimSpace(got) == "" {
		return ErrOrgUnset
	}
	return nil
}

// BeginWorker starts a transaction and enters the worker role.
func BeginWorker(ctx context.Context, begin func(context.Context) (pgx.Tx, error)) (pgx.Tx, error) {
	tx, err := begin(ctx)
	if err != nil {
		return nil, err
	}
	if err := EnterWorker(ctx, tx); err != nil {
		_ = tx.Rollback(ctx)
		return nil, err
	}
	return tx, nil
}

// EnterStaff sets the app role and app.staff_access to 1. It leaves
// app.current_org_id unset. admin BeginStaff does these two assignments
// in the same order.
func EnterStaff(ctx context.Context, tx pgx.Tx) error {
	if _, err := tx.Exec(ctx, "SELECT set_config('role', $1, true)", RoleApp); err != nil {
		return err
	}
	_, err := tx.Exec(ctx, "SELECT set_config($1, $2, true)", GUCStaffAccess, staffAccessOn)
	return err
}

// EnterObserver sets the app role and app.platform_observer_id. The id is
// the decimal user id. app.current_org_id is left unset, matching the
// digest and catalog list opens. A separate observe read also writes an
// empty org string; NULLIF treats that and an unset value the same.
func EnterObserver(ctx context.Context, tx pgx.Tx, userID int64) error {
	_, err := tx.Exec(ctx,
		"SELECT set_config('role', $1, true), set_config($2, $3, true)",
		RoleApp, GUCPlatformObserverID, strconv.FormatInt(userID, 10),
	)
	return err
}

// EnterWalletUser sets the app role, the org id, and the wallet user id.
// The org and role statement is EnterApp. The wallet id is the decimal user id.
func EnterWalletUser(ctx context.Context, tx pgx.Tx, orgID, userID int64) error {
	if err := EnterApp(ctx, tx, orgID); err != nil {
		return err
	}
	_, err := tx.Exec(ctx, "SELECT set_config($1, $2, true)", GUCCurrentWalletUserID, strconv.FormatInt(userID, 10))
	return err
}

// EnterSupplierUser sets the app role, the org id, and the supplier user id.
// Order matches supplier withTx: EnterApp, then the supplier GUC.
func EnterSupplierUser(ctx context.Context, tx pgx.Tx, orgID, userID int64) error {
	if err := EnterApp(ctx, tx, orgID); err != nil {
		return err
	}
	_, err := tx.Exec(ctx, "SELECT set_config($1, $2, true)", GUCCurrentSupplierUserID, strconv.FormatInt(userID, 10))
	return err
}

// EnterSupplier sets the app role and the supplier user id. The org GUC is
// left unset. Policies compare org_id to the org GUC by equality only, so
// unset and "0" match the same rows as long as no row has org_id 0.
func EnterSupplier(ctx context.Context, tx pgx.Tx, userID int64) error {
	_, err := tx.Exec(ctx,
		"SELECT set_config('role', $1, true), set_config($2, $3, true)",
		RoleApp, GUCCurrentSupplierUserID, strconv.FormatInt(userID, 10),
	)
	return err
}

// EnterAutomationGrant sets the app role and app.automation_grant_id.
// grantID is stored as given. The org GUC is left unset.
func EnterAutomationGrant(ctx context.Context, tx pgx.Tx, grantID string) error {
	_, err := tx.Exec(ctx,
		"SELECT set_config('role', $1, true), set_config($2, $3, true)",
		RoleApp, GUCAutomationGrantID, grantID,
	)
	return err
}

// EnterCatalog sets the catalog writer role and no app GUC.
func EnterCatalog(ctx context.Context, tx pgx.Tx) error {
	_, err := tx.Exec(ctx, "SELECT set_config('role', $1, true)", RoleCatalog)
	return err
}
