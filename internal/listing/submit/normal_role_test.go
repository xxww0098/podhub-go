package submit

import (
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

func TestSendStoredUsesTenantRoleForAtomicEnqueue(t *testing.T) {
	f := newStoredRevisionFixture(t, 96223)
	row := f.row(t, 1, "normal-role")
	f.bind(t, &storedRevisionModule{})
	if _, err := f.pool.Exec(f.ctx, `ALTER ROLE podhub_login_api PASSWORD 'normal-submit-login'`); err != nil {
		t.Fatal(err)
	}
	cfg := f.pool.Config().Copy()
	cfg.ConnConfig.User, cfg.ConnConfig.Password = "podhub_login_api", "normal-submit-login"
	apiPool, err := pgxpool.NewWithConfig(f.ctx, cfg)
	if err != nil {
		t.Fatal(err)
	}
	defer apiPool.Close()
	request := f.request(t, []string{row}, map[string]int64{row: 1})
	for _, created := range []bool{true, false} {
		result, err := testSubmit().SendStored(f.ctx, apiPool, f.org, f.user, request, time.Now())
		if err != nil || len(result.Items) != 1 || result.Items[0].Created != created || result.Items[0].Intent == nil || result.Items[0].Intent.State != Queued {
			t.Fatalf("normal role atomic enqueue/replay: %+v err=%v", result, err)
		}
	}
	var jobs, intents int
	if err := f.pool.QueryRow(f.ctx, `SELECT count(*) FROM jobs WHERE org_id=$1`, f.org).Scan(&jobs); err != nil {
		t.Fatal(err)
	}
	if err := f.pool.QueryRow(f.ctx, `SELECT count(*) FROM submission_intents WHERE org_id=$1`, f.org).Scan(&intents); err != nil || jobs != 1 || intents != 1 {
		t.Fatalf("enqueue or replay lost atomicity: jobs=%d intents=%d err=%v", jobs, intents, err)
	}
	var role string
	if err := apiPool.QueryRow(f.ctx, `SELECT current_user`).Scan(&role); err != nil || role != "podhub_login_api" {
		t.Fatalf("role not restored: %s err=%v", role, err)
	}
	_, err = apiPool.Exec(f.ctx, `SET ROLE podhub_worker`)
	if pgErr, ok := err.(*pgconn.PgError); !ok || pgErr.Code != "42501" {
		t.Fatalf("API login gained worker authority: %v", err)
	}
}
