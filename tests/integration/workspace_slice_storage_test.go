package integration

import (
	"context"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	mediarepo "github.com/xxww0098/podhub-go/internal/media/repo"
	"github.com/xxww0098/podhub-go/internal/platform/db"
	sign "github.com/xxww0098/podhub-go/internal/platform/r2/sigv4"
)

func TestWorkspaceSliceStorageOwnerAndTenantIsolation(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
	defer cancel()
	pool := migratedPool(t, ctx)
	owner, org, _ := securityOrg(t, ctx, pool, "slice-owner")
	member, otherOrg, _ := securityOrg(t, ctx, pool, "slice-member")
	insertMember(t, ctx, pool, org, owner, "owner", 1)
	insertMember(t, ctx, pool, org, member, "member", 2)
	key := []byte("12345678901234567890123456789012")
	account := sign.Account{ID: uuid.NewString(), Endpoint: "https://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.r2.cloudflarestorage.com", Bucket: "workspace-slices", PublicBaseURL: "https://pub-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.r2.dev", AccessKeyID: "bucket-access", SecretAccessKey: "bucket-secret"}
	err := db.InTx(ctx, pool, db.App(org), func(tx pgx.Tx) error {
		if err := mediarepo.StageSliceStorage(ctx, tx, org, owner, account, key); err != nil {
			return err
		}
		return mediarepo.ActivateSliceStorage(ctx, tx, org, owner, account.ID)
	})
	if err != nil {
		t.Fatal(err)
	}
	// The acting member is not an input to storage lookup: every member gets
	// the same current-workspace account, and a different workspace gets none.
	err = db.InTx(ctx, pool, db.App(org), func(tx pgx.Tx) error {
		row, err := mediarepo.ActiveSliceStorage(ctx, tx, org, key)
		if err != nil {
			return err
		}
		if row == nil || row.Account.ID != account.ID || row.OrgID != org {
			t.Fatal("shared workspace bucket was lost")
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	err = db.InTx(ctx, pool, db.App(otherOrg), func(tx pgx.Tx) error {
		row, err := mediarepo.ActiveSliceStorage(ctx, tx, org, key)
		if row != nil {
			t.Fatal("cross-workspace secret became visible")
		}
		return err
	})
	if err != nil {
		t.Fatal(err)
	}
	for _, actor := range []int64{member, owner} {
		err = db.InTx(ctx, pool, db.App(org), func(tx pgx.Tx) error {
			_, err := mediarepo.RequestSliceClear(ctx, tx, org, actor, account.ID)
			return err
		})
		if actor == member && err == nil {
			t.Fatal("member could request a bucket clear")
		}
		if actor == owner && err != nil {
			t.Fatal(err)
		}
	}
	other := account
	other.ID = uuid.NewString()
	other.Bucket = "member-attempt"
	err = db.InTx(ctx, pool, db.App(org), func(tx pgx.Tx) error { return mediarepo.StageSliceStorage(ctx, tx, org, member, other, key) })
	if err == nil {
		t.Fatal("member could stage workspace credentials")
	}
	// Even an owner of a different workspace cannot bind the same physical
	// bucket to that workspace. The unique constraint is enforced in PostgreSQL.
	other = account
	other.ID = uuid.NewString()
	err = db.InTx(ctx, pool, db.App(otherOrg), func(tx pgx.Tx) error {
		if err := mediarepo.StageSliceStorage(ctx, tx, otherOrg, member, other, key); err != nil {
			return err
		}
		return mediarepo.ActivateSliceStorage(ctx, tx, otherOrg, member, other.ID)
	})
	if err == nil {
		t.Fatal("one physical bucket was bound to two workspaces")
	}
}
