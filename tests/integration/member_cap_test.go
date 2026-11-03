package integration

import (
	"errors"
	"fmt"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgconn"
	userscontract "github.com/xxww0098/podhub-go/internal/admin/users/contract"
	"github.com/xxww0098/podhub-go/internal/billing/domain"
)

// Members are not sold: the cap lives in billing/domain, admin/users/contract
// and subscription_capacity(). The three must stay equal.
func TestMemberCapAgreesAcrossGoAndSQL(t *testing.T) {
	ctx := t.Context()
	pool := migratedPool(t, ctx)
	org, owner := seedAITenant(t, ctx, pool, 96181)
	now := time.Now()

	if domain.MemberCap != userscontract.MemberCap {
		t.Fatalf("Go caps disagree: billing=%d admin=%d", domain.MemberCap, userscontract.MemberCap)
	}
	var plan string
	var members int64
	if err := pool.QueryRow(ctx, `SELECT plan_key,members FROM public.subscription_capacity($1,$2)`, org, now).Scan(&plan, &members); err != nil {
		t.Fatal(err)
	}
	if plan != "free" || members != domain.MemberCap {
		t.Fatalf("fresh free workspace: plan=%s members=%d, want free/%d", plan, members, domain.MemberCap)
	}

	t.Run("admission follows join order", func(t *testing.T) {
		ids := []int64{}
		var ownerMembership int64
		if err := pool.QueryRow(ctx, `SELECT id FROM organization_members WHERE org_id=$1 AND user_id=$2`, org, owner).Scan(&ownerMembership); err != nil {
			t.Fatal(err)
		}
		ids = append(ids, ownerMembership)
		for i := range 11 {
			var user int64
			tag := fmt.Sprintf("member-cap-%d", i)
			if err := pool.QueryRow(ctx, `INSERT INTO account_users(public_id,email,password_hash,role,name,target,supplier_id,plan,created_at,updated_at)
 VALUES($1::text,$1::text||'@example.invalid','x','user','synthetic','/workspace','','lite',clock_timestamp(),clock_timestamp()) RETURNING id`, tag).Scan(&user); err != nil {
				t.Fatal(err)
			}
			ids = append(ids, seedCompanyMember(t, ctx, pool, org, user, "member", i+2))
		}
		for i, id := range ids {
			var allowed bool
			if err := pool.QueryRow(ctx, `SELECT public.subscription_member_allowed($1,$2,$3)`, org, id, now).Scan(&allowed); err != nil {
				t.Fatal(err)
			}
			// ids[0] is the owner, ids[1:10] are the first nine joiners, ids[10:] the last two.
			if want := i < 10; allowed != want {
				t.Errorf("member #%d (join_order %d): allowed=%v want=%v", i, i+1, allowed, want)
			}
		}
	})

	t.Run("override stays within one to the cap", func(t *testing.T) {
		for _, bad := range []int64{domain.MemberCap + 1, 0} {
			_, err := pool.Exec(ctx, `UPDATE organizations SET member_seat_limit_override=$2 WHERE id=$1`, org, bad)
			var constraint *pgconn.PgError
			if !errors.As(err, &constraint) || constraint.Code != "23514" || constraint.ConstraintName != "ck_organizations_member_seat_limit_override" {
				t.Errorf("override %d accepted or wrong error: %v", bad, err)
			}
		}
		for _, ok := range []int64{1, domain.MemberCap} {
			if _, err := pool.Exec(ctx, `UPDATE organizations SET member_seat_limit_override=$2 WHERE id=$1`, org, ok); err != nil {
				t.Errorf("override %d rejected: %v", ok, err)
			}
		}
	})
}
