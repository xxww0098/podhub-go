package api

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"image"
	"image/png"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	media "github.com/xxww0098/podhub-go/internal/media/contract"
	"github.com/xxww0098/podhub-go/internal/media/domain/objectkey"
	sign "github.com/xxww0098/podhub-go/internal/platform/r2/sigv4"
)

const (
	verifyTestBucket = "slice-bucket"
	verifyTestOrigin = "https://app.example.test"
)

var verifyFailureTexts = map[string]string{
	"R2_CORS_FAILED":          "CORS 验证失败：存储桶需允许本站来源的 GET、PUT 请求",
	"R2_WRITE_FAILED":         "测试对象写入失败，请重试；若持续失败，请检查 S3 API 地址、存储桶名称和 API 令牌权限",
	"R2_PUBLIC_ACCESS_FAILED": "公开访问域名无法读取测试对象：请确认已开启公开访问且域名指向此存储桶",
	"R2_PERMISSION_FAILED":    "API 令牌权限不足：需要对象读取、列举和删除权限",
	"R2_VERIFICATION_FAILED":  "R2 验证失败，请检查密钥的读写删除权限、公开访问和 CORS 配置",
}

// fakeR2 is a loopback S3 endpoint. Each nil hook keeps the passing behavior of
// one verification step; a test replaces exactly the hook it wants to break.
// Private object URLs live under /<bucket>/, public ones directly under /.
type fakeR2 struct {
	mu      sync.Mutex
	key     string
	body    []byte
	deleted bool

	preflight       http.HandlerFunc
	put             http.HandlerFunc
	privateGet      http.HandlerFunc // before delete
	publicOriginGet http.HandlerFunc // public GET carrying an Origin header
	publicGet       http.HandlerFunc // public GET without an Origin header (readback)
	list            http.HandlerFunc
	del             http.HandlerFunc
	finalGet        http.HandlerFunc // any object GET after delete
}

func (f *fakeR2) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	f.mu.Lock()
	defer f.mu.Unlock()
	pick := func(hook http.HandlerFunc, fallback http.HandlerFunc) {
		if hook != nil {
			hook(w, r)
			return
		}
		fallback(w, r)
	}
	switch {
	case r.Method == http.MethodOptions:
		pick(f.preflight, f.defaultPreflight)
	case r.Method == http.MethodPut:
		pick(f.put, f.defaultPut)
	case r.Method == http.MethodPost && r.URL.Query().Has("delete"):
		pick(f.del, f.defaultDelete)
	case r.Method == http.MethodGet && r.URL.Query().Has("list-type"):
		pick(f.list, f.defaultList)
	case r.Method == http.MethodGet && f.deleted:
		pick(f.finalGet, func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusNotFound) })
	case r.Method == http.MethodGet && strings.HasPrefix(r.URL.Path, "/"+verifyTestBucket+"/"):
		pick(f.privateGet, f.defaultObject)
	case r.Method == http.MethodGet && r.Header.Get("Origin") != "":
		pick(f.publicOriginGet, f.defaultPublicOrigin)
	case r.Method == http.MethodGet:
		pick(f.publicGet, f.defaultObject)
	default:
		w.WriteHeader(http.StatusMethodNotAllowed)
	}
}

func (f *fakeR2) defaultPreflight(w http.ResponseWriter, _ *http.Request) {
	w.Header().Set("Access-Control-Allow-Origin", verifyTestOrigin)
	w.Header().Set("Access-Control-Allow-Methods", "GET, PUT")
	w.Header().Set("Access-Control-Allow-Headers", "content-type, if-none-match, x-amz-checksum-sha256")
	w.WriteHeader(http.StatusNoContent)
}

func (f *fakeR2) defaultPut(w http.ResponseWriter, r *http.Request) {
	body, _ := io.ReadAll(r.Body)
	f.key = strings.TrimPrefix(r.URL.Path, "/"+verifyTestBucket+"/")
	f.body = body
	w.WriteHeader(http.StatusOK)
}

func (f *fakeR2) defaultObject(w http.ResponseWriter, _ *http.Request) {
	w.Header().Set("Content-Type", "image/png")
	_, _ = w.Write(f.body)
}

func (f *fakeR2) defaultPublicOrigin(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Access-Control-Allow-Origin", r.Header.Get("Origin"))
	f.defaultObject(w, r)
}

func (f *fakeR2) defaultList(w http.ResponseWriter, _ *http.Request) {
	fmt.Fprintf(w, `<ListBucketResult><IsTruncated>false</IsTruncated><Contents><Key>%s</Key></Contents></ListBucketResult>`, f.key)
}

