package integration

import (
	"context"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/xxww0098/podhub-go/internal/media/domain/objectkey"
	mediarepo "github.com/xxww0098/podhub-go/internal/media/repo"
	"github.com/xxww0098/podhub-go/internal/platform/db/tenantx"
)

func TestSliceCleanupWaitsForEveryFetchAndRetryWindow(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
	defer cancel()
	pool := migratedPool(t, ctx)
	_, org, workspace := securityOrg(t, ctx, pool, "slice-auto")
	_, otherOrg, _ := securityOrg(t, ctx, pool, "slice-auto-other")
	store, card, storage := uuid.NewString(), uuid.NewString(), uuid.NewString()
	hxExec(t, ctx, pool, `UPDATE organizations SET plan='lite' WHERE id=$1`, org)
	hxExec(t, ctx, pool, `INSERT INTO organization_stores(org_id,uuid,create_order,name) VALUES($1,$2::uuid,1,'Slice test')`, org, store)
	hxExec(t, ctx, pool, `INSERT INTO listing_cards(id,org_id,payload) VALUES($1::uuid,$2,'{}')`, card, org)
	keys := []string{}
	lease := func() string {
		t.Helper()
		digest := fmt.Sprintf("%064x", len(keys)+1)
		batch := fmt.Sprintf("%d.%s", time.Now().Add(-72*time.Hour).UnixMilli(), uuid.NewString())
		key, err := objectkey.ComposeBatchedKey("podhub-slices/"+storage+"/", workspace, digest, "png", batch)
		if err != nil {
			t.Fatal(err)
		}
		hxExec(t, ctx, pool, `INSERT INTO media_object_leases(workspace_uuid,batch_id,content_hash,org_id,object_key,media_account_id,
 first_seen_at,last_hit_at,expires_at,verification_status,verified_at,public_ready_at,public_url,verified_byte_length,slice_gc_tracked)
 VALUES($1::uuid,$2,$3,$4,$5,$6,clock_timestamp()-interval '3 days',clock_timestamp()-interval '1 day',clock_timestamp()-interval '1 hour',
 'verified',clock_timestamp()-interval '3 days',clock_timestamp()-interval '3 days',$7,12,true)`, workspace, objectkey.BatchIdentity(key), digest, org, key, storage, "https://slices.example/"+key)
		keys = append(keys, key)
		return key
	}
	use := func(key string, fetched *time.Time) (string, error) {
		row, intent := uuid.NewString(), uuid.NewString()
		if _, err := pool.Exec(ctx, `INSERT INTO listing_rows(id,org_id,card_id,store_id,submission_state) VALUES($1::uuid,$2,$3::uuid,$4::uuid,'accepted')`, row, org, card, store); err != nil {
			return "", err
		}
		_, err := pool.Exec(ctx, `INSERT INTO submission_intents(id,org_id,store_id,listing_row_id,row_revision,client_operation_id,request_hash,state,offer_id,card_id,
 slice_image_urls,slice_images_fetched_at) VALUES($1::uuid,$2,$3::uuid,$4::uuid,1,$1::text,'hash','accepted',$1::text,$5::uuid,$6::text[],$7)`, intent, org, store, row, card, []string{"https://slices.example/" + key}, fetched)
		return row, err
	}
	old, recent := time.Now().Add(-48*time.Hour), time.Now().Add(-23*time.Hour)
	confirmed := lease()
	if _, err := use(confirmed, &old); err != nil {
		t.Fatal(err)
	}
	window := lease()
	if _, err := use(window, &recent); err != nil {
		t.Fatal(err)
	}
	unknown := lease()
	if _, err := use(unknown, nil); err != nil {
		t.Fatal(err)
	}
	shared := lease()
	if _, err := use(shared, &old); err != nil {
		t.Fatal(err)
	}
	if _, err := use(shared, nil); err != nil {
		t.Fatal(err)
	}
	pending := lease()
	if _, err := use(pending, &old); err != nil {
		t.Fatal(err)
	}
	row := uuid.NewString()
	hxExec(t, ctx, pool, `INSERT INTO listing_rows(id,org_id,card_id,store_id,submission_state,payload) VALUES($1::uuid,$2,$3::uuid,$4::uuid,'queued',jsonb_build_object('media',jsonb_build_object('images',jsonb_build_array(jsonb_build_object('object_key',$5::text)))))`, row, org, card, store, pending)
	renewed := lease()
	if _, err := use(renewed, &old); err != nil {
		t.Fatal(err)
	}
	hxExec(t, ctx, pool, `UPDATE media_object_leases SET expires_at=clock_timestamp()+interval '4 hours' WHERE object_key=$1`, renewed)
	unsubmitted := lease()
	legacy := lease()
	if _, err := use(legacy, &old); err != nil {
		t.Fatal(err)
	}
	hxExec(t, ctx, pool, `UPDATE media_object_leases SET slice_gc_tracked=false WHERE object_key=$1`, legacy)
	busy := lease()
	if _, err := use(busy, &old); err != nil {
		t.Fatal(err)
	}
	guard, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer guard.Rollback(ctx)
	if _, err := guard.Exec(ctx, `SELECT public.lock_media_reference_identity($1::uuid,$2)`, storage, fmt.Sprintf("%064x", len(keys))); err != nil {
		t.Fatal(err)
	}
	retire := func(actorOrg int64) []string {
		t.Helper()
		tx, err := tenantx.BeginWorker(ctx, pool.Begin)
		if err != nil {
			t.Fatal(err)
		}
		defer tx.Rollback(ctx)
		if err := mediarepo.RetireFetchedSlices(ctx, tx, actorOrg, storage, time.Now(), keys); err != nil {
			t.Fatal(err)
		}
		got, err := mediarepo.RetiredSliceKeys(ctx, tx, actorOrg, storage, keys)
		if err != nil {
			t.Fatal(err)
		}
		if err := tx.Commit(ctx); err != nil {
			t.Fatal(err)
		}
		return got
	}
	if got := retire(otherOrg); len(got) != 0 {
		t.Fatalf("another workspace retired slices: %v", got)
	}
	got := retire(org)
	if len(got) != 1 || got[0] != confirmed {
		t.Fatalf("unsafe retirement: %v", got)
	}
	for _, key := range []string{window, unknown, shared, pending, renewed, unsubmitted, legacy, busy} {
		var retired bool
		if err := pool.QueryRow(ctx, `SELECT retired_at IS NOT NULL FROM media_object_leases WHERE object_key=$1`, key).Scan(&retired); err != nil || retired {
			t.Fatalf("protected slice retired: %s %v", key, err)
		}
	}
	if err := guard.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	got = retire(org)
	if len(got) != 2 {
		t.Fatalf("released reference fence did not retry: %v", got)
	}
	if _, err := use(confirmed, &old); err == nil || !strings.Contains(err.Error(), "unavailable") {
		t.Fatalf("retired image acquired a new frozen reference: %v", err)
	}
	// Retired identities remain durable; a second pass only returns the same keys.
	if got := retire(org); len(got) != 2 {
		t.Fatalf("retirement replay: %v", got)
	}
}
