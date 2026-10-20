package db

import (
	"context"
	"errors"
	"strings"

	"github.com/jackc/pgx/v5"

	"github.com/xxww0098/podhub-go/internal/platform/db/tenantx"
)

// Beginner opens a transaction. *pgxpool.Pool implements it.
type Beginner interface {
	Begin(ctx context.Context) (pgx.Tx, error)
}

// Session is the role and transaction-local settings InTx applies.
// App is the default. The other constructors name the session on purpose.
// SQL stays in tenantx. The callback keeps its own statements, including
// locks and triggers.
type Session struct {
	kind   sessKind
	orgID  int64
	userID int64
	grant  string
}

type sessKind uint8

const (
	sessApp sessKind = iota + 1
	sessWorker
	sessStaff
	sessObserver
	sessWallet
	sessSupplier
	sessSupplierOnly
	sessGrant
	sessCatalog
	sessAppRole
)

// App enters the app role for one org. orgID <= 0 is rejected by InTx
// before a transaction starts.
func App(orgID int64) Session { return Session{kind: sessApp, orgID: orgID} }

// Worker enters the cross-tenant claim role. It does not set an org.
func Worker() Session { return Session{kind: sessWorker} }

// Staff enters the app role and the staff flag. It does not set an org.
func Staff() Session { return Session{kind: sessStaff} }

// Observer enters the app role for one platform observer user id.
func Observer(userID int64) Session { return Session{kind: sessObserver, userID: userID} }

// WalletUser enters the app role for one org and that org's wallet user.
func WalletUser(orgID, userID int64) Session {
	return Session{kind: sessWallet, orgID: orgID, userID: userID}
}

// SupplierUser enters the app role for one org and one supplier user.
func SupplierUser(orgID, userID int64) Session {
	return Session{kind: sessSupplier, orgID: orgID, userID: userID}
}

// Supplier enters the app role for one supplier user with no org. It does
// not set the org GUC. userID <= 0 is rejected by InTx before a transaction
// starts.
func Supplier(userID int64) Session { return Session{kind: sessSupplierOnly, userID: userID} }

// AutomationGrant enters the app role for one grant id. The id is stored
// as given. A blank id is rejected by InTx before a transaction starts.
func AutomationGrant(grantID string) Session { return Session{kind: sessGrant, grant: grantID} }

// Catalog enters the catalog writer role. It does not set an org.
func Catalog() Session { return Session{kind: sessCatalog} }

// AppRole enters the app role without an org. It is for platform tables that
// have no org_id and no tenant RLS (banned_tags, platform_catalog_fetch_config).
// Do not use it for a tenant read: tenant_isolation needs app.current_org_id.
func AppRole() Session { return Session{kind: sessAppRole} }

var (
	errEmptySession = errors.New("db: empty session")
	errNilPool      = errors.New("db: nil pool")
	errNilFn        = errors.New("db: nil transaction function")
)

// InTx starts a transaction, applies session, runs fn, and commits.
// A non-nil error from fn rolls the transaction back and is returned as-is.
// fn must not commit or roll back tx. org id <= 0 returns tenantx.ErrOrgUnset
// and does not call Begin.
func InTx(ctx context.Context, pool Beginner, session Session, fn func(pgx.Tx) error) error {
	if err := session.ready(); err != nil {
		return err
	}
	if pool == nil {
		return errNilPool
	}
	if fn == nil {
		return errNilFn
	}
	tx, err := pool.Begin(ctx)
	if err != nil {
		return err
	}
	committed := false
	defer func() {
		if !committed {
			_ = tx.Rollback(ctx)
		}
	}()
	if err := session.enter(ctx, tx); err != nil {
		return err
	}
	if err := fn(tx); err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return err
	}
	committed = true
	return nil
}

func (s Session) ready() error {
	switch s.kind {
	case sessApp:
		if s.orgID <= 0 {
			return tenantx.ErrOrgUnset
		}
	case sessWorker, sessStaff, sessCatalog, sessAppRole:
		return nil
	case sessObserver, sessSupplierOnly:
		if s.userID <= 0 {
			return tenantx.ErrUserUnset
		}
	case sessWallet, sessSupplier:
		if s.orgID <= 0 {
			return tenantx.ErrOrgUnset
		}
		if s.userID <= 0 {
			return tenantx.ErrUserUnset
		}
	case sessGrant:
		if strings.TrimSpace(s.grant) == "" {
			return tenantx.ErrGrantUnset
		}
	default:
		return errEmptySession
	}
	return nil
}

func (s Session) enter(ctx context.Context, tx pgx.Tx) error {
	switch s.kind {
	case sessApp:
		return tenantx.EnterApp(ctx, tx, s.orgID)
	case sessWorker:
		return tenantx.EnterWorker(ctx, tx)
	case sessStaff:
		return tenantx.EnterStaff(ctx, tx)
	case sessObserver:
		return tenantx.EnterObserver(ctx, tx, s.userID)
	case sessWallet:
		return tenantx.EnterWalletUser(ctx, tx, s.orgID, s.userID)
	case sessSupplier:
		return tenantx.EnterSupplierUser(ctx, tx, s.orgID, s.userID)
	case sessSupplierOnly:
		return tenantx.EnterSupplier(ctx, tx, s.userID)
	case sessGrant:
		return tenantx.EnterAutomationGrant(ctx, tx, s.grant)
	case sessCatalog:
		return tenantx.EnterCatalog(ctx, tx)
	case sessAppRole:
		return tenantx.EnterAppRole(ctx, tx)
	default:
		return errEmptySession
	}
}
