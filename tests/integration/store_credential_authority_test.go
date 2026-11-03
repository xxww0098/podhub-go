package integration

import (
	"context"
	"fmt"
	"net/http"
	"testing"
	"time"

	opsrepo "github.com/xxww0098/podhub-go/internal/ops/repo"
	"github.com/xxww0098/podhub-go/internal/platform/db/tenantx"
	"github.com/xxww0098/podhub-go/internal/platform/seal"
	"github.com/xxww0098/podhub-go/internal/store/contract"
	"github.com/xxww0098/podhub-go/internal/store/domain"
	storerepo "github.com/xxww0098/podhub-go/internal/store/repo"
	storesvc "github.com/xxww0098/podhub-go/internal/store/service"
)

type storeCredentialProbe func(context.Context, string, string) (int, []byte, error)

func (probe storeCredentialProbe) Roles(ctx context.Context, clientID, apiKey string) (int, []byte, error) {
	return probe(ctx, clientID, apiKey)
}

func TestStoreCredentialMutationsRecheckRevokedActor(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	pool := migratedPool(t, ctx)
	owner, operator := int64(97701), int64(97702)
	orgID := seedCompanyOrg(t, ctx, pool, owner, "credential-authority")
	seedCompanyOrg(t, ctx, pool, operator, "credential-operator")
	seedCompanyMember(t, ctx, pool, orgID, owner, "owner", 1)
	membership := seedCompanyMember(t, ctx, pool, orgID, operator, "member", 2)
	seedMatchingLease(t, ctx, pool, "entitlement", "credential authority")
	ring := seal.Ring{Primary: seal.DeriveKEK("0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef")}
	directory := storerepo.New(pool, tenantx.BeginApp).WithCredentialKey(ring, true, seal.DefaultSellerKeyID,
		storeCredentialProbe(func(context.Context, string, string) (int, []byte, error) { return http.StatusOK, []byte(`{}`), nil }))
	svc := storesvc.New(directory, nil).WithRoster(directory).WithCredentialDirectory(directory)
	actor, api := directory.LoadActor(ctx, operator, orgID)
	if api != nil {
		t.Fatal(api)
	}
	for i, operation := range []string{"register", "delete", "verify", "export"} {
		t.Run(operation, func(t *testing.T) {
			if _, err := pool.Exec(ctx, `UPDATE organization_members SET manual_disabled = false WHERE id = $1`, membership); err != nil {
				t.Fatal(err)
			}
			uuid := fmt.Sprintf("00000000-0000-4000-8000-%012d", i+701)
			seedCompanyStore(t, ctx, pool, orgID, uuid, i+1, operation, &membership)
			if _, err := pool.Exec(ctx, `UPDATE organization_stores SET assignee_key_manage=true,
				assignee_key_read=true, assignee_key_write=true, assignee_key_edit=true WHERE uuid=$1::uuid`, uuid); err != nil {
				t.Fatal(err)
			}
			registered, api := svc.RegisterCredential(ctx, orgID, owner, uuid, fmt.Sprintf("client-%d", i), "fixture-original-key", 1, nil, true)
			if api != nil {
				t.Fatal(api)
			}
			if _, err := pool.Exec(ctx, `UPDATE organization_members SET manual_disabled = true WHERE id = $1`, membership); err != nil {
				t.Fatal(err)
			}
			if operation == "export" {
				items, api := directory.Export(ctx, orgID, actor)
				if api == nil || api.Status != http.StatusForbidden || len(items) != 0 {
					t.Fatalf("revoked actor exported %d credentials, error=%v", len(items), api)
				}
				return
			}
			api = directory.WriteTx(ctx, orgID, operator, contract.MsgWritesCredential, func(ctx context.Context, tx domain.RosterTx) error {
				var err error
				switch operation {
				case "register":
					_, err = tx.RegisterCredential(ctx, orgID, actor, uuid, fmt.Sprintf("client-%d", i), "fixture-new-key", registered.Revision, &registered.CredentialRevision, nil)
				case "delete":
					_, err = tx.DeleteCredential(ctx, orgID, actor, uuid, registered.Revision, registered.CredentialRevision)
				case "verify":
					_, err = tx.VerifyCredential(ctx, orgID, actor, uuid, registered.CredentialRevision, false, domain.FailureAuthRejected, nil)
				}
				if err != nil {
					return err
				}
				return tx.Record(ctx, domain.AuditRow{Module: "store_credential", EntityType: "workspace_store", EntityID: uuid,
					Method: "POST", Path: "/fixture", Action: "revoked_mutation", Message: map[string]any{}})
			})
			if api == nil || api.Status != http.StatusForbidden {
				t.Fatalf("revoked actor %s error=%v", operation, api)
			}
			var revision, credentialRevision int64
			var hasCredential bool
			if err := pool.QueryRow(ctx, `SELECT s.revision, s.credential_revision,
				EXISTS (SELECT 1 FROM store_seller_credentials c WHERE c.store_id=s.id)
				FROM organization_stores s WHERE s.uuid=$1::uuid`, uuid).Scan(&revision, &credentialRevision, &hasCredential); err != nil {
				t.Fatal(err)
			}
			if revision != registered.Revision || credentialRevision != registered.CredentialRevision || !hasCredential {
				t.Fatalf("revoked mutation changed stored credential: revision=%d generation=%d configured=%v", revision, credentialRevision, hasCredential)
			}
		})
	}
}

