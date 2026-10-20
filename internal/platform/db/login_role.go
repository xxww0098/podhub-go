package db

import (
	"context"
	"fmt"

	"github.com/jackc/pgx/v5"

	"github.com/xxww0098/podhub-go/internal/platform/config"
)

// allowSuperuserDB is the only caller of config.AllowSuperuserDB.
// The value 1 lets a superuser or BYPASSRLS login open the pool. Tests that
// still dial the postgres role set it. Every other value, including unset,
// refuses that login.
func allowSuperuserDB() bool {
	return config.AllowSuperuserDB()
}

// rejectPrivilegedLogin fails the connection when current_user is a superuser
// or has BYPASSRLS. FORCE ROW LEVEL SECURITY does not apply to those roles.
func rejectPrivilegedLogin(ctx context.Context, conn *pgx.Conn) error {
	if allowSuperuserDB() {
		return nil
	}
	var name string
	var super, bypass bool
	err := conn.QueryRow(ctx, `
		SELECT r.rolname, r.rolsuper, r.rolbypassrls
		  FROM pg_roles r
		 WHERE r.rolname = current_user`).Scan(&name, &super, &bypass)
	if err != nil {
		return err
	}
	if super || bypass {
		return fmt.Errorf("database login %s is superuser or BYPASSRLS", name)
	}
	return nil
}
