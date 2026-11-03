package integration

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"image"
	"image/color"
	"image/png"
	"io"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/xxww0098/podhub-go/internal/app"
	"github.com/xxww0098/podhub-go/internal/app/api"
	"github.com/xxww0098/podhub-go/internal/identity"
	identitycontract "github.com/xxww0098/podhub-go/internal/identity/contract"
	mediagen "github.com/xxww0098/podhub-go/internal/media/http/gen"
	"github.com/xxww0098/podhub-go/internal/platform/config"
	"github.com/xxww0098/podhub-go/internal/platform/db"
	sign "github.com/xxww0098/podhub-go/internal/platform/r2/sigv4"
)

type transitTestBucket struct {
	mu                    sync.Mutex
	bodies                map[string][]byte
	privateGET, publicGET int
	corruptPublic         bool
	onPublic              func() error
	hookErr               error
}

func (b *transitTestBucket) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	public := strings.HasPrefix(r.URL.Path, "/public/")
	key := strings.TrimPrefix(strings.TrimPrefix(r.URL.Path, "/public/"), "/transit/")
	if r.Method == http.MethodPut && !public {
		raw, err := io.ReadAll(io.LimitReader(r.Body, 20<<20))
		digest := sha256.Sum256(raw)
		if err != nil || r.Header.Get("Content-Type") != "image/png" || r.Header.Get("If-None-Match") != "*" || r.Header.Get("X-Amz-Checksum-Sha256") != base64.StdEncoding.EncodeToString(digest[:]) {
			http.Error(w, "invalid upload headers or bytes", http.StatusBadRequest)
			return
		}
		b.mu.Lock()
		defer b.mu.Unlock()
		if _, ok := b.bodies[key]; ok {
			w.WriteHeader(http.StatusPreconditionFailed)
			return
		}
		b.bodies[key] = raw
		w.WriteHeader(http.StatusOK)
		return
	}
	if r.Method != http.MethodGet {
		w.WriteHeader(http.StatusMethodNotAllowed)
		return
	}
	b.mu.Lock()
	raw, found := b.bodies[key]
	raw = bytes.Clone(raw)
	var hook func() error
	if public {
		b.publicGET++
		if b.corruptPublic && len(raw) > 0 {
			raw[len(raw)-1] ^= 1
		}
		hook, b.onPublic = b.onPublic, nil
	} else {
		b.privateGET++
	}
	b.mu.Unlock()
	if !found {
		w.WriteHeader(http.StatusNotFound)
		return
	}
	if hook != nil {
		if err := hook(); err != nil {
			b.mu.Lock()
			b.hookErr = err
			b.mu.Unlock()
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
	}
	w.Header().Set("Content-Type", "image/png")
	w.Header().Set("Content-Length", strconv.Itoa(len(raw)))
	_, _ = w.Write(raw)
}

func transitResponse[T any](t *testing.T, rec *httptest.ResponseRecorder) T {
	t.Helper()
	if rec.Code != http.StatusOK {
		t.Fatalf("response %d: %s", rec.Code, rec.Body.String())
	}
	var data T
	if err := json.Unmarshal(rec.Body.Bytes(), &data); err != nil {
		t.Fatal(err)
	}
	return data
}