func TestWorkspaceStoreCredentialManagementRoles(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	pool := migratedPool(t, ctx)
	const owner, manager, member = int64(97731), int64(97732), int64(97733)
	orgID := seedCompanyOrg(t, ctx, pool, owner, "credential-roles")
	seedCompanyMember(t, ctx, pool, orgID, owner, "owner", 1)
	managerSeat := seedCompanyMember(t, ctx, pool, orgID, manager, "manager", 2)
	memberSeat := seedCompanyMember(t, ctx, pool, orgID, member, "member", 3)
	seedPaidGrantWorkspace(t, ctx, pool, orgID, owner)
	seedMatchingLease(t, ctx, pool, "entitlement", "credential roles")
	uuid := "00000000-0000-4000-8000-000000000731"
	seedCompanyStore(t, ctx, pool, orgID, uuid, 1, "assigned store", &memberSeat)
	if _, err := pool.Exec(ctx, `UPDATE organization_stores SET assignee_key_manage=true WHERE uuid=$1::uuid`, uuid); err != nil {
		t.Fatal(err)
	}
	probes := 0
	ring := seal.Ring{Primary: seal.DeriveKEK("0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef")}
	directory := storerepo.New(pool, tenantx.BeginApp).WithCredentialKey(ring, true, seal.DefaultSellerKeyID,
		storeCredentialProbe(func(context.Context, string, string) (int, []byte, error) {
			probes++
			return http.StatusOK, []byte(`{}`), nil
		}))
	svc := storesvc.New(directory, nil).WithRoster(directory).WithCredentialDirectory(directory)

	registered, api := svc.RegisterCredential(ctx, orgID, manager, uuid, "role-client", "fixture-role-key", 1, nil, true)
	if api != nil {
		t.Fatalf("manager cannot bind an assigned store: %v", api)
	}
	for _, user := range []int64{owner, manager} {
		items, api := svc.ExportCredentials(ctx, orgID, user)
		if api != nil || len(items) != 1 || items[0].APIKey != "fixture-role-key" {
			t.Fatalf("user %d export count=%d error=%v", user, len(items), api)
		}
	}
	memberActor, api := directory.LoadActor(ctx, member, orgID)
	if api != nil {
		t.Fatal(api)
	}
	if items, api := directory.Export(ctx, orgID, memberActor); api == nil || api.Status != http.StatusForbidden || len(items) != 0 {
		t.Fatalf("member repository export count=%d error=%v", len(items), api)
	}
	if items, api := svc.ExportCredentials(ctx, orgID, member); api == nil || api.Status != http.StatusForbidden || len(items) != 0 {
		t.Fatalf("member service export count=%d error=%v", len(items), api)
	}
	beforeProbes := probes
	if _, api := svc.RegisterCredential(ctx, orgID, member, uuid, "role-client", "fixture-other-key", registered.Revision, &registered.CredentialRevision, true); api == nil || api.Status != http.StatusForbidden || probes != beforeProbes {
		t.Fatalf("member bind error=%v probes=%d", api, probes-beforeProbes)
	}
	if _, _, api := svc.DeleteCredential(ctx, orgID, member, uuid, registered.Revision, registered.CredentialRevision); api == nil || api.Status != http.StatusForbidden {
		t.Fatalf("member clear credential error=%v", api)
	}
	nextClient := "member-client"
	if _, _, api := svc.UpdateStore(ctx, orgID, member, "member", uuid, domain.UpdateStoreInput{ClientID: &nextClient, ClientIDSet: true, Revision: registered.Revision}); api == nil || api.Status != http.StatusForbidden {
		t.Fatalf("member change client ID error=%v", api)
	}
	if _, _, _, api := svc.CreateStore(ctx, orgID, member, domain.CreateStoreInput{Name: "self-assigned"}); api == nil || api.Status != http.StatusForbidden {
		t.Fatalf("member create error=%v", api)
	}
	if _, _, api := svc.SetAssignee(ctx, orgID, member, "member", uuid, &memberSeat, registered.Revision); api == nil || api.Status != http.StatusForbidden {
		t.Fatalf("member assign error=%v", api)
	}
	row, actor, api := svc.SetAssignee(ctx, orgID, manager, "manager", uuid, &managerSeat, registered.Revision)
	if api != nil || row.AssigneeMembershipID == nil || *row.AssigneeMembershipID != managerSeat || !row.Permissions(actor, domain.NowMS()).ManageKey {
		t.Fatalf("manager assign row=%+v error=%v", row, api)
	}
	created, _, _, api := svc.CreateStore(ctx, orgID, manager, domain.CreateStoreInput{Name: "manager created", AssigneeMembershipID: &memberSeat})
	if api != nil || created.AssigneeMembershipID == nil || *created.AssigneeMembershipID != memberSeat {
		t.Fatalf("manager create row=%+v error=%v", created, api)
	}
	ops := opsrepo.New(pool, ring, true, seal.DefaultSellerKeyID)
	if admitted, err := ops.Admit(ctx, orgID, manager, "manager", uuid, time.Now().UnixMilli()); err != nil || admitted.Secret.APIKey != "fixture-role-key" {
		t.Fatalf("manager admission error=%v", err)
	}
	if _, err := pool.Exec(ctx, `UPDATE organization_members SET role='member' WHERE id=$1`, managerSeat); err != nil {
		t.Fatal(err)
	}
	if items, api := directory.Export(ctx, orgID, actor); api == nil || api.Status != http.StatusForbidden || len(items) != 0 {
		t.Fatalf("demoted manager export count=%d error=%v", len(items), api)
	}
	if admitted, err := ops.Admit(ctx, orgID, manager, "manager", uuid, time.Now().UnixMilli()); err == nil || admitted.Secret.APIKey != "" {
		t.Fatalf("demoted manager admission returned a key: error=%v", err)
	}
	if admitted, err := ops.Admit(ctx, orgID, manager, "member", uuid, time.Now().UnixMilli()); err != nil || admitted.Secret.APIKey != "fixture-role-key" {
		t.Fatalf("assigned member server-side admission error=%v", err)
	}
}

