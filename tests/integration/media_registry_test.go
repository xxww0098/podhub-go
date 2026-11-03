package integration

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/xxww0098/podhub-go/internal/media/contract"
	"github.com/xxww0098/podhub-go/internal/media/domain/storageregistry"
	mediarepo "github.com/xxww0098/podhub-go/internal/media/repo"
	"github.com/xxww0098/podhub-go/internal/media/service/registry"
	"github.com/xxww0098/podhub-go/internal/platform/db/tenantx"
)

var mediaRegistryAccount = registry.Account{
	Endpoint: "https://registry-test.r2.cloudflarestorage.com", Bucket: "registry-test-assets",
	PublicBaseURL: "https://pub-0123456789abcdef0123456789abcdef.r2.dev",
}

type mediaRegistryBuckets struct{}

func (mediaRegistryBuckets) Bucket(_ context.Context, role contract.Role) (registry.Account, error) {
	if role != contract.RoleAssets {
		return registry.Account{}, registry.ErrUnavailable
	}
	return mediaRegistryAccount, nil
}

func mediaRegistryUpload(org, user int64, content string) storageregistry.Upload {
	digest := sha256.Sum256([]byte(content))
	identity, _ := (contract.Config{Endpoint: mediaRegistryAccount.Endpoint, Bucket: mediaRegistryAccount.Bucket}).Identity()
	hexDigest := hex.EncodeToString(digest[:])
	return storageregistry.Upload{
		ActorID: user, OrgID: org, PurposeKind: "listing_image", PurposeID: fmt.Sprint(org),
		Bucket: "assets", BucketIdentity: identity,
		ObjectKey: fmt.Sprintf("orgs/%d/images/%s.jpg", org, hexDigest), DedupeScope: fmt.Sprintf("org:%d:image", org),
		SHA256Hex: hexDigest, ByteLength: int64(len(content)), ContentType: "image/jpeg", Extension: "jpg",
		State: storageregistry.UploadPending, ExpiresAt: time.Now().Add(time.Hour),
	}
}

func mediaRegistryProof(upload storageregistry.Upload) registry.Object {
	return registry.Object{Exists: true, ByteLength: upload.ByteLength, ContentType: upload.ContentType, ReadbackSHA256Hex: upload.SHA256Hex}
}

func TestMediaConfirmIsIdempotentForJoinedUpload(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
	defer cancel()
	pool := migratedPool(t, ctx)
	org := insertMediaOrg(t, ctx, pool, 96701, "registry-idempotent@example.invalid", "Registry", uuid.NewString())
	store := mediarepo.New(pool, tenantx.BeginApp)
	upload := mediaRegistryUpload(org, 96701, "shared content")
	id, err := store.BeginUpload(ctx, upload)
	if err != nil {
		t.Fatal(err)
	}
	joined, err := store.BeginUpload(ctx, upload)
	if err != nil || joined != id {
		t.Fatalf("same content did not join upload: %s %s %v", id, joined, err)
	}
	service := registry.Service{Store: store, Buckets: mediaRegistryBuckets{}}
	request := registry.ConfirmRequest{ActorID: upload.ActorID, OrgID: org, UploadID: id}
	entered := make(chan struct{}, 2)
	release := make(chan struct{})
	type result struct {
		view registry.PresignResult
		err  error
	}
	results := make(chan result, 2)
	for range 2 {
		go func() {
			view, err := service.Confirm(ctx, request, func(ctx context.Context, _ registry.UploadRow) (registry.Object, error) {
				entered <- struct{}{}
				select {
				case <-release:
					return mediaRegistryProof(upload), nil
				case <-ctx.Done():
					return registry.Object{}, ctx.Err()
				}
			})
			results <- result{view, err}
		}()
	}
	for range 2 {
		select {
		case <-entered:
		case <-ctx.Done():
			t.Fatal("confirmation did not reach proof barrier")
		}
	}
	close(release)
	first, second := <-results, <-results
	if first.err != nil || second.err != nil || first.view.ObjectID == "" || first.view.ObjectID != second.view.ObjectID {
		t.Fatalf("joined confirmation diverged: first=%+v second=%+v", first, second)
	}
	replay, err := service.Confirm(ctx, request, func(context.Context, registry.UploadRow) (registry.Object, error) {
		return mediaRegistryProof(upload), nil
	})
	if err != nil || replay.ObjectID != first.view.ObjectID || !replay.Reuse {
		t.Fatalf("confirmed replay: %+v %v", replay, err)
	}
	var count int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM storage_objects WHERE bucket_identity=$1 AND object_key=$2`, upload.BucketIdentity, upload.ObjectKey).Scan(&count); err != nil || count != 1 {
		t.Fatalf("registry objects=%d err=%v", count, err)
	}
}

func TestMediaConfirmRevalidatesExpiryAfterProof(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
	defer cancel()
	pool := migratedPool(t, ctx)
	org := insertMediaOrg(t, ctx, pool, 96702, "registry-expiry@example.invalid", "Registry", uuid.NewString())
	store := mediarepo.New(pool, tenantx.BeginApp)
	upload := mediaRegistryUpload(org, 96702, "expiry during proof")
	id, err := store.BeginUpload(ctx, upload)
	if err != nil {
		t.Fatal(err)
	}
	_, err = (registry.Service{Store: store, Buckets: mediaRegistryBuckets{}}).Confirm(ctx, registry.ConfirmRequest{ActorID: upload.ActorID, OrgID: org, UploadID: id}, func(ctx context.Context, _ registry.UploadRow) (registry.Object, error) {
		_, err := pool.Exec(ctx, `UPDATE storage_uploads SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1::uuid`, id)
		return mediaRegistryProof(upload), err
	})
	if !errors.Is(err, storageregistry.ErrExpired) {
		t.Fatalf("expired upload was confirmed: %v", err)
	}
	assertMediaUploadPending(t, ctx, pool, id)
	var count int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM storage_objects WHERE bucket_identity=$1 AND object_key=$2`, upload.BucketIdentity, upload.ObjectKey).Scan(&count); err != nil || count != 0 {
		t.Fatalf("expired confirmation registered %d objects: %v", count, err)
	}
}

