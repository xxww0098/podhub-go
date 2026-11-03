package submit

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/xxww0098/podhub-go/internal/listing/submit/domain"
	media "github.com/xxww0098/podhub-go/internal/media/contract"
	"github.com/xxww0098/podhub-go/internal/media/domain/objectkey"
	tenant "github.com/xxww0098/podhub-go/internal/platform/db/tenantx"
)

func TestSliceExpiredOutcomeIsNotDispatched(t *testing.T) {
	out := sliceExpiredOutcome()
	if out.IntentError != "MEDIA_LEASE_UNAVAILABLE" || out.Edge != domain.RejectQueued || out.Requests != 0 || out.IntentState != domain.Rejected {
		t.Fatalf("unexpected expired-slice outcome: %+v", out)
	}
}

func TestSliceReceiptsStopAfterClear(t *testing.T) {
	pool, ctx := draftParityDB(t)
	org, user := seedDraftOrg(t, ctx, pool, 987619)
	otherOrg, otherUser := seedDraftOrg(t, ctx, pool, 987620)
	account := uuid.NewString()
	t.Cleanup(func() {
		_, _ = pool.Exec(context.Background(), `DELETE FROM media_object_leases WHERE org_id=$1`, org)
		_, _ = pool.Exec(context.Background(), `DELETE FROM workspace_slice_storage WHERE id=$1::uuid`, account)
		purgeDraft(context.Background(), pool, org, user)
		purgeDraft(context.Background(), pool, otherOrg, otherUser)
	})
	var workspace string
	if err := pool.QueryRow(ctx, `SELECT uuid::text FROM organizations WHERE id=$1`, org).Scan(&workspace); err != nil {
		t.Fatal(err)
	}
	_, err := pool.Exec(ctx, `INSERT INTO workspace_slice_storage(id,org_id,created_by,endpoint,bucket,public_base_url,access_key_hint,secret_nonce,secret_ciphertext,clear_at_minute)
		VALUES($1::uuid,$2,$3,'https://example.invalid','test','https://example.invalid','test','x','x',NULL)`, account, org, user)
	if err != nil {
		t.Fatal(err)
	}
	prefix, _ := media.SlicePrefix(account)
	now := time.Now()
	batch := fmt.Sprintf("%d.%s", now.Add(-24*time.Hour).UnixMilli(), uuid.NewString())
	key, err := objectkey.ComposeBatchedKey(prefix, workspace, strings.Repeat("a", 64), "png", batch)
	if err != nil {
		t.Fatal(err)
	}
	public := "https://example.invalid/" + key
	_, err = pool.Exec(ctx, `INSERT INTO media_object_leases(workspace_uuid,batch_id,content_hash,org_id,object_key,media_account_id,first_seen_at,last_hit_at,expires_at,verification_status,verified_at,public_ready_at,public_url,storage_revision)
		VALUES($1::uuid,$2,$3,$4,$5,$6,clock_timestamp(),clock_timestamp(),clock_timestamp()+interval '4 hours','verified',clock_timestamp(),clock_timestamp(),$7,1)`, workspace, objectkey.BatchIdentity(key), strings.Repeat("a", 64), org, key, account, public)
	if err != nil {
		t.Fatal(err)
	}
	checkAs := func(actorOrg int64, image string) bool {
		tx, err := tenant.BeginApp(ctx, pool.Begin, actorOrg)
		if err != nil {
			t.Fatal(err)
		}
		defer tx.Rollback(ctx)
		current, err := sliceReceiptsCurrent(ctx, tx, actorOrg, []string{image})
		if err != nil {
			t.Fatal(err)
		}
		return current
	}
	check := func() bool { return checkAs(org, public) }
	checkDispatch := func(actorOrg int64, image string) bool {
		body, err := json.Marshal(map[string]any{"items": []any{map[string]any{"images": []string{image}, "primary_image": image}}})
		if err != nil {
			t.Fatal(err)
		}
		tx, err := tenant.BeginApp(ctx, pool.Begin, actorOrg)
		if err != nil {
			t.Fatal(err)
		}
		defer tx.Rollback(ctx)
		current, err := sliceImportsCurrentTx(ctx, tx, actorOrg, body)
		if err != nil {
			t.Fatal(err)
		}
		return current
	}
	if !check() {
		t.Fatal("manual mode refused a verified slice across the previous fixed boundary")
	}
	if !checkDispatch(org, public) || checkDispatch(otherOrg, public) {
		t.Fatal("dispatch did not enforce the verified slice workspace")
	}
	if checkAs(otherOrg, public) {
		t.Fatal("another workspace accepted the verified slice")
	}
	if checkAs(org, strings.Replace(public, "example.invalid", "other.invalid", 1)) {
		t.Fatal("a different public host reused the slice identity")
	}
	if checkDispatch(org, strings.Replace(public, "example.invalid", "other.invalid", 1)) {
		t.Fatal("dispatch accepted a different public host")
	}
	if _, err := pool.Exec(ctx, `UPDATE workspace_slice_storage SET clear_fence_at=clock_timestamp() WHERE id=$1::uuid`, account); err != nil {
		t.Fatal(err)
	}
	if !check() {
		t.Fatal("automatic cleanup invalidated a protected slice")
	}
	if !checkDispatch(org, public) {
		t.Fatal("automatic cleanup blocked a pending dispatch")
	}
	if _, err := pool.Exec(ctx, `UPDATE workspace_slice_storage SET clear_fence_at=NULL WHERE id=$1::uuid`, account); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO workspace_slice_clear_requests(id,org_id,requested_by,storage_id) VALUES($1::uuid,$2,$3,$4::uuid)`, uuid.NewString(), org, user, account); err != nil {
		t.Fatal(err)
	}
	if check() {
		t.Fatal("slice accepted after a manual clear was requested")
	}
	if _, err := pool.Exec(ctx, `UPDATE media_object_leases SET retired_at=clock_timestamp() WHERE object_key=$1`, key); err != nil {
		t.Fatal(err)
	}
	if check() {
		t.Fatal("retired slice accepted")
	}
}