func TestStoreCredentialTestChecksVisibilityBeforeProbe(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	pool := migratedPool(t, ctx)
	owner, member := int64(97711), int64(97712)
	orgID := seedCompanyOrg(t, ctx, pool, owner, "credential-visibility")
	seedCompanyMember(t, ctx, pool, orgID, owner, "owner", 1)
	seedCompanyMember(t, ctx, pool, orgID, member, "member", 2)
	seedMatchingLease(t, ctx, pool, "entitlement", "credential visibility")
	uuid := "00000000-0000-4000-8000-000000000711"
	seedCompanyStore(t, ctx, pool, orgID, uuid, 1, "private store", nil)
	probes := 0
	ring := seal.Ring{Primary: seal.DeriveKEK("0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef")}
	directory := storerepo.New(pool, tenantx.BeginApp).WithCredentialKey(ring, true, seal.DefaultSellerKeyID,
		storeCredentialProbe(func(context.Context, string, string) (int, []byte, error) {
			probes++
			return http.StatusOK, []byte(`{}`), nil
		}))
	svc := storesvc.New(directory, nil).WithRoster(directory).WithCredentialDirectory(directory)
	if _, api := svc.RegisterCredential(ctx, orgID, owner, uuid, "client-private", "fixture-private-key", 1, nil, true); api != nil {
		t.Fatal(api)
	}
	probes = 0
	_, api := svc.TestCredential(ctx, orgID, member, uuid)
	if api == nil || api.Status != http.StatusNotFound {
		t.Fatalf("invisible store error=%v", api)
	}
	if probes != 0 {
		t.Fatalf("invisible store spent %d credential probes", probes)
	}
	var leased *int64
	if err := pool.QueryRow(ctx, `SELECT c.last_leased_at_ms FROM store_seller_credentials c
		JOIN organization_stores s ON s.id=c.store_id WHERE s.uuid=$1::uuid`, uuid).Scan(&leased); err != nil {
		t.Fatal(err)
	}
	if leased != nil {
		t.Fatalf("invisible store recorded credential usage at %d", *leased)
	}
	if _, api := svc.TestCredential(ctx, orgID, owner, uuid); api != nil || probes != 1 {
		t.Fatalf("owner probe: calls=%d error=%v", probes, api)
	}
}