func TestMediaConfirmRechecksConcurrentObject(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
	defer cancel()
	pool := migratedPool(t, ctx)
	org := insertMediaOrg(t, ctx, pool, 96703, "registry-race@example.invalid", "Registry", uuid.NewString())
	store := mediarepo.New(pool, tenantx.BeginApp)
	for _, tc := range []struct {
		name  string
		reuse bool
		state string
		size  int64
		want  error
	}{
		{"reuse became deleting", true, "deleting", 0, storageregistry.ErrNotLive},
		{"reuse became deleted", true, "deleted", 0, storageregistry.ErrNotLive},
		{"insert winner became deleting", false, "deleting", 0, storageregistry.ErrNotLive},
		{"insert winner has different metadata", false, "live", 1, storageregistry.ErrConflict},
		{"insert winner matches", false, "live", 0, nil},
	} {
		t.Run(tc.name, func(t *testing.T) {
			upload := mediaRegistryUpload(org, 96703, tc.name)
			id, err := store.BeginUpload(ctx, upload)
			if err != nil {
				t.Fatal(err)
			}
			claim := storageregistry.Claim{
				Bucket: upload.Bucket, BucketIdentity: upload.BucketIdentity, ObjectKey: upload.ObjectKey, DedupeScope: upload.DedupeScope,
				SHA256Hex: upload.SHA256Hex, ByteLength: upload.ByteLength, ContentType: upload.ContentType, Extension: upload.Extension,
			}
			objectID := uuid.NewString()
			// This object is inserted or retired after the service's lookup.
			if _, err := pool.Exec(ctx, `INSERT INTO storage_objects(id,bucket,bucket_identity,object_key,dedupe_scope,owner_org_id,sha256,byte_length,content_type,extension,state,retired_at)
				VALUES($1::uuid,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,CASE WHEN $11='deleted' THEN clock_timestamp() ELSE NULL END)`,
				objectID, claim.Bucket, claim.BucketIdentity, claim.ObjectKey, claim.DedupeScope, org, contract.DigestBytes(claim.SHA256Hex), claim.ByteLength+tc.size, claim.ContentType, claim.Extension, tc.state); err != nil {
				t.Fatal(err)
			}
			confirmed, err := store.Confirm(ctx, id, storageregistry.ConfirmDecision{Reuse: tc.reuse, ObjectID: objectID, Claim: claim})
			if !errors.Is(err, tc.want) {
				t.Fatalf("stale decision accepted: err=%v want=%v", err, tc.want)
			}
			if tc.want != nil {
				assertMediaUploadPending(t, ctx, pool, id)
			} else if confirmed != objectID {
				t.Fatalf("wrong concurrent object: got=%s want=%s", confirmed, objectID)
			}
		})
	}
}

func assertMediaUploadPending(t *testing.T, ctx context.Context, pool *pgxpool.Pool, id string) {
	t.Helper()
	var state string
	var object *string
	if err := pool.QueryRow(ctx, `SELECT state,object_id::text FROM storage_uploads WHERE id=$1::uuid`, id).Scan(&state, &object); err != nil {
		t.Fatal(err)
	}
	if state != "pending" || object != nil {
		t.Fatalf("rejected confirmation wrote state=%s object=%v", state, object)
	}
}