func TestTransitMediaNormalAPI(t *testing.T) {
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
	if _, err := pool.Exec(ctx, `ALTER ROLE podhub_login_api PASSWORD 'transit-test-login'`); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PODHUB_ALLOW_SUPERUSER_DB", "")
	apiPool, err := db.Connect(ctx, config.Config{DatabaseURL: swapUser(dsn, "podhub_login_api", "transit-test-login")})
	if err != nil {
		t.Fatal(err)
	}
	defer apiPool.Close()
	var login string
	var privileged bool
	if err := apiPool.QueryRow(ctx, `SELECT current_user,rolsuper OR rolbypassrls FROM pg_roles WHERE rolname=current_user`).Scan(&login, &privileged); err != nil || login != "podhub_login_api" || privileged {
		t.Fatalf("API login %q privileged=%v err=%v", login, privileged, err)
	}
	t.Setenv("PODHUB_ALLOW_SUPERUSER_DB", "1")
	t.Setenv("CLOUD_COOKIE_SECURE", "0")
	t.Setenv("CLOUD_SELLER_CREDENTIAL_KEY", "parity-test-key")
	if _, err := pool.Exec(ctx, `INSERT INTO account_users(public_id,email,password_hash,role,name,target,supplier_id,plan,created_at,updated_at)
		VALUES('00000000-0000-4000-8000-000000009992','transit-owner@example.invalid','x','super_admin','Owner','/workspace','','free',clock_timestamp(),clock_timestamp());
		UPDATE platform_initialization SET owner_account_id=(SELECT id FROM account_users WHERE email='transit-owner@example.invalid'),initialized_at=clock_timestamp() WHERE singleton`); err != nil {
		t.Fatal(err)
	}
	registration := app.Handler(pool)
	plan := "transit-" + uuid.NewString()[:8]
	if _, err := pool.Exec(ctx, `INSERT INTO plans(key,name,s3_upload_bytes_monthly,created_at,updated_at) VALUES($1,'Transit test',104857600,clock_timestamp(),clock_timestamp())`, plan); err != nil {
		t.Fatal(err)
	}
	register := func(t *testing.T, name string) (cookie, workspace string, org, user int64) {
		t.Helper()
		email := "transit-" + name + "@example.invalid"
		rec := postJSON(t, registration, "/api/auth/register", `{"email":"`+email+`","password":"correct-horse","name":"Transit"}`, "transit-register-"+name, "")
		if rec.Code != http.StatusOK {
			t.Fatalf("register %d: %s", rec.Code, rec.Body.String())
		}
		if err := pool.QueryRow(ctx, `SELECT o.id,o.uuid::text,u.id FROM organizations o JOIN account_users u ON u.id=o.owner_user_id WHERE u.email=$1`, email).Scan(&org, &workspace, &user); err != nil {
			t.Fatal(err)
		}
		if _, err := pool.Exec(ctx, `UPDATE organizations SET plan=$2 WHERE id=$1`, org, plan); err != nil {
			t.Fatal(err)
		}
		return sessionCookie(rec), workspace, org, user
	}
	cookie, workspace, org, _ := register(t, "a")
	otherCookie, otherWorkspace, _, _ := register(t, "b")
	seedMatchingLease(t, ctx, pool, "recipe", "transit media integration")
	bucket := &transitTestBucket{bodies: map[string][]byte{}}
	storage := httptest.NewServer(bucket)
	defer storage.Close()
	account := sign.Account{ID: "transit-integration", Provider: sign.ProviderCloudflare, Endpoint: storage.URL, Bucket: "transit", PublicBaseURL: storage.URL + "/public", Region: "auto", ForcePathStyle: true, AccessKeyID: "test", SecretAccessKey: "test"}
	makeHandler := func(account sign.Account) http.Handler {
		access := identity.New(apiPool)
		router := chi.NewRouter()
		router.Use(identity.CSRF, access.Middleware)
		return api.HandlerFromMux(&api.Server{Pool: apiPool, Access: access, Media: func(context.Context, identitycontract.Principal) (*sign.Account, error) { return &account, nil }}, router)
	}
	handler := makeHandler(account)
	request := func(t *testing.T, handler http.Handler, path, cookie string, body any) *httptest.ResponseRecorder {
		t.Helper()
		raw, err := json.Marshal(body)
		if err != nil {
			t.Fatal(err)
		}
		return postJSON(t, handler, path, string(raw), "", cookie)
	}
	img := image.NewRGBA(image.Rect(0, 0, 8, 6))
	img.Set(3, 4, color.RGBA{R: 170, G: 60, B: 40, A: 255})
	var encoded bytes.Buffer
	if err := png.Encode(&encoded, img); err != nil {
		t.Fatal(err)
	}
	raw := encoded.Bytes()
	hash := sha256.Sum256(raw)
	digest := hex.EncodeToString(hash[:])
	checksum := "sha256"
	presignBody := func(workspace, batch string) mediagen.MediaObjectBatchPresignRequest {
		return mediagen.MediaObjectBatchPresignRequest{WorkspaceUuid: workspace, UploadBatch: &batch, StoreChecksum: &checksum, Objects: []mediagen.MediaObjectBatchPresignItem{{Digest: digest, Extension: "png", ByteLength: int64(len(raw))}}}
	}
	issue := func(t *testing.T, cookie, workspace string) string {
		t.Helper()
		data := transitResponse[mediagen.MediaUploadBatchData](t, request(t, handler, "/api/media/upload-batches", cookie, mediagen.MediaUploadBatchRequest{WorkspaceUuid: workspace}))
		if data.UploadBatch == "" || data.ExpiresAt == "" {
			t.Fatalf("missing batch identity: %+v", data)
		}
		return data.UploadBatch
	}
	grant := func(t *testing.T, cookie, workspace string) mediagen.MediaObjectPresignData {
		t.Helper()
		data := transitResponse[mediagen.MediaObjectBatchPresignData](t, request(t, handler, "/api/media/objects/presign-batch", cookie, presignBody(workspace, issue(t, cookie, workspace))))
		if len(data.Objects) != 1 || data.Objects[0].Upload == nil || data.Objects[0].UploadTicket == nil || data.Objects[0].UploadBatch == nil || data.Objects[0].Transport != mediagen.Direct {
			t.Fatalf("invalid direct grant: %+v", data)
		}
		if !strings.HasPrefix(data.Objects[0].Upload.Url, storage.URL+"/") || !strings.HasPrefix(data.Objects[0].PublicUrl, storage.URL+"/public/") {
			t.Fatal("grant did not use the configured local storage origins")
		}
		t.Cleanup(func() {
			if _, err := pool.Exec(ctx, `UPDATE media_object_leases SET retired_at=clock_timestamp() WHERE object_key=$1 AND retired_at IS NULL`, data.Objects[0].ObjectKey); err != nil {
				t.Error(err)
			}
		})
		return data.Objects[0]
	}
	upload := func(t *testing.T, target mediagen.MediaObjectPresignData) {
		t.Helper()
		req, err := http.NewRequestWithContext(ctx, http.MethodPut, target.Upload.Url, bytes.NewReader(raw))
		if err != nil {
			t.Fatal(err)
		}
		req.Header.Set("Content-Type", target.Upload.Headers.ContentType)
		req.Header.Set("If-None-Match", target.Upload.Headers.IfNoneMatch)
		if target.Upload.Headers.ChecksumSha256 == nil {
			t.Fatal("PUT checksum was not signed")
		}
		req.Header.Set("X-Amz-Checksum-Sha256", *target.Upload.Headers.ChecksumSha256)
		response, err := storage.Client().Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer response.Body.Close()
		if response.StatusCode != http.StatusOK {
			t.Fatalf("PUT status %d", response.StatusCode)
		}
	}
	completeBody := func(target mediagen.MediaObjectPresignData) mediagen.MediaObjectCompleteRequest {
		return mediagen.MediaObjectCompleteRequest{WorkspaceUuid: target.WorkspaceUuid, AccountId: target.AccountId, ObjectKey: target.ObjectKey, StorageRevision: target.StorageRevision, ByteLength: int64(len(raw)), UploadBatch: target.UploadBatch, UploadTicket: *target.UploadTicket}
	}
	completePath := "/api/media/objects/" + digest + "/png/complete"
	assertLease := func(t *testing.T, target mediagen.MediaObjectPresignData, state string) {
		t.Helper()
		var status, publicURL string
		var size int64
		var ready, verified bool
		var width, height int
		if err := pool.QueryRow(ctx, `SELECT verification_status,verified_byte_length,public_ready_at IS NOT NULL,verified_at IS NOT NULL,COALESCE(public_url,''),COALESCE(verified_width,0),COALESCE(verified_height,0)
			FROM media_object_leases WHERE workspace_uuid=$1::uuid AND object_key=$2`, target.WorkspaceUuid, target.ObjectKey).Scan(&status, &size, &ready, &verified, &publicURL, &width, &height); err != nil {
			t.Fatal(err)
		}
		if status != state || size != int64(len(raw)) || ready != (state == "verified") || verified != ready {
			t.Fatalf("lease state=%s bytes=%d ready=%v verified=%v", status, size, ready, verified)
		}
		if ready && (publicURL != target.PublicUrl || width != 8 || height != 6) {
			t.Fatalf("verified image url=%q dimensions=%dx%d", publicURL, width, height)
		}
	}
	assertError := func(t *testing.T, rec *httptest.ResponseRecorder, status int, code string) {
		t.Helper()
		var body mediagen.IntegrationConfigErrorResponse
		if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil || rec.Code != status || string(body.Code) != code {
			t.Fatalf("response %d: %s, expected %d %s", rec.Code, rec.Body.String(), status, code)
		}
	}

	t.Run("normal login reserves uploads verifies and replays", func(t *testing.T) {
		target := grant(t, cookie, workspace)
		assertLease(t, target, "pending")
		if _, err := pool.Exec(ctx, `UPDATE media_object_leases SET last_hit_at=clock_timestamp()-interval '2 hours' WHERE object_key=$1`, target.ObjectKey); err != nil {
			t.Fatal(err)
		}
		repeated := transitResponse[mediagen.MediaObjectBatchPresignData](t, request(t, handler, "/api/media/objects/presign-batch", cookie, presignBody(workspace, *target.UploadBatch)))
		if len(repeated.Objects) != 1 || repeated.Objects[0].ObjectKey != target.ObjectKey {
			t.Fatal("repeated presign changed its object key")
		}
		var recent bool
		if err := pool.QueryRow(ctx, `SELECT last_hit_at>clock_timestamp()-interval '1 minute' FROM media_object_leases WHERE object_key=$1`, target.ObjectKey).Scan(&recent); err != nil || !recent {
			t.Fatalf("repeated presign did not renew the upload fence: recent=%v err=%v", recent, err)
		}
		var count, used int64
		if err := pool.QueryRow(ctx, `SELECT count(*),sum(verified_byte_length)::bigint FROM media_object_leases WHERE org_id=$1`, org).Scan(&count, &used); err != nil || count != 1 || used != int64(len(raw)) {
			t.Fatalf("reservation count=%d bytes=%d err=%v", count, used, err)
		}
		upload(t, target)
		for i := range 2 {
			data := transitResponse[mediagen.MediaObjectCompleteData](t, request(t, handler, completePath, cookie, completeBody(target)))
			if data.Transport != mediagen.Ready || data.Deduplicated != (i == 1) || data.PublicUrl != target.PublicUrl || data.ObjectKey != target.ObjectKey {
				t.Fatalf("complete %d: %+v", i, data)
			}
		}
		assertLease(t, target, "verified")
		bucket.mu.Lock()
		privateReads, publicReads := bucket.privateGET, bucket.publicGET
		bucket.mu.Unlock()
		if privateReads != 2 || publicReads != 2 {
			t.Fatalf("private/public reads %d/%d", privateReads, publicReads)
		}
	})
	t.Run("verified slices reuse across batches without spending quota again", func(t *testing.T) {
		reuseCookie, reuseWorkspace, reuseOrg, _ := register(t, "reuse")
		target := grant(t, reuseCookie, reuseWorkspace)
		if _, err := pool.Exec(ctx, `UPDATE media_object_leases SET expires_at=clock_timestamp()+interval '1 minute' WHERE object_key=$1`, target.ObjectKey); err != nil {
			t.Fatal(err)
		}
		joined := transitResponse[mediagen.MediaObjectBatchPresignData](t, request(t, handler, "/api/media/objects/presign-batch", reuseCookie, presignBody(reuseWorkspace, issue(t, reuseCookie, reuseWorkspace))))
		if len(joined.Objects) != 1 || joined.Objects[0].Transport != mediagen.Direct || joined.Objects[0].ObjectKey != target.ObjectKey || joined.Objects[0].Upload == nil || *joined.Objects[0].UploadBatch != *target.UploadBatch {
			t.Fatalf("pending cross-batch upload was duplicated or treated as ready: %+v", joined)
		}
		upload(t, target)
		transitResponse[mediagen.MediaObjectCompleteData](t, request(t, handler, completePath, reuseCookie, completeBody(joined.Objects[0])))
		var confirmedWindow bool
		if err := pool.QueryRow(ctx, `SELECT expires_at>clock_timestamp()+interval '3 hours' FROM media_object_leases WHERE object_key=$1`, target.ObjectKey).Scan(&confirmedWindow); err != nil || !confirmedWindow {
			t.Fatalf("confirmed shared upload kept the short pending window: %v %v", confirmedWindow, err)
		}
		quotaPlan := "reuse-" + uuid.NewString()[:8]
		if _, err := pool.Exec(ctx, `INSERT INTO plans(key,name,s3_upload_bytes_monthly,created_at,updated_at) VALUES($1,'Reuse test',$2,clock_timestamp(),clock_timestamp())`, quotaPlan, len(raw)); err != nil {
			t.Fatal(err)
		}
		if _, err := pool.Exec(ctx, `UPDATE organizations SET plan=$2 WHERE id=$1`, reuseOrg, quotaPlan); err != nil {
			t.Fatal(err)
		}
		if _, err := pool.Exec(ctx, `UPDATE media_object_leases SET expires_at=clock_timestamp()-interval '1 minute',last_hit_at=clock_timestamp()-interval '1 hour' WHERE object_key=$1`, target.ObjectKey); err != nil {
			t.Fatal(err)
		}
		reused := transitResponse[mediagen.MediaObjectBatchPresignData](t, request(t, handler, "/api/media/objects/presign-batch", reuseCookie, presignBody(reuseWorkspace, issue(t, reuseCookie, reuseWorkspace))))
		if len(reused.Objects) != 1 || reused.Objects[0].Transport != mediagen.Ready || reused.Objects[0].ObjectKey != target.ObjectKey || reused.Objects[0].Upload != nil || reused.Objects[0].UploadTicket != nil {
			t.Fatalf("cross-batch reuse: %+v", reused)
		}
		var count, used int64
		var renewed bool
		if err := pool.QueryRow(ctx, `SELECT count(*),sum(verified_byte_length)::bigint,bool_and(expires_at>clock_timestamp()+interval '3 hours') FROM media_object_leases WHERE org_id=$1`, reuseOrg).Scan(&count, &used, &renewed); err != nil || count != 1 || used != int64(len(raw)) || !renewed {
			t.Fatalf("reuse reserved again or failed to protect the image: %d/%d renewed=%v err=%v", count, used, renewed, err)
		}
		foreign := transitResponse[mediagen.MediaObjectBatchPresignData](t, request(t, handler, "/api/media/objects/presign-batch", otherCookie, presignBody(otherWorkspace, issue(t, otherCookie, otherWorkspace))))
		if foreign.Objects[0].Transport != mediagen.Direct || foreign.Objects[0].ObjectKey == target.ObjectKey {
			t.Fatal("another workspace reused private storage authority")
		}
		wrong := presignBody(reuseWorkspace, issue(t, reuseCookie, reuseWorkspace))
		wrong.Objects[0].ByteLength++
		assertError(t, request(t, handler, "/api/media/objects/presign-batch", reuseCookie, wrong), 403, "FORBIDDEN")
	})
	t.Run("complete batch isolates missing siblings", func(t *testing.T) {
		present := grant(t, cookie, workspace)
		missingRequest := presignBody(workspace, issue(t, cookie, workspace))
		missingRequest.Objects[0].Digest = strings.Repeat("e", 64)
		missing := transitResponse[mediagen.MediaObjectBatchPresignData](t, request(t, handler, "/api/media/objects/presign-batch", cookie, missingRequest)).Objects[0]
		upload(t, present)
		body := mediagen.MediaObjectBatchCompleteRequest{WorkspaceUuid: workspace}
		for _, target := range []mediagen.MediaObjectPresignData{present, missing} {
			targetDigest := strings.TrimSuffix(target.ObjectKey[strings.LastIndex(target.ObjectKey, "/")+1:], ".png")
			body.Objects = append(body.Objects, mediagen.MediaObjectBatchCompleteItem{AccountId: target.AccountId, ObjectKey: target.ObjectKey, StorageRevision: target.StorageRevision, ByteLength: int64(len(raw)), UploadTicket: *target.UploadTicket, Digest: targetDigest, Extension: "png"})
		}
		data := transitResponse[mediagen.MediaObjectBatchCompleteData](t, request(t, handler, "/api/media/objects/complete-batch", cookie, body))
		if len(data.Objects) != 2 || data.Objects[0].Object == nil || data.Objects[0].Error != nil || data.Objects[0].Object.Transport != mediagen.Ready || data.Objects[1].Object != nil || data.Objects[1].Error == nil || data.Objects[1].Error.Status != 404 || data.Objects[1].Error.Code != "MEDIA_COMPLETE_MISSING" {
			t.Fatalf("batch result %+v", data)
		}
		assertLease(t, present, "verified")
		assertLease(t, missing, "pending")
	})
	t.Run("another tenant cannot confirm a reservation", func(t *testing.T) {
		target := grant(t, cookie, workspace)
		upload(t, target)
		body := completeBody(target)
		assertError(t, request(t, handler, completePath, otherCookie, body), 403, "FORBIDDEN")
		body.WorkspaceUuid = otherWorkspace
		assertError(t, request(t, handler, completePath, otherCookie, body), 409, "CONFLICT")
		assertLease(t, target, "pending")
	})
	t.Run("bucket and storage revision changes reject old grants", func(t *testing.T) {
		target := grant(t, cookie, workspace)
		upload(t, target)
		changed := account
		changed.Bucket = "different-transit"
		assertError(t, request(t, makeHandler(changed), completePath, cookie, completeBody(target)), 409, "CONFLICT")
		body := completeBody(target)
		body.StorageRevision++
		assertError(t, request(t, handler, completePath, cookie, body), 409, "CONFLICT")
		assertLease(t, target, "pending")
	})
	t.Run("corrupt public bytes remain pending", func(t *testing.T) {
		target := grant(t, cookie, workspace)
		upload(t, target)
		bucket.mu.Lock()
		bucket.corruptPublic = true
		bucket.mu.Unlock()
		defer func() { bucket.mu.Lock(); bucket.corruptPublic = false; bucket.mu.Unlock() }()
		assertError(t, request(t, handler, completePath, cookie, completeBody(target)), 409, "CONFLICT")
		assertLease(t, target, "pending")
	})
	t.Run("missing object returns retryable missing code", func(t *testing.T) {
		target := grant(t, cookie, workspace)
		assertError(t, request(t, handler, completePath, cookie, completeBody(target)), 404, "MEDIA_COMPLETE_MISSING")
		assertLease(t, target, "pending")
	})
	t.Run("pending authorization consumes quota once", func(t *testing.T) {
		limitedCookie, limitedWorkspace, limitedOrg, _ := register(t, "quota")
		quotaPlan := "quota-" + uuid.NewString()[:8]
		if _, err := pool.Exec(ctx, `INSERT INTO plans(key,name,s3_upload_bytes_monthly,created_at,updated_at) VALUES($1,'Quota test',$2,clock_timestamp(),clock_timestamp())`, quotaPlan, len(raw)); err != nil {
			t.Fatal(err)
		}
		if _, err := pool.Exec(ctx, `UPDATE organizations SET plan=$2 WHERE id=$1`, limitedOrg, quotaPlan); err != nil {
			t.Fatal(err)
		}
		target := grant(t, limitedCookie, limitedWorkspace)
		transitResponse[mediagen.MediaObjectBatchPresignData](t, request(t, handler, "/api/media/objects/presign-batch", limitedCookie, presignBody(limitedWorkspace, *target.UploadBatch)))
		joined := transitResponse[mediagen.MediaObjectBatchPresignData](t, request(t, handler, "/api/media/objects/presign-batch", limitedCookie, presignBody(limitedWorkspace, issue(t, limitedCookie, limitedWorkspace))))
		if joined.Objects[0].Transport != mediagen.Direct || joined.Objects[0].ObjectKey != target.ObjectKey {
			t.Fatal("pending reuse consumed a second reservation")
		}
		other := presignBody(limitedWorkspace, issue(t, limitedCookie, limitedWorkspace))
		other.Objects[0].Digest = strings.Repeat("f", 64)
		assertError(t, request(t, handler, "/api/media/objects/presign-batch", limitedCookie, other), 403, "FORBIDDEN")
		var count, used int64
		if err := pool.QueryRow(ctx, `SELECT count(*),sum(verified_byte_length)::bigint FROM media_object_leases WHERE org_id=$1`, limitedOrg).Scan(&count, &used); err != nil || count != 1 || used != int64(len(raw)) {
			t.Fatalf("quota reservation count=%d bytes=%d err=%v", count, used, err)
		}
		assertLease(t, target, "pending")
	})
	for _, revoke := range []string{"session", "membership"} {
		t.Run(revoke+" revoked during public read cannot commit", func(t *testing.T) {
			revokedCookie, revokedWorkspace, revokedOrg, revokedUser := register(t, revoke)
			target := grant(t, revokedCookie, revokedWorkspace)
			upload(t, target)
			bucket.mu.Lock()
			bucket.onPublic = func() error {
				if revoke == "session" {
					_, err := pool.Exec(ctx, `DELETE FROM account_sessions WHERE user_id=$1`, revokedUser)
					return err
				}
				_, err := pool.Exec(ctx, `DELETE FROM organization_members WHERE org_id=$1 AND user_id=$2`, revokedOrg, revokedUser)
				return err
			}
			bucket.mu.Unlock()
			rec := request(t, handler, completePath, revokedCookie, completeBody(target))
			bucket.mu.Lock()
			hookErr := bucket.hookErr
			bucket.mu.Unlock()
			if hookErr != nil {
				t.Fatalf("revoke %s fixture: %v", revoke, hookErr)
			}
			if rec.Code != http.StatusUnauthorized && rec.Code != http.StatusForbidden {
				t.Fatalf("revoked %s response %d: %s", revoke, rec.Code, rec.Body.String())
			}
			assertLease(t, target, "pending")
		})
	}
	var persisted int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM storage_objects WHERE bucket='transit' OR object_key LIKE $1`, "%/"+workspace+"/%").Scan(&persisted); err != nil || persisted != 0 {
		t.Fatalf("transit leaked into persistent storage registry: %d err=%v", persisted, err)
	}
}