func TestStoreCredentialRotationAdvancesGenerationBeforeVerification(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	pool := migratedPool(t, ctx)
	owner := int64(97721)
	orgID := seedCompanyOrg(t, ctx, pool, owner, "credential-rotation")
	seedCompanyMember(t, ctx, pool, orgID, owner, "owner", 1)
	seedMatchingLease(t, ctx, pool, "entitlement", "credential rotation")
	uuid := "00000000-0000-4000-8000-000000000721"
	seedCompanyStore(t, ctx, pool, orgID, uuid, 1, "rotating store", nil)
	ring := seal.Ring{Primary: seal.DeriveKEK("0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef")}
	directory := storerepo.New(pool, tenantx.BeginApp).WithCredentialKey(ring, true, seal.DefaultSellerKeyID,
		storeCredentialProbe(func(context.Context, string, string) (int, []byte, error) { return http.StatusOK, []byte(`{}`), nil }))
	svc := storesvc.New(directory, nil).WithRoster(directory).WithCredentialDirectory(directory)
	first, api := svc.RegisterCredential(ctx, orgID, owner, uuid, "rotation-client", "fixture-before", 1, nil, true)
	if api != nil {
		t.Fatal(api)
	}
	next, api := svc.RegisterCredential(ctx, orgID, owner, uuid, "rotation-client", "fixture-after", first.Revision, &first.CredentialRevision, true)
	if api != nil {
		t.Fatalf("valid credential rotation failed: %v", api)
	}
	if !next.Rotated || !next.FingerprintChanged || next.CredentialRevision != first.CredentialRevision+1 || next.Revision != first.Revision+1 {
		t.Fatalf("rotation did not advance both revisions: first=%+v next=%+v", first, next)
	}
	actor, api := directory.LoadActor(ctx, owner, orgID)
	if api != nil {
		t.Fatal(api)
	}
	items, api := directory.Export(ctx, orgID, actor)
	if api != nil || len(items) != 1 || items[0].APIKey != "fixture-after" {
		t.Fatalf("new generation was not readable: count=%d error=%v", len(items), api)
	}
	var currentVerified bool
	if err := pool.QueryRow(ctx, `SELECT v.verified FROM store_credential_verifications v
		JOIN organization_stores s ON s.id=v.store_id AND s.credential_revision=v.credential_revision
		WHERE s.uuid=$1::uuid AND v.user_id=$2`, uuid, owner).Scan(&currentVerified); err != nil || !currentVerified {
		t.Fatalf("new generation verification missing: verified=%v error=%v", currentVerified, err)
	}
	repeated, api := svc.RegisterCredential(ctx, orgID, owner, uuid, "rotation-client", "fixture-after", next.Revision, &next.CredentialRevision, true)
	if api != nil || repeated.FingerprintChanged || repeated.Revision != next.Revision || repeated.CredentialRevision != next.CredentialRevision {
		t.Fatalf("same-pair retry changed generation: %+v error=%v", repeated, api)
	}
	if _, api := svc.RegisterCredential(ctx, orgID, owner, uuid, "rotation-client", "fixture-stale", first.Revision, &first.CredentialRevision, true); api == nil || api.Status != http.StatusConflict {
		t.Fatalf("stale rotation error=%v", api)
	}
	if _, err := pool.Exec(ctx, `CREATE FUNCTION reject_store_verification() RETURNS trigger LANGUAGE plpgsql AS $$
		BEGIN RAISE EXCEPTION 'fixture verification failure'; END $$;
		CREATE TRIGGER reject_store_verification BEFORE INSERT OR UPDATE ON store_credential_verifications
		FOR EACH ROW EXECUTE FUNCTION reject_store_verification()`); err != nil {
		t.Fatal(err)
	}
	if _, api := svc.RegisterCredential(ctx, orgID, owner, uuid, "rotation-client", "fixture-rolled-back", next.Revision, &next.CredentialRevision, true); api == nil {
		t.Fatal("verification failure did not abort credential rotation")
	}
	items, api = directory.Export(ctx, orgID, actor)
	if api != nil || len(items) != 1 || items[0].APIKey != "fixture-after" {
		t.Fatalf("failed rotation replaced the previous credential: count=%d error=%v", len(items), api)
	}
	var rowRevision, credentialRevision int64
	if err := pool.QueryRow(ctx, `SELECT revision, credential_revision FROM organization_stores WHERE uuid=$1::uuid`, uuid).Scan(&rowRevision, &credentialRevision); err != nil {
		t.Fatal(err)
	}
	if rowRevision != next.Revision || credentialRevision != next.CredentialRevision {
		t.Fatalf("failed rotation changed revisions: row=%d credential=%d", rowRevision, credentialRevision)
	}
}