func (f *fakeR2) defaultDelete(w http.ResponseWriter, _ *http.Request) {
	f.deleted = true
	fmt.Fprintf(w, `<DeleteResult><Deleted><Key>%s</Key></Deleted></DeleteResult>`, f.key)
}

func status(code int) http.HandlerFunc {
	return func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(code) }
}

func dropConnection(w http.ResponseWriter, _ *http.Request) {
	conn, _, err := w.(http.Hijacker).Hijack()
	if err == nil {
		_ = conn.Close()
	}
}

func TestVerifySliceStorageFailureCodes(t *testing.T) {
	cases := []struct {
		name        string
		origin      string
		publicBase  string // empty means the fake server itself
		script      func(f *fakeR2)
		wantCode    string // empty means verification passes
		wantCleanup bool
	}{
		{name: "all checks pass with browser origin", origin: verifyTestOrigin},
		{name: "all checks pass without browser origin"},

		{name: "preflight rejected", origin: verifyTestOrigin, wantCode: "R2_CORS_FAILED",
			script: func(f *fakeR2) { f.preflight = status(http.StatusForbidden) }},
		{name: "preflight transport failure", origin: verifyTestOrigin, wantCode: "R2_CORS_FAILED",
			script: func(f *fakeR2) { f.preflight = dropConnection }},
		{name: "preflight allows another origin", origin: verifyTestOrigin, wantCode: "R2_CORS_FAILED",
			script: func(f *fakeR2) {
				f.preflight = func(w http.ResponseWriter, r *http.Request) {
					w.Header().Set("Access-Control-Allow-Origin", "https://other.example.test")
					w.Header().Set("Access-Control-Allow-Methods", "PUT")
					w.Header().Set("Access-Control-Allow-Headers", "*")
					w.WriteHeader(http.StatusNoContent)
				}
			}},
		{name: "preflight lacks PUT", origin: verifyTestOrigin, wantCode: "R2_CORS_FAILED",
			script: func(f *fakeR2) {
				f.preflight = func(w http.ResponseWriter, r *http.Request) {
					w.Header().Set("Access-Control-Allow-Origin", "*")
					w.Header().Set("Access-Control-Allow-Methods", "GET")
					w.Header().Set("Access-Control-Allow-Headers", "*")
					w.WriteHeader(http.StatusNoContent)
				}
			}},
		{name: "preflight lacks request headers", origin: verifyTestOrigin, wantCode: "R2_CORS_FAILED",
			script: func(f *fakeR2) {
				f.preflight = func(w http.ResponseWriter, r *http.Request) {
					w.Header().Set("Access-Control-Allow-Origin", "*")
					w.Header().Set("Access-Control-Allow-Methods", "PUT")
					w.Header().Set("Access-Control-Allow-Headers", "content-type")
					w.WriteHeader(http.StatusNoContent)
				}
			}},

		{name: "put forbidden", wantCode: "R2_WRITE_FAILED", script: func(f *fakeR2) { f.put = status(http.StatusForbidden) }},
		{name: "put transport failure", wantCode: "R2_WRITE_FAILED", wantCleanup: true,
			script: func(f *fakeR2) { f.put = dropConnection }},
		{name: "put server error", wantCode: "R2_WRITE_FAILED", wantCleanup: true,
			script: func(f *fakeR2) { f.put = status(http.StatusInternalServerError) }},
		// R2 rejects the preflight of an unknown bucket exactly like a missing CORS
		// policy, so a failed write must win or a typo'd bucket points at the CORS step.
		{name: "put and preflight both refused blames the write", origin: verifyTestOrigin, wantCode: "R2_WRITE_FAILED",
			script: func(f *fakeR2) { f.put = status(http.StatusForbidden); f.preflight = status(http.StatusForbidden) }},

		// Readback runs private first, then public (no Origin header).
		{name: "readback private forbidden", wantCode: "R2_PERMISSION_FAILED",
			script: func(f *fakeR2) { f.privateGet = status(http.StatusForbidden) }},
		{name: "readback private missing", wantCode: "R2_PERMISSION_FAILED",
			script: func(f *fakeR2) { f.privateGet = status(http.StatusNotFound) }},
		{name: "readback public host unreachable", origin: verifyTestOrigin, publicBase: "https://cdn.example.invalid",
			wantCode: "R2_PUBLIC_ACCESS_FAILED"},
		{name: "readback public missing", wantCode: "R2_PUBLIC_ACCESS_FAILED",
			script: func(f *fakeR2) { f.publicGet = status(http.StatusNotFound) }},
		{name: "readback public wrong body", wantCode: "R2_PUBLIC_ACCESS_FAILED",
			script: func(f *fakeR2) {
				f.publicGet = func(w http.ResponseWriter, _ *http.Request) {
					w.Header().Set("Content-Type", "image/png")
					_, _ = w.Write([]byte("not the uploaded bytes"))
				}
			}},

		{name: "public read forbidden", origin: verifyTestOrigin, wantCode: "R2_PUBLIC_ACCESS_FAILED",
			script: func(f *fakeR2) { f.publicOriginGet = status(http.StatusForbidden) }},
		{name: "public read transport failure", origin: verifyTestOrigin, wantCode: "R2_PUBLIC_ACCESS_FAILED",
			script: func(f *fakeR2) { f.publicOriginGet = dropConnection }},
		{name: "public read wrong body", origin: verifyTestOrigin, wantCode: "R2_PUBLIC_ACCESS_FAILED",
			script: func(f *fakeR2) {
				f.publicOriginGet = func(w http.ResponseWriter, r *http.Request) {
					w.Header().Set("Access-Control-Allow-Origin", "*")
					_, _ = w.Write([]byte("not the uploaded bytes"))
				}
			}},
		{name: "public read without allow-origin", origin: verifyTestOrigin, wantCode: "R2_CORS_FAILED",
			script: func(f *fakeR2) { f.publicOriginGet = f.defaultObject }},
		{name: "public read with other allow-origin", origin: verifyTestOrigin, wantCode: "R2_CORS_FAILED",
			script: func(f *fakeR2) {
				f.publicOriginGet = func(w http.ResponseWriter, r *http.Request) {
					w.Header().Set("Access-Control-Allow-Origin", "https://other.example.test")
					f.defaultObject(w, r)
				}
			}},
		{name: "public read with wildcard allow-origin passes", origin: verifyTestOrigin,
			script: func(f *fakeR2) {
				f.publicOriginGet = func(w http.ResponseWriter, r *http.Request) {
					w.Header().Set("Access-Control-Allow-Origin", "*")
					f.defaultObject(w, r)
				}
			}},

		{name: "list empty", wantCode: "R2_PERMISSION_FAILED",
			script: func(f *fakeR2) {
				f.list = func(w http.ResponseWriter, _ *http.Request) {
					fmt.Fprint(w, `<ListBucketResult><IsTruncated>false</IsTruncated></ListBucketResult>`)
				}
			}},
		{name: "list forbidden", wantCode: "R2_PERMISSION_FAILED", script: func(f *fakeR2) { f.list = status(http.StatusForbidden) }},

		// Delete never works here, so the deferred cleanup cannot remove the
		// object either and the handler must keep the staged candidate.
		{name: "delete forbidden", wantCode: "R2_PERMISSION_FAILED", wantCleanup: true,
			script: func(f *fakeR2) { f.del = status(http.StatusForbidden) }},
		{name: "delete receipt reports error", wantCode: "R2_PERMISSION_FAILED", wantCleanup: true,
			script: func(f *fakeR2) {
				f.del = func(w http.ResponseWriter, _ *http.Request) {
					fmt.Fprintf(w, `<DeleteResult><Error><Key>%s</Key></Error></DeleteResult>`, f.key)
				}
			}},

		// The object is gone after the first delete, so the deferred cleanup
		// succeeds and nothing is left for the handler to clean.
		{name: "object still readable after delete", wantCode: "R2_VERIFICATION_FAILED",
			script: func(f *fakeR2) { f.finalGet = f.defaultObject }},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			fake := &fakeR2{}
			if tc.script != nil {
				tc.script(fake)
			}
			server := httptest.NewServer(fake)
			defer server.Close()
			id := uuid.NewString()
			prefix, err := media.SlicePrefix(id)
			if err != nil {
				t.Fatal(err)
			}
			publicBase := tc.publicBase
			if publicBase == "" {
				publicBase = server.URL
			}
			account := sign.Account{ID: id, Provider: sign.ProviderCloudflare, Endpoint: server.URL, Bucket: verifyTestBucket,
				PublicBaseURL: publicBase, Region: "auto", ForcePathStyle: true,
				AccessKeyID: "test-access-key-id", SecretAccessKey: "test-secret-access-key", KeyPrefix: prefix}

			cleanupNeeded, verifyErr := verifySliceStorage(context.Background(), account, uuid.NewString(), tc.origin)
			if tc.wantCode == "" {
				if verifyErr != nil || cleanupNeeded {
					t.Fatalf("verification failed: cleanupNeeded=%v err=%v", cleanupNeeded, verifyErr)
				}
				return
			}
			if verifyErr == nil {
				t.Fatalf("verification passed, want %s", tc.wantCode)
			}
			failure := mediaFailureDetails(sliceVerifyFailure(verifyErr))
			if failure.status != http.StatusBadRequest || failure.code != tc.wantCode || failure.text != verifyFailureTexts[tc.wantCode] {
				t.Fatalf("failure = %d %s %q, want 400 %s %q", failure.status, failure.code, failure.text, tc.wantCode, verifyFailureTexts[tc.wantCode])
			}
			if cleanupNeeded != tc.wantCleanup {
				t.Fatalf("cleanupNeeded = %v, want %v", cleanupNeeded, tc.wantCleanup)
			}
			fake.mu.Lock()
			leaked := fake.key != "" && !fake.deleted
			fake.mu.Unlock()
			if leaked && !cleanupNeeded {
				t.Fatalf("verification failed with %s but left its test object in the bucket", tc.wantCode)
			}
		})
	}
}

