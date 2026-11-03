package integration

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"encoding/xml"
	"fmt"
	"net/http"
	"net/http/httptest"
	"sort"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	httpapi "github.com/xxww0098/podhub-go/internal/app/api"
	access "github.com/xxww0098/podhub-go/internal/identity/contract"
	"github.com/xxww0098/podhub-go/internal/media/domain/objectkey"
	sign "github.com/xxww0098/podhub-go/internal/platform/r2/sigv4"
)

func TestWorkspaceSliceFolderDeleteBatchesAndFences(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	pool := migratedPool(t, ctx)
	owner, org, workspace := securityOrg(t, ctx, pool, "folder-delete")
	insertMember(t, ctx, pool, org, owner, "owner", 1)
	tokenHash := fmt.Sprintf("%x", sha256.Sum256([]byte(workspace)))
	hxExec(t, ctx, pool, `UPDATE account_profiles SET active_org_id=$2 WHERE user_id=$1`, owner, org)
	hxExec(t, ctx, pool, `INSERT INTO account_sessions(token_hash,user_id,expires_at) VALUES($2,$1,clock_timestamp()+interval '1 hour')`, owner, tokenHash)
	seedMatchingLease(t, ctx, pool, "recipe", "folder delete")
	account := sign.Account{ID: uuid.NewString(), Provider: sign.ProviderCloudflare, Bucket: "folder-test", Region: "auto", ForcePathStyle: true, AccessKeyID: "test-access", SecretAccessKey: "test-secret"}
	account.KeyPrefix = "podhub-slices/" + account.ID + "/"
	var mu sync.Mutex
	objects := map[string]bool{}
	failedKey := ""
	deleteCalls := 0
	type keyXML struct {
		Key string `xml:"Key"`
	}
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		defer mu.Unlock()
		if r.URL.Query().Get("X-Amz-Signature") == "" {
			t.Error("unsigned storage request")
		}
		switch r.Method {
		case http.MethodGet:
			prefix := r.URL.Query().Get("prefix")
			if !strings.HasPrefix(prefix, account.KeyPrefix+"uploads/") || r.URL.Query().Get("delimiter") != "" {
				t.Error("folder listing escaped the selected namespace")
			}
			var keys []string
			for key := range objects {
				if strings.HasPrefix(key, prefix) {
					keys = append(keys, key)
				}
			}
			sort.Strings(keys)
			limit, _ := strconv.Atoi(r.URL.Query().Get("max-keys"))
			if limit < 1 || limit > 100 {
				t.Error("folder delete exceeded its listing batch")
			}
			page := struct {
				XMLName   xml.Name `xml:"ListBucketResult"`
				Contents  []keyXML `xml:"Contents"`
				Truncated bool     `xml:"IsTruncated"`
				Next      string   `xml:"NextContinuationToken,omitempty"`
			}{}
			if len(keys) > limit {
				page.Truncated, page.Next = true, "more"
				keys = keys[:limit]
			}
			for _, key := range keys {
				page.Contents = append(page.Contents, keyXML{key})
			}
			_ = xml.NewEncoder(w).Encode(page)
		case http.MethodPost:
			deleteCalls++
			var request struct {
				Objects []keyXML `xml:"Object"`
			}
			if xml.NewDecoder(r.Body).Decode(&request) != nil || len(request.Objects) < 1 || len(request.Objects) > 100 {
				t.Error("invalid batch delete")
			}
			receipt := struct {
				XMLName xml.Name `xml:"DeleteResult"`
				Deleted []keyXML `xml:"Deleted"`
				Errors  []keyXML `xml:"Error"`
			}{}
			for _, object := range request.Objects {
				var retired bool
				if err := pool.QueryRow(ctx, `SELECT retired_at IS NOT NULL FROM media_object_leases WHERE org_id=$1 AND media_account_id=$2 AND object_key=$3`, org, account.ID, object.Key).Scan(&retired); err != nil || !retired {
					t.Errorf("object was deleted before its lease retired: %v", err)
				}
				if object.Key == failedKey {
					receipt.Errors = append(receipt.Errors, object)
					continue
				}
				delete(objects, object.Key)
				receipt.Deleted = append(receipt.Deleted, object)
			}
			_ = xml.NewEncoder(w).Encode(receipt)
		default:
			t.Errorf("unexpected storage method %s", r.Method)
		}
	}))
	defer upstream.Close()
	account.Endpoint, account.PublicBaseURL = upstream.URL, upstream.URL
	principal := &access.Principal{UserID: owner, OrgID: org, WorkspaceRole: "owner", PlatformRole: "user", TokenHash: tokenHash}
	s := &httpapi.Server{Pool: pool, Access: access.FixedResolver{Principal: principal}, SliceDeleteAllowed: true}
	s.Media = func(context.Context, access.Principal) (*sign.Account, error) { return &account, nil }
	s.Workspace = func(context.Context, int64) (string, error) { return workspace, nil }
	handler := httpapi.HandlerFromMux(s, nil)
	now := time.Now()
	batch := fmt.Sprintf("%d.%s", now.Add(-2*time.Hour).UnixMilli(), uuid.NewString())
	seed := func(digest int, batch string) string {
		key, err := objectkey.ComposeBatchedKey(account.KeyPrefix, workspace, fmt.Sprintf("%064x", digest), "png", batch)
		if err != nil {
			t.Fatal(err)
		}
		mu.Lock()
		objects[key] = true
		mu.Unlock()
		hxExec(t, ctx, pool, `INSERT INTO media_object_leases(workspace_uuid,batch_id,content_hash,org_id,object_key,media_account_id,first_seen_at,last_hit_at,expires_at,verification_status,verified_byte_length,storage_revision)
		VALUES($1::uuid,$2,$3,$4,$5,$6,clock_timestamp()-interval '2 hours',clock_timestamp()-interval '2 hours',clock_timestamp()+interval '1 hour','pending',1,1)`, workspace, batch, fmt.Sprintf("%064x", digest), org, key, account.ID)
		return key
	}
	prefix := account.KeyPrefix + "uploads/" + now.Add(-2*time.Hour).UTC().Format("2006-01-02") + "/"
	for i := 1; i <= 205; i++ {
		seed(i, batch)
	}
	mu.Lock()
	objects[account.KeyPrefix+"uploads/untouched-sibling/keep.png"] = true
	objects["podhub-slices/another-storage/uploads/keep.png"] = true
	mu.Unlock()
	call := func(prefix string) *httptest.ResponseRecorder {
		body, _ := json.Marshal(map[string]string{"prefix": prefix})
		r := httptest.NewRequest(http.MethodPost, "/api/workspace/slice-storage/objects/delete", strings.NewReader(string(body)))
		r.Header.Set("Content-Type", "application/json")
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, r)
		return w
	}
	type result struct {
		Deleted int      `json:"deleted"`
		Failed  []string `json:"failed_keys"`
		More    bool     `json:"has_more"`
	}
	countDeletes := func() int { mu.Lock(); defer mu.Unlock(); return deleteCalls }
	total, batches := 0, 0
	for {
		w := call(prefix)
		var out result
		if w.Code != 200 || json.Unmarshal(w.Body.Bytes(), &out) != nil {
			t.Fatalf("delete: %d %s", w.Code, w.Body.String())
		}
		total += out.Deleted
		batches++
		if len(out.Failed) != 0 || out.More && out.Deleted != 100 {
			t.Fatalf("bad batch acknowledgement: %+v", out)
		}
		if !out.More {
			break
		}
		if batches > 3 {
			t.Fatal("folder delete did not finish")
		}
	}
	if total != 205 || batches != 3 || countDeletes() != 3 {
		t.Fatalf("deleted=%d batches=%d calls=%d", total, batches, countDeletes())
	}
	mu.Lock()
	remaining := len(objects)
	mu.Unlock()
	if remaining != 2 {
		t.Fatal("folder delete touched a sibling or foreign namespace")
	}
	if w := call(prefix); w.Code != 200 || !strings.Contains(w.Body.String(), `"deleted":0`) {
		t.Fatalf("empty retry: %d %s", w.Code, w.Body.String())
	}
	for _, bad := range []string{account.KeyPrefix + "uploads/", "podhub-slices/another-storage/uploads/date/", prefix + "../", strings.TrimSuffix(prefix, "/"), prefix + "/"} {
		if w := call(bad); w.Code != 400 {
			t.Fatalf("unsafe folder accepted: %d", w.Code)
		}
	}
	// A fresh grant for an old batch is still active, even before its PUT appears.
	pending := seed(300, batch)
	mu.Lock()
	delete(objects, pending)
	mu.Unlock()
	hxExec(t, ctx, pool, `UPDATE media_object_leases SET last_hit_at=clock_timestamp() WHERE object_key=$1`, pending)
	before := countDeletes()
	if w := call(prefix); w.Code != 409 || !strings.Contains(w.Body.String(), "WORKSPACE_STORAGE_UPLOAD_ACTIVE") {
		t.Fatalf("pending upload in an empty folder was ignored: %d %s", w.Code, w.Body.String())
	}
	mu.Lock()
	objects[pending] = true
	mu.Unlock()
	if w := call(prefix); w.Code != 409 || countDeletes() != before {
		t.Fatalf("renewed old upload was ignored: %d %s", w.Code, w.Body.String())
	}
	keyBody, _ := json.Marshal(map[string][]string{"keys": {pending}})
	keyRequest := httptest.NewRequest(http.MethodPost, "/api/workspace/slice-storage/objects/delete", strings.NewReader(string(keyBody)))
	keyRequest.Header.Set("Content-Type", "application/json")
	keyResponse := httptest.NewRecorder()
	handler.ServeHTTP(keyResponse, keyRequest)
	if keyResponse.Code != 409 || countDeletes() != before {
		t.Fatalf("renewed upload was ignored for exact-key deletion: %d %s", keyResponse.Code, keyResponse.Body.String())
	}
	hxExec(t, ctx, pool, `UPDATE media_object_leases SET last_hit_at=clock_timestamp()-interval '2 hours' WHERE object_key=$1`, pending)
	if w := call(prefix); w.Code != 200 {
		t.Fatalf("expired upload grant could not be deleted: %d %s", w.Code, w.Body.String())
	}
	concurrent := seed(299, batch)
	tx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(ctx)
	if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended('transit-upload-quota:' || $1::bigint::text, 0))`, org); err != nil {
		t.Fatal(err)
	}
	if _, err := tx.Exec(ctx, `UPDATE media_object_leases SET last_hit_at=clock_timestamp() WHERE object_key=$1`, concurrent); err != nil {
		t.Fatal(err)
	}
	resultCh := make(chan *httptest.ResponseRecorder, 1)
	go func() { resultCh <- call(prefix) }()
	deadline := time.Now().Add(time.Second)
	for {
		var waiting bool
		if err := pool.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM pg_locks WHERE locktype='advisory' AND NOT granted AND database=(SELECT oid FROM pg_database WHERE datname=current_database()))`).Scan(&waiting); err != nil {
			t.Fatal(err)
		}
		if waiting {
			break
		}
		select {
		case w := <-resultCh:
			t.Fatalf("delete did not wait for the upload reservation: %d %s", w.Code, w.Body.String())
		default:
		}
		if time.Now().After(deadline) {
			t.Fatal("delete did not reach the upload reservation lock")
		}
		time.Sleep(10 * time.Millisecond)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	if w := <-resultCh; w.Code != 409 || !strings.Contains(w.Body.String(), "WORKSPACE_STORAGE_UPLOAD_ACTIVE") {
		t.Fatalf("concurrent upload grant was ignored: %d %s", w.Code, w.Body.String())
	}
	hxExec(t, ctx, pool, `UPDATE media_object_leases SET last_hit_at=clock_timestamp()-interval '2 hours' WHERE object_key=$1`, concurrent)
	if w := call(prefix); w.Code != 200 {
		t.Fatalf("expired concurrent upload could not be deleted: %d %s", w.Code, w.Body.String())
	}
	partialBatch := fmt.Sprintf("%d.%s", now.Add(-2*time.Hour).UnixMilli(), uuid.NewString())
	one := seed(301, partialBatch)
	seed(302, partialBatch)
	mu.Lock()
	failedKey = one
	mu.Unlock()
	w := call(prefix)
	var partial result
	if w.Code != 200 || json.Unmarshal(w.Body.Bytes(), &partial) != nil || partial.Deleted != 1 || len(partial.Failed) != 1 || !partial.More {
		t.Fatalf("partial delete was hidden: %d %s", w.Code, w.Body.String())
	}
	mu.Lock()
	failedKey = ""
	mu.Unlock()
	if w := call(prefix); w.Code != 200 {
		t.Fatalf("partial retry: %d %s", w.Code, w.Body.String())
	}
	recentBatch := fmt.Sprintf("%d.%s", now.UnixMilli(), uuid.NewString())
	seed(401, recentBatch)
	recentPrefix := account.KeyPrefix + "uploads/" + now.UTC().Format("2006-01-02") + "/"
	before = countDeletes()
	if w := call(recentPrefix); w.Code != 409 || !strings.Contains(w.Body.String(), "WORKSPACE_STORAGE_UPLOAD_ACTIVE") {
		t.Fatalf("active upload not protected: %d %s", w.Code, w.Body.String())
	}
	principal.WorkspaceRole = "member"
	if w := call(recentPrefix); w.Code != 403 {
		t.Fatalf("member could delete folder: %d", w.Code)
	}
	principal.WorkspaceRole = "owner"
	s.SliceDeleteAllowed = false
	if w := call(recentPrefix); w.Code != 503 {
		t.Fatalf("deletion switch was ignored: %d", w.Code)
	}
	if countDeletes() != before {
		t.Fatal("refused request reached the delete API")
	}
}
