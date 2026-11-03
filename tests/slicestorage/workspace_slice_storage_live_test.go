package slicestorage_test

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"image"
	"image/png"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/xxww0098/podhub-go/internal/app"
	"github.com/xxww0098/podhub-go/internal/app/worker"
	media "github.com/xxww0098/podhub-go/internal/media/contract"
	mediagen "github.com/xxww0098/podhub-go/internal/media/http/gen"
	"github.com/xxww0098/podhub-go/internal/media/jobs/slicepurge"
	mediarepo "github.com/xxww0098/podhub-go/internal/media/repo"
	"github.com/xxww0098/podhub-go/internal/platform/config"
	"github.com/xxww0098/podhub-go/internal/platform/db"
	"github.com/xxww0098/podhub-go/internal/platform/db/tenantx"
	"github.com/xxww0098/podhub-go/internal/platform/httpx"
	"github.com/xxww0098/podhub-go/internal/platform/r2"
	sign "github.com/xxww0098/podhub-go/internal/platform/r2/sigv4"
	"github.com/xxww0098/podhub-go/internal/platform/seal"
)

func TestLiveWorkspaceSliceSettingsAndClear(t *testing.T) {
	if os.Getenv("PODHUB_TEST_WORKSPACE_R2_LIVE") != "1" {
		t.Skip("requires dedicated R2 test bucket")
	}
	if !strings.Contains(os.Getenv("R2_TRANSIT_BUCKET"), "-test-") {
		t.Fatal("requires test bucket")
	}
	if time.Since(media.LastClearBoundary(time.Now())) < 25*time.Minute {
		t.Skip("test needs an upload older than the manual clear boundary")
	}
	if err := httpx.ConfigureDNS(os.Getenv("CLOUD_DNS_SERVER")); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()
	dsn := securityDSN(t, ctx)
	t.Setenv("PODHUB_ALLOW_SUPERUSER_DB", "1")
	pool, err := db.Connect(ctx, config.Config{DatabaseURL: dsn})
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	if err := db.Migrate(ctx, pool); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `ALTER ROLE podhub_login_api PASSWORD 'slice-test-login'; ALTER ROLE podhub_login_ai_media_worker PASSWORD 'slice-test-worker'`); err != nil {
		t.Fatal(err)
	}
	apiPool, err := db.Connect(ctx, config.Config{DatabaseURL: swapUser(dsn, "podhub_login_api", "slice-test-login")})
	if err != nil {
		t.Fatal(err)
	}
	defer apiPool.Close()
	workerPool, err := db.Connect(ctx, config.Config{DatabaseURL: swapUser(dsn, "podhub_login_ai_media_worker", "slice-test-worker")})
	if err != nil {
		t.Fatal(err)
	}
	defer workerPool.Close()
	t.Setenv("CLOUD_COOKIE_SECURE", "0")
	t.Setenv("CLOUD_MEDIA_GC_DELETE", "1")
	t.Setenv("CLOUD_INTEGRATION_CONFIG_KEY", strings.Repeat("test-key-", 4))
	if _, err := pool.Exec(ctx, `INSERT INTO account_users(public_id,email,password_hash,role,name,target,supplier_id,plan,created_at,updated_at)
		VALUES('00000000-0000-4000-8000-000000009992','slice-admin@example.invalid','x','super_admin','Admin','/workspace','','free',clock_timestamp(),clock_timestamp());
		UPDATE platform_initialization SET owner_account_id=(SELECT id FROM account_users WHERE email='slice-admin@example.invalid'),initialized_at=clock_timestamp() WHERE singleton`); err != nil {
		t.Fatal(err)
	}
	registration := app.Handler(pool)
	register := func(name string) (string, string, int64) {
		rec := postJSON(t, registration, "/api/auth/register", `{"email":"slice-`+name+`@example.invalid","password":"correct-horse","name":"Slice"}`, "register-"+name, "")
		if rec.Code != http.StatusOK {
			t.Fatalf("register status %d", rec.Code)
		}
		var workspace string
		var user int64
		if err := pool.QueryRow(ctx, `SELECT o.uuid::text,u.id FROM organizations o JOIN account_users u ON u.id=o.owner_user_id WHERE u.email=$1`, "slice-"+name+"@example.invalid").Scan(&workspace, &user); err != nil {
			t.Fatal(err)
		}
		return sessionCookie(rec), workspace, user
	}
	cookie, workspace, userID := register("a")
	other, otherWorkspace, _ := register("b")
	seedMatchingLease(t, ctx, pool, "recipe", "user slice storage")
	handler := app.Handler(apiPool)
	request := func(method, path, cookie string, body any) *httptest.ResponseRecorder {
		raw, err := json.Marshal(body)
		if err != nil {
			t.Fatal(err)
		}
		req := httptest.NewRequest(method, path, bytes.NewReader(raw))
		req.Header.Set("Content-Type", "application/json")
		if cookie != "" {
			req.Header.Set("Cookie", cookie)
		}
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, req)
		return rec
	}
	in := map[string]string{"endpoint": os.Getenv("R2_TRANSIT_ENDPOINT"), "bucket": os.Getenv("R2_TRANSIT_BUCKET"), "public_base_url": os.Getenv("R2_TRANSIT_PUBLIC_BASE_URL"), "access_key_id": os.Getenv("R2_TRANSIT_ACCESS_KEY_ID"), "secret_access_key": os.Getenv("R2_TRANSIT_SECRET_ACCESS_KEY")}
	if rec := request(http.MethodGet, "/api/workspace/slice-storage", cookie, nil); rec.Code != 200 || !strings.Contains(rec.Body.String(), `"configured":false`) {
		t.Fatalf("initial configuration status %d", rec.Code)
	}
	if rec := request(http.MethodPost, "/api/media/upload-batches", other, map[string]string{"workspace_uuid": otherWorkspace}); rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("unconfigured user fell back to another bucket: %d", rec.Code)
	}
	var orgID int64
	if err := pool.QueryRow(ctx, `SELECT id FROM organizations WHERE uuid=$1::uuid`, workspace).Scan(&orgID); err != nil {
		t.Fatal(err)
	}
	fixtureAccount := sign.Account{ID: uuid.NewString(), Endpoint: in["endpoint"], Bucket: in["bucket"], PublicBaseURL: in["public_base_url"], AccessKeyID: in["access_key_id"], SecretAccessKey: in["secret_access_key"]}
	if err := db.InTx(ctx, pool, db.App(orgID), func(tx pgx.Tx) error {
		if err := mediarepo.StageSliceStorage(ctx, tx, orgID, userID, fixtureAccount, seal.DeriveKEK(strings.Repeat("test-key-", 4))); err != nil {
			return err
		}
		return mediarepo.ActivateSliceStorage(ctx, tx, orgID, userID, fixtureAccount.ID)
	}); err != nil {
		t.Fatal(err)
	}
	if rec := request(http.MethodGet, "/api/workspace/slice-storage", other, nil); rec.Code != 200 || !strings.Contains(rec.Body.String(), `"configured":false`) {
		t.Fatalf("other user status %d", rec.Code)
	}
	var id, rawStored string
	if err := pool.QueryRow(ctx, `SELECT id::text,encode(secret_ciphertext,'hex') FROM workspace_slice_storage WHERE created_by=$1 AND retired_at IS NULL`, userID).Scan(&id, &rawStored); err != nil {
		t.Fatal(err)
	}
	storedBytes, err := hex.DecodeString(rawStored)
	if err != nil || bytes.Contains(storedBytes, []byte(in["secret_access_key"])) || bytes.Contains(storedBytes, []byte(in["access_key_id"])) {
		t.Fatal("secret stored as plaintext")
	}
	tx, err := tenantx.BeginApp(ctx, apiPool.Begin, 0)
	if err != nil {
		t.Fatal(err)
	}
	var visible int
	if err := tx.QueryRow(ctx, `SELECT count(*) FROM workspace_slice_storage WHERE id=$1::uuid`, id).Scan(&visible); err != nil || visible != 0 {
		t.Fatal("RLS allowed another user to inspect the credentials")
	}
	_ = tx.Rollback(ctx)
	if rec := request(http.MethodGet, "/api/workspace/slice-storage", cookie, nil); rec.Code != 200 || strings.Contains(rec.Body.String(), in["secret_access_key"]) || strings.Contains(rec.Body.String(), in["access_key_id"]) {
		t.Fatalf("unsafe settings response %d", rec.Code)
	}
	prefix, _ := media.SlicePrefix(id)
	account := sign.Account{ID: id, Provider: sign.ProviderCloudflare, Endpoint: in["endpoint"], Bucket: in["bucket"], PublicBaseURL: in["public_base_url"], Region: "auto", ForcePathStyle: true, AccessKeyID: in["access_key_id"], SecretAccessKey: in["secret_access_key"], KeyPrefix: prefix}
	var pngData bytes.Buffer
	if err := png.Encode(&pngData, image.NewRGBA(image.Rect(0, 0, 3, 3))); err != nil {
		t.Fatal(err)
	}
	digest := sha256.Sum256(pngData.Bytes())
	hash := hex.EncodeToString(digest[:])
	batch := fmt.Sprintf("%d.%s", time.Now().Add(-20*time.Minute).UnixMilli(), uuid.NewString())
	checksum := "sha256"
	body := mediagen.MediaObjectBatchPresignRequest{WorkspaceUuid: workspace, UploadBatch: &batch, StoreChecksum: &checksum, Objects: []mediagen.MediaObjectBatchPresignItem{{Digest: hash, Extension: "png", ByteLength: int64(pngData.Len())}}}
	data := transitResponse[mediagen.MediaObjectBatchPresignData](t, request(http.MethodPost, "/api/media/objects/presign-batch", cookie, body))
	if len(data.Objects) != 1 {
		t.Fatal("missing presigned slice")
	}
	target := data.Objects[0]
	defer func() {
		cleanup, stop := context.WithTimeout(context.Background(), 30*time.Second)
		defer stop()
		_, _ = (slicepurge.AccountOrigin{Account: account, Before: time.Now().Add(time.Minute)}).Delete(cleanup, []string{target.ObjectKey})
	}()
	resp, err := r2.ExchangeAccount(ctx, account, r2.Request{Method: http.MethodPut, URL: target.Upload.Url, Headers: map[string]string{"Content-Type": target.Upload.Headers.ContentType, "If-None-Match": target.Upload.Headers.IfNoneMatch, "X-Amz-Checksum-Sha256": *target.Upload.Headers.ChecksumSha256}, Body: pngData.Bytes(), StrictRead: true})
	if err != nil || resp.Status != 200 {
		t.Fatalf("slice PUT status %d", resp.Status)
	}
	complete := mediagen.MediaObjectCompleteRequest{WorkspaceUuid: workspace, AccountId: target.AccountId, ObjectKey: target.ObjectKey, StorageRevision: target.StorageRevision, ByteLength: int64(pngData.Len()), UploadBatch: target.UploadBatch, UploadTicket: *target.UploadTicket}
	if rec := request(http.MethodPost, "/api/media/objects/"+hash+"/png/complete", cookie, complete); rec.Code != 200 {
		t.Fatalf("complete status %d %s", rec.Code, rec.Body.String())
	}
	if rec := request(http.MethodPost, "/api/workspace/slice-storage/clear", cookie, nil); rec.Code != http.StatusAccepted {
		t.Fatalf("clear status %d %s", rec.Code, rec.Body.String())
	}
	if _, err := pool.Exec(ctx, `UPDATE workspace_slice_clear_requests SET requested_at=clock_timestamp()-interval '17 minutes' WHERE requested_by=$1`, userID); err != nil {
		t.Fatal(err)
	}
	worker.RunWorkspaceSliceClears(ctx, workerPool, seal.DeriveKEK(strings.Repeat("test-key-", 4)))
	var finished, retired bool
	if err := pool.QueryRow(ctx, `SELECT finished_at IS NOT NULL FROM workspace_slice_clear_requests WHERE requested_by=$1`, userID).Scan(&finished); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, `SELECT retired_at IS NOT NULL FROM media_object_leases WHERE object_key=$1`, target.ObjectKey).Scan(&retired); err != nil {
		t.Fatal(err)
	}
	if !finished || !retired {
		t.Fatalf("clear finished=%v retired=%v", finished, retired)
	}
	if rec := request(http.MethodPost, "/api/media/objects/presign-batch", cookie, body); rec.Code != http.StatusBadRequest {
		t.Fatalf("cleared batch was accepted: %d", rec.Code)
	}
	if rec := request(http.MethodGet, "/api/workspace/slice-storage", cookie, nil); rec.Code != 200 || !strings.Contains(rec.Body.String(), `"clear_status":"completed"`) {
		t.Fatalf("clear status readback %d", rec.Code)
	}
	privateURL, _, _ := sign.PresignURL(account, http.MethodGet, target.ObjectKey, "", time.Now(), time.Minute, nil, nil)
	resp, err = r2.ExchangeAccount(ctx, account, r2.Request{Method: http.MethodGet, URL: privateURL, StrictRead: true})
	if err != nil || resp.Status != http.StatusNotFound {
		t.Fatalf("clear readback status %d", resp.Status)
	}
}
