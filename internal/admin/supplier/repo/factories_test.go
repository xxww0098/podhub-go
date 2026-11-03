package supplierrepo

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5"
	"golang.org/x/crypto/bcrypt"

	"github.com/xxww0098/podhub-go/internal/admin/contract"
	"github.com/xxww0098/podhub-go/internal/admin/domain"
	"github.com/xxww0098/podhub-go/internal/identity"
	"github.com/xxww0098/podhub-go/internal/platform/db"
	"github.com/xxww0098/podhub-go/internal/platform/db/tenantx"
)

func TestFactoryOwnsAccountsAcrossMultipleLibraries(t *testing.T) {
	pool, ctx := supParityDB(t)
	const adminID = int64(910321)
	t.Cleanup(func() {
		c := context.Background()
		_, _ = pool.Exec(c, `DELETE FROM sc_source_fulfillers WHERE source_id LIKE 'src_factory_910321_%'`)
		_, _ = pool.Exec(c, `DELETE FROM sc_sources WHERE source_id LIKE 'src_factory_910321_%'`)
		_, _ = pool.Exec(c, `DELETE FROM sc_factory_members WHERE factory_id='fac_test_910321'`)
		_, _ = pool.Exec(c, `DELETE FROM sc_factories WHERE factory_id='fac_test_910321'`)
		_, _ = pool.Exec(c, `DELETE FROM account_users WHERE id IN ($1,910322) OR email='factory910321@example.invalid'`, adminID)
	})
	seedAccountUser(t, ctx, pool, adminID, "a910321", "super_admin", "/workspace", "platform")
	supSeedLease(t, ctx, pool)
	portal := Portal{Pool: pool, Begin: tenantx.BeginApp}
	admin := contract.Actor{UserID: adminID, Role: "super_admin"}
	input := domain.FactoryInput{Name: "独立测试工厂", AccountEmail: "factory910321@example.invalid"}
	hashBytes, err := bcrypt.GenerateFromPassword([]byte("initial-password"), 12)
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err := portal.CreateFactory(ctx, contract.Actor{UserID: adminID, Role: "admin"}, input, "fac_test_denied", 1, "initial-password", string(hashBytes)); err == nil {
		t.Fatal("ordinary admin created a factory")
	}
	factory, initial, err := portal.CreateFactory(ctx, admin, input, "fac_test_910321", 1, "initial-password", string(hashBytes))
	if err != nil || initial == nil || *initial != "initial-password" {
		t.Fatalf("factory %+v initial %v: %v", factory, initial, err)
	}
	var userID int64
	var publicID, hash, kind string
	var mustChange bool
	if err := pool.QueryRow(ctx, `SELECT id, public_id, password_hash, account_kind, must_change_password FROM account_users WHERE email=$1`, input.AccountEmail).Scan(&userID, &publicID, &hash, &kind, &mustChange); err != nil {
		t.Fatal(err)
	}
	if kind != "supplier" || !mustChange || bcrypt.CompareHashAndPassword([]byte(hash), []byte(*initial)) != nil {
		t.Fatal("factory login account was not provisioned correctly")
	}
	identityService := identity.New(pool)
	login := identityService.Login(httptest.NewRequest(http.MethodPost, "/api/auth/login", strings.NewReader(`{"email":"factory910321@example.invalid","password":"initial-password"}`)))
	if login.Status != http.StatusOK || len(login.Cookies) == 0 {
		t.Fatalf("factory login: %d %s", login.Status, login.Body)
	}
	register := identityService.Register(httptest.NewRequest(http.MethodPost, "/api/auth/register", strings.NewReader(`{"email":"self-created@example.invalid","password":"initial-password","account_kind":"supplier"}`)))
	if register.Status != http.StatusBadRequest {
		t.Fatalf("supplier self-registration: %d %s", register.Status, register.Body)
	}

	for _, sourceID := range []string{"src_factory_910321_a", "src_factory_910321_b"} {
		row, err := portal.CreateDb(ctx, admin, domain.NormalizedDb{Name: sourceID, FactoryID: factory.FactoryID}, sourceID, nil, 2)
		if err != nil || row.FactoryID == nil || *row.FactoryID != factory.FactoryID {
			t.Fatalf("create %s: %+v %v", sourceID, row, err)
		}
		if _, err := portal.GrantFulfiller(ctx, admin, sourceID, publicID, 3); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := pool.Exec(ctx, `INSERT INTO sc_sources(source_id,name,created_at_ms,updated_at_ms) VALUES ('src_factory_910321_unbound','待绑定测试库',1,1)`); err != nil {
		t.Fatal(err)
	}
	bound, err := portal.UpdateDb(ctx, admin, "src_factory_910321_unbound", domain.NormalizedDb{Name: "待绑定测试库", FactoryID: factory.FactoryID, KeepViewPrefs: true}, 3)
	if err != nil || bound.FactoryID == nil || *bound.FactoryID != factory.FactoryID {
		t.Fatalf("bind existing library: %+v %v", bound, err)
	}
	if _, err := portal.UpdateDb(ctx, admin, "src_factory_910321_unbound", domain.NormalizedDb{Name: "待绑定测试库", FactoryID: factory.FactoryID, KeepViewPrefs: true}, 3); err == nil {
		t.Fatal("allowed rebinding a bound library")
	}
	if _, err := pool.Exec(ctx, `INSERT INTO sc_sources(source_id,name,created_at_ms,updated_at_ms) VALUES ('src_factory_910321_conflict','已有履约人的库',1,1)`); err != nil {
		t.Fatal(err)
	}
	seedAccountUser(t, ctx, pool, 910322, "a910322", "user", "/supplier", "supplier")
	if _, err := pool.Exec(ctx, `INSERT INTO sc_source_fulfillers(source_id,user_id,created_by,created_at_ms) VALUES ('src_factory_910321_conflict',910322,$1,1)`, adminID); err != nil {
		t.Fatal(err)
	}
	if _, err := portal.UpdateDb(ctx, admin, "src_factory_910321_conflict", domain.NormalizedDb{Name: "已有履约人的库", FactoryID: factory.FactoryID, KeepViewPrefs: true}, 3); err == nil {
		t.Fatal("bound a library with an unrelated active fulfiller")
	}
	directory, err := portal.ListFactories(ctx, admin)
	if err != nil {
		t.Fatal(err)
	}
	var libraryCount int
	for _, entry := range directory {
		if entry.FactoryID == factory.FactoryID {
			libraryCount = len(entry.Libraries)
		}
	}
	if libraryCount != 3 {
		t.Fatalf("factory directory has %d libraries, want 3", libraryCount)
	}
	if err := portal.DeleteFactory(ctx, admin, factory.FactoryID); err == nil {
		t.Fatal("deleted a factory with bound libraries")
	}
	if err := db.InTx(ctx, pool, db.Supplier(userID), func(tx pgx.Tx) error {
		var count int
		if err := tx.QueryRow(ctx, `SELECT count(*) FROM sc_sources WHERE source_id IN ('src_factory_910321_a','src_factory_910321_b')`).Scan(&count); err != nil {
			return err
		}
		if count != 2 {
			t.Errorf("factory member sees %d bound libraries, want 2", count)
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}

	members, err := portal.ListAccounts(ctx, admin)
	if err != nil {
		t.Fatal(err)
	}
	var memberID string
	for _, member := range members {
		if member.Factory.FactoryID == factory.FactoryID {
			memberID = member.MemberID
		}
	}
	if memberID == "" {
		t.Fatal("factory member missing")
	}
	status := "disabled"
	if _, _, err := portal.PatchAccount(ctx, admin, memberID, domain.AccountPatch{Status: &status}, "", 4); err != nil {
		t.Fatal(err)
	}
	var active int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM sc_source_fulfillers WHERE user_id=$1 AND status='active'`, userID).Scan(&active); err != nil || active != 0 {
		t.Fatalf("disabled member has %d grants: %v", active, err)
	}
	if err := portal.DeleteDb(ctx, admin, "src_factory_910321_a"); err != nil {
		t.Fatal(err)
	}
	var membersLeft, factoriesLeft int
	if err := pool.QueryRow(ctx, `SELECT (SELECT count(*) FROM sc_factory_members WHERE factory_id=$1), (SELECT count(*) FROM sc_factories WHERE factory_id=$1)`, factory.FactoryID).Scan(&membersLeft, &factoriesLeft); err != nil || membersLeft != 1 || factoriesLeft != 1 {
		t.Fatalf("factory/member after library deletion: %d/%d %v", factoriesLeft, membersLeft, err)
	}
}
