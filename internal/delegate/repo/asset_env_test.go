package delegaterepo

import (
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
)

func TestCommitAssetWithoutIntegrationSnapshot(t *testing.T) {
	f := newAuthorityFixture(t)
	f.exec(t, `DELETE FROM platform_integration_config`)
	bindingID := uuid.NewString()
	f.exec(t, `INSERT INTO delegate_bindings
		(binding_id,org_id,store_id,offer_id,source_id,active,created_by,created_at_ms,updated_at_ms)
		VALUES ($1::uuid,$2,$3::uuid,'env-storage-offer',$4,true,$5,1,1)`,
		bindingID, f.org, f.store, f.source, f.user)
	in := AssetIdentity{
		BindingID: bindingID, StoreID: f.store, Key: "env-only/original.png",
		SHA: strings.Repeat("a", 64), Mime: "image/png", FileName: "original.png", Bytes: 11,
	}
	var calls []string
	asset, err := f.repo.CommitAsset(f.ctx, f.org, f.user, true, in, false, time.Now().UnixMilli(),
		func() error { calls = append(calls, "reload"); return nil },
		func() error { calls = append(calls, "reverify"); return nil })
	if err != nil || asset.AssetID == "" || !asset.Verified {
		t.Fatalf("commit without integration snapshot: asset=%+v err=%v", asset, err)
	}
	if strings.Join(calls, ",") != "reload,reverify" {
		t.Fatalf("confirmation checks=%v", calls)
	}
	var snapshots, persisted int
	if err := f.pool.QueryRow(f.ctx, `SELECT
		(SELECT count(*) FROM platform_integration_config),
		(SELECT count(*) FROM delegate_assets
		 WHERE asset_id=$1::uuid AND org_id=$2 AND binding_id=$3::uuid
		   AND object_key=$4 AND sha256=$5 AND bytes=$6 AND verified_at_ms IS NOT NULL)`,
		asset.AssetID, f.org, bindingID, in.Key, in.SHA, in.Bytes).Scan(&snapshots, &persisted); err != nil {
		t.Fatal(err)
	}
	if snapshots != 0 || persisted != 1 {
		t.Fatalf("snapshots=%d persisted assets=%d", snapshots, persisted)
	}
}