func TestVerifySliceStorageUnclassifiedFailureIsGeneric(t *testing.T) {
	failure := mediaFailureDetails(sliceVerifyFailure(fmt.Errorf("png encode: %w", io.ErrUnexpectedEOF)))
	if failure.status != http.StatusBadRequest || failure.code != "R2_VERIFICATION_FAILED" || failure.text != verifyFailureTexts["R2_VERIFICATION_FAILED"] {
		t.Fatalf("failure = %d %s %q", failure.status, failure.code, failure.text)
	}
}

// verifyTransitBytes also backs the complete and probe endpoints; their error
// contract (missing / unavailable / conflict) must not change.
func TestVerifyTransitBytesKeepsEndpointErrors(t *testing.T) {
	var data bytes.Buffer
	if err := png.Encode(&data, image.NewRGBA(image.Rect(0, 0, 2, 2))); err != nil {
		t.Fatal(err)
	}
	sum := sha256.Sum256(data.Bytes())
	digest := hex.EncodeToString(sum[:])
	id := uuid.NewString()
	prefix, err := media.SlicePrefix(id)
	if err != nil {
		t.Fatal(err)
	}
	key, err := objectkey.ComposeBatchedKey(prefix, uuid.NewString(), digest, "png", newTransitBatch(time.Now()))
	if err != nil {
		t.Fatal(err)
	}
	lease := transitLease{key: key, digest: digest, extension: "png", bytes: int64(data.Len())}
	good := func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "image/png")
		_, _ = w.Write(data.Bytes())
	}
	wrongBody := func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "image/png")
		_, _ = w.Write(bytes.Repeat([]byte{1}, data.Len()))
	}
	cases := []struct {
		name            string
		private, public http.HandlerFunc
		wantCode        string // empty means success
	}{
		{name: "both readable", private: good, public: good},
		{name: "private 404", private: status(http.StatusNotFound), public: good, wantCode: "MEDIA_COMPLETE_MISSING"},
		{name: "public 404", private: good, public: status(http.StatusNotFound), wantCode: "MEDIA_COMPLETE_MISSING"},
		{name: "private 403", private: status(http.StatusForbidden), public: good, wantCode: "UNAVAILABLE"},
		{name: "public 500", private: good, public: status(http.StatusInternalServerError), wantCode: "UNAVAILABLE"},
		{name: "private wrong bytes", private: wrongBody, public: good, wantCode: "CONFLICT"},
		{name: "public wrong bytes", private: good, public: wrongBody, wantCode: "CONFLICT"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if strings.HasPrefix(r.URL.Path, "/"+verifyTestBucket+"/") {
					tc.private(w, r)
					return
				}
				tc.public(w, r)
			}))
			defer server.Close()
			account := sign.Account{ID: id, Provider: sign.ProviderCloudflare, Endpoint: server.URL, Bucket: verifyTestBucket,
				PublicBaseURL: server.URL, Region: "auto", ForcePathStyle: true,
				AccessKeyID: "test-access-key-id", SecretAccessKey: "test-secret-access-key", KeyPrefix: prefix}
			width, height, err := verifyTransitBytes(context.Background(), account, lease, time.Now())
			if tc.wantCode == "" {
				if err != nil || width != 2 || height != 2 {
					t.Fatalf("got %dx%d err=%v, want 2x2", width, height, err)
				}
				return
			}
			if err == nil || mediaFailureDetails(err).code != tc.wantCode {
				t.Fatalf("err = %v, want code %s", err, tc.wantCode)
			}
		})
	}
}
