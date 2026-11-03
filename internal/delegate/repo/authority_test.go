package delegaterepo

import (
	"context"
	"errors"
	"sync/atomic"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/xxww0098/podhub-go/internal/delegate/contract"
	delegatesvc "github.com/xxww0098/podhub-go/internal/delegate/service"
	"github.com/xxww0098/podhub-go/internal/platform/db/tenantx"
	"github.com/xxww0098/podhub-go/internal/platform/writer"
)

var authorityUser atomic.Int64

type authorityFixture struct {
	pool                     *pgxpool.Pool
	ctx                      context.Context
	repo                     Repo
	org, owner, user, member int64
	store, source            string
}

func newAuthorityFixture(t *testing.T) authorityFixture {
	t.Helper()
	pool, ctx := parityDB(t)
	owner := int64(885800) + 2*authorityUser.Add(1)
	f := authorityFixture{pool: pool, ctx: ctx, repo: New(pool, tenantx.BeginApp), owner: owner, user: owner + 1,
		store: uuid.NewString(), source: "authority-" + uuid.NewString()}
	f.org = seedOrg(t, ctx, pool, owner, "authority")
	seedUser(t, ctx, pool, f.user, "authority-member")
	if err := pool.QueryRow(ctx, `INSERT INTO organization_members
		(org_id,user_id,role,status,display_name,join_order,created_at,updated_at)
		VALUES ($1,$2,'manager','active','operator',2,clock_timestamp(),clock_timestamp()) RETURNING id`, f.org, f.user).Scan(&f.member); err != nil {
		t.Fatal(err)
	}
	var storePK int64
	if err := pool.QueryRow(ctx, `INSERT INTO organization_stores (org_id,uuid,create_order,name,credential_revision)
		VALUES ($1,$2::uuid,1,'authority store',1) RETURNING id`, f.org, f.store).Scan(&storePK); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO store_seller_credentials
		(store_id,org_id,credential_revision,client_id,key_id,nonce,ciphertext,key_fingerprint,registered_by_user_id,registered_at_ms)
		VALUES ($1,$2,1,'fixture','fixture',decode(repeat('01',12),'hex'),decode(repeat('02',17),'hex'),decode(repeat('03',32),'hex'),$3,1)`, storePK, f.org, owner); err != nil {
		t.Fatal(err)
	}
	seedSource(t, ctx, pool, f.source, f.source)
	if _, err := pool.Exec(ctx, `UPDATE sc_sources SET listed=true,accepts_delegate=true WHERE source_id=$1`, f.source); err != nil {
		t.Fatal(err)
	}
	seedDelegateLease(t, ctx, pool, "entitlement")
	return f
}

func seedDelegateLease(t *testing.T, ctx context.Context, pool *pgxpool.Pool, domain string) {
	t.Helper()
	identity := writer.ProcessIdentity()
	now := time.Now().UnixMilli()
	if _, err := pool.Exec(ctx, `INSERT INTO writer_leases
		(domain,holder,holder_instance,fence_token,granted_at_ms,expires_at_ms,heartbeat_at_ms,grant_reason)
		VALUES ($1,$2,$3,1,0,$4,$5,'delegate regression')
		ON CONFLICT (domain) WHERE revoked_at_ms IS NULL DO UPDATE
		SET holder=EXCLUDED.holder,holder_instance=EXCLUDED.holder_instance,expires_at_ms=EXCLUDED.expires_at_ms`,
		domain, identity.Holder, identity.InstanceID, now+600000, now); err != nil {
		t.Fatal(err)
	}
}

func (f authorityFixture) exec(t *testing.T, query string, args ...any) {
	t.Helper()
	if _, err := f.pool.Exec(f.ctx, query, args...); err != nil {
		t.Fatal(err)
	}
}

func TestCreateOrderRechecksAuthorityAfterSellerRead(t *testing.T) {
	for _, change := range []string{"member disabled", "manager demoted", "store disabled", "store deleted"} {
		t.Run(change, func(t *testing.T) {
			f := newAuthorityFixture(t)
			calls := 0
			svc := delegatesvc.Seller{DB: f.repo, Edge: delegatesvc.Edge{
				Open: func(contract.SealedCredential) (string, string, error) { return "fixture", "fixture", nil },
				Seller: func(context.Context, string, string, string, []byte) (int, []byte, string, error) {
					calls++
					if calls == 1 {
						switch change {
						case "member disabled":
							f.exec(t, `UPDATE organization_members SET manual_disabled=true WHERE id=$1`, f.member)
						case "manager demoted":
							f.exec(t, `UPDATE organization_members SET role='member' WHERE id=$1`, f.member)
						case "store disabled":
							f.exec(t, `UPDATE organization_stores SET manual_disabled=true WHERE uuid=$1::uuid`, f.store)
						case "store deleted":
							f.exec(t, `UPDATE organization_stores SET deleted_at_ms=1 WHERE uuid=$1::uuid`, f.store)
						}
						return 200, []byte(`{"postings":[{"posting_number":"post-authority","products":[{"offer_id":"offer","quantity":1}]}]}`), "", nil
					}
					return 200, []byte(`{"result":{}}`), "", nil
				},
			}}
			_, err := svc.CreateOrder(f.ctx, delegatesvc.Actor{OrgID: f.org, UserID: f.user, Role: "manager", CanManage: true}, f.store, "post-authority", "", "key", nil, false)
			var orders, audits int
			if scanErr := f.pool.QueryRow(f.ctx, `SELECT
				(SELECT count(*) FROM delegate_orders WHERE org_id=$1),
				(SELECT count(*) FROM audit_logs WHERE org_id=$1 AND action='delegate_order_created')`, f.org).Scan(&orders, &audits); scanErr != nil {
				t.Fatal(scanErr)
			}
			if err == nil || orders != 0 || audits != 0 {
				t.Fatalf("revoked authority persisted order: orders=%d audits=%d error=%v", orders, audits, err)
			}
		})
	}
}

func TestDelegateVisibilityRechecksManagerRole(t *testing.T) {
	f := newAuthorityFixture(t)
	order, _ := seedPacket(t, f.ctx, f.pool, f.org, f.owner, f.source, "dispatched", "dispatched", nil)
	f.exec(t, `UPDATE delegate_orders SET store_id=$2::uuid WHERE order_id=$1::uuid`, order, f.store)
	f.exec(t, `UPDATE organization_members SET role='member' WHERE id=$1`, f.member)
	t.Run("store", func(t *testing.T) {
		_, err := f.repo.StoreGate(f.ctx, f.org, f.user, true, f.store)
		assertDelegateStatus(t, err, 404)
	})
	t.Run("credential", func(t *testing.T) {
		_, err := f.repo.AdmitStore(f.ctx, f.org, f.user, true, f.store, time.Now().UnixMilli())
		assertDelegateStatus(t, err, 404)
	})
	t.Run("visible stores", func(t *testing.T) {
		rows, err := f.repo.VisibleStoreUUIDs(f.ctx, f.org, f.user, true)
		if err != nil || len(rows) != 0 {
			t.Fatalf("demoted manager sees stores=%v error=%v", rows, err)
		}
	})
	t.Run("orders", func(t *testing.T) {
		svc := delegatesvc.Seller{DB: f.repo}
		rows, _, _, err := svc.Orders(f.ctx, delegatesvc.Actor{OrgID: f.org, UserID: f.user, CanManage: true}, "", "", "", "", nil)
		if err != nil || len(rows) != 0 {
			t.Fatalf("demoted manager sees %d orders, error=%v", len(rows), err)
		}
	})
	for _, action := range []string{"read", "cancel", "close", "nudge"} {
		t.Run(action, func(t *testing.T) {
			f.exec(t, `UPDATE delegate_orders SET state='dispatched' WHERE order_id=$1::uuid`, order)
			f.exec(t, `UPDATE delegate_dispatches SET state='dispatched',nudge_count=0,nudged_at_ms=NULL WHERE order_id=$1::uuid`, order)
			var err error
			switch action {
			case "read":
				_, err = f.repo.GetOrder(f.ctx, f.org, f.user, true, order)
			case "cancel":
				_, err = f.repo.CancelOrder(f.ctx, f.org, f.user, true, order, time.Now().UnixMilli())
			case "close":
				_, err = f.repo.CloseOrder(f.ctx, f.org, f.user, true, order, time.Now().UnixMilli())
			case "nudge":
				_, err = f.repo.NudgeOrder(f.ctx, f.org, f.user, true, order, time.Now().UnixMilli())
			}
			assertDelegateStatus(t, err, 404)
			var state string
			var nudges int
			if err := f.pool.QueryRow(f.ctx, `SELECT o.state,d.nudge_count FROM delegate_orders o
				JOIN delegate_dispatches d ON d.order_id=o.order_id WHERE o.order_id=$1::uuid`, order).Scan(&state, &nudges); err != nil {
				t.Fatal(err)
			}
			if state != "dispatched" || nudges != 0 {
				t.Fatalf("demoted actor changed order: state=%s nudges=%d", state, nudges)
			}
		})
	}
}

func TestCreateBindingRechecksRevokedMember(t *testing.T) {
	f := newAuthorityFixture(t)
	if _, err := f.repo.StoreGate(f.ctx, f.org, f.user, true, f.store); err != nil {
		t.Fatal(err)
	}
	f.exec(t, `INSERT INTO delegate_bindings (org_id,store_id,offer_id,source_id,active,created_by,created_at_ms,updated_at_ms)
		VALUES ($1,$2::uuid,'offer',$3,false,$4,1,1)`, f.org, f.store, f.source, f.user)
	f.exec(t, `UPDATE organization_members SET manual_disabled=true WHERE id=$1`, f.member)
	_, err := f.repo.CreateBinding(f.ctx, f.org, f.user, f.store, "offer", f.source, "", false, time.Now().UnixMilli())
	assertDelegateStatus(t, err, 403)
	var active bool
	if err := f.pool.QueryRow(f.ctx, `SELECT active FROM delegate_bindings WHERE org_id=$1`, f.org).Scan(&active); err != nil || active {
		t.Fatalf("revoked member revived binding: active=%v error=%v", active, err)
	}
}

func TestCreateOrderAllowsCurrentAuthorityAndReplays(t *testing.T) {
	for _, role := range []string{"manager", "assignee"} {
		t.Run(role, func(t *testing.T) {
			f := newAuthorityFixture(t)
			manage := role == "manager"
			if !manage {
				f.exec(t, `UPDATE organization_members SET role='member' WHERE id=$1`, f.member)
				f.exec(t, `UPDATE organization_stores SET assignee_membership_id=$2 WHERE uuid=$1::uuid`, f.store, f.member)
			}
			input := CreateInput{StoreID: f.store, PostingNumber: "valid-post", Snapshot: []byte(`{}`),
				Lines: []CreateLine{{OfferID: "offer", Quantity: 1}}, UserID: f.user, CanManage: manage, NowMS: time.Now().UnixMilli()}
			created, err := f.repo.CreateOrder(f.ctx, f.org, input)
			if err != nil {
				t.Fatal(err)
			}
			result := make(chan error, 2)
			for i := 0; i < 2; i++ {
				go func() {
					replayed, err := f.repo.CreateOrder(f.ctx, f.org, input)
					if err == nil && replayed.OrderID != created.OrderID {
						err = errors.New("posting replay changed order id")
					}
					result <- err
				}()
			}
			for i := 0; i < 2; i++ {
				if err := <-result; err != nil {
					t.Fatal(err)
				}
			}
			var orders, lines int
			if err := f.pool.QueryRow(f.ctx, `SELECT (SELECT count(*) FROM delegate_orders WHERE org_id=$1),
				(SELECT count(*) FROM delegate_order_lines WHERE org_id=$1)`, f.org).Scan(&orders, &lines); err != nil {
				t.Fatal(err)
			}
			if orders != 1 || lines != 1 {
				t.Fatalf("concurrent replay duplicated posting: orders=%d lines=%d", orders, lines)
			}
			svc := delegatesvc.Seller{DB: f.repo}
			visible, _, _, err := svc.Orders(f.ctx, delegatesvc.Actor{OrgID: f.org, UserID: f.user, CanManage: manage}, "", "", "", "", nil)
			if err != nil || len(visible) != 1 || visible[0].OrderID != created.OrderID {
				t.Fatalf("current authority cannot list its order: rows=%v error=%v", visible, err)
			}
		})
	}
}

func TestCreateOrderWaitsForAuthorityRevocation(t *testing.T) {
	f := newAuthorityFixture(t)
	revoke, err := f.pool.Begin(f.ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer revoke.Rollback(f.ctx)
	var blocker int
	if err := revoke.QueryRow(f.ctx, `SELECT pg_backend_pid() FROM organizations WHERE id=$1 FOR NO KEY UPDATE`, f.org).Scan(&blocker); err != nil {
		t.Fatal(err)
	}
	result := make(chan error, 1)
	go func() {
		_, err := f.repo.CreateOrder(f.ctx, f.org, CreateInput{StoreID: f.store, PostingNumber: "waiting-post", Snapshot: []byte(`{}`),
			Lines: []CreateLine{{OfferID: "offer", Quantity: 1}}, UserID: f.user, CanManage: true, NowMS: time.Now().UnixMilli()})
		result <- err
	}()
	deadline := time.Now().Add(5 * time.Second)
	for {
		var blocked bool
		if err := f.pool.QueryRow(f.ctx, `SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid)))`, blocker).Scan(&blocked); err != nil {
			t.Fatal(err)
		}
		if blocked {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("creation did not wait on the workspace authority lock")
		}
		time.Sleep(10 * time.Millisecond)
	}
	if _, err := revoke.Exec(f.ctx, `UPDATE organization_members SET manual_disabled=true WHERE id=$1`, f.member); err != nil {
		t.Fatal(err)
	}
	if err := revoke.Commit(f.ctx); err != nil {
		t.Fatal(err)
	}
	assertDelegateStatus(t, <-result, 403)
	var orders int
	if err := f.pool.QueryRow(f.ctx, `SELECT count(*) FROM delegate_orders WHERE org_id=$1`, f.org).Scan(&orders); err != nil || orders != 0 {
		t.Fatalf("revocation committed before creation but orders=%d error=%v", orders, err)
	}
}

func assertDelegateStatus(t *testing.T, err error, want int) {
	t.Helper()
	var api *contract.APIError
	if !errors.As(err, &api) || api.Status != want {
		t.Fatalf("error=%v, want status %d", err, want)
	}
}
