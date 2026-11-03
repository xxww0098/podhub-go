package api

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"image"
	"image/png"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/xxww0098/podhub-go/internal/media/domain/objectkey"
	sign "github.com/xxww0098/podhub-go/internal/platform/r2/sigv4"
)

func TestTransitBatchValidationAndIdentity(t *testing.T) {
	now := time.Now()
	account := sign.Account{ID: "transit", Provider: sign.ProviderCloudflare, Endpoint: "https://account.r2.cloudflarestorage.com", Bucket: "test-transit", KeyPrefix: "qa/"}
	batch := newTransitBatch(now)
	lease, err := makeTransitLease(account, mediaWorkspace, batch, mediaDigest, "png", 12, now)
	if err != nil || !strings.HasPrefix(lease.key, "qa/uploads/") || lease.revision < 0 || lease.revision > 1<<53 {
		t.Fatalf("lease=%+v err=%v", lease, err)
	}
	if _, ok := objectkey.ParseUploadKey(lease.key); !ok {
		t.Fatal("transit key is not consumable by send")
	}
	for _, bad := range []string{batch + ".unbound", newTransitBatch(now.Add(-4 * time.Hour)), newTransitBatch(now.Add(6 * time.Second))} {
		if _, err := makeTransitLease(account, mediaWorkspace, bad, mediaDigest, "png", 12, now); err == nil {
			t.Fatalf("invalid batch accepted: %s", bad)
		}
	}
	for _, ext := range []string{"mp4", "mov", "psd"} {
		if _, err := makeTransitLease(account, mediaWorkspace, batch, mediaDigest, ext, 12, now); err == nil {
			t.Fatalf("transit extension accepted: %s", ext)
		}
	}
	for _, size := range []int64{0, -1, transitObjectLimit + 1} {
		if _, err := makeTransitLease(account, mediaWorkspace, batch, mediaDigest, "png", size, now); err == nil {
			t.Fatal("invalid object size accepted")
		}
	}
	changed := account
	changed.Bucket = "changed"
	if transitStorageRevision(changed) == lease.revision {
		t.Fatal("bucket switch retained revision")
	}
	before := time.Date(2026, 10, 15, 19, 55, 0, 0, time.UTC)
	if _, err := makeTransitLease(account, mediaWorkspace, newTransitBatch(before), mediaDigest, "png", 12, before.Add(10*time.Minute)); err != nil {
		t.Fatalf("batch was rejected only because it crossed the old fixed 04:00 boundary: %v", err)
	}
}

func TestTransitProofRequiresPrivateAndPublicBytes(t *testing.T) {
	var body bytes.Buffer
	if err := png.Encode(&body, image.NewRGBA(image.Rect(0, 0, 2, 2))); err != nil {
		t.Fatal(err)
	}
	pixels := body.Bytes()
	digest := sha256.Sum256(pixels)
	for _, tc := range []struct {
		name                           string
		privateBad, publicBad, missing bool
		wantCode                       string
	}{
		{name: "both verified"},
		{name: "private corrupt", privateBad: true, wantCode: "CONFLICT"},
		{name: "public corrupt", publicBad: true, wantCode: "CONFLICT"},
		{name: "missing object", missing: true, wantCode: "MEDIA_COMPLETE_MISSING"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			private, public := 0, 0
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				isPublic := strings.HasPrefix(r.URL.Path, "/public/")
				if isPublic {
					public++
				} else {
					private++
				}
				if tc.missing {
					w.WriteHeader(404)
					return
				}
				raw := append([]byte(nil), pixels...)
				if isPublic && tc.publicBad || !isPublic && tc.privateBad {
					raw[0] ^= 1
				}
				if isPublic && (r.URL.RawQuery != "" || r.Header.Get("Authorization") != "") {
					t.Error("public read carried credentials")
				}
				w.Header().Set("Content-Type", "image/png")
				w.Header().Set("Content-Length", strconv.Itoa(len(raw)))
				_, _ = w.Write(raw)
			}))
			defer server.Close()
			account := sign.Account{ID: "transit", Provider: sign.ProviderCloudflare, Endpoint: server.URL, Bucket: "test-transit", Region: "auto", ForcePathStyle: true, AccessKeyID: "test", SecretAccessKey: "test", PublicBaseURL: server.URL + "/public"}
			lease := transitLease{key: "qa/file.png", digest: hex.EncodeToString(digest[:]), extension: "png", bytes: int64(len(pixels))}
			width, height, err := verifyTransitBytes(context.Background(), account, lease, time.Now())
			if tc.wantCode == "" {
				if err != nil || width != 2 || height != 2 || private != 1 || public != 1 {
					t.Fatalf("proof: %dx%d %d/%d %v", width, height, private, public, err)
				}
			} else if err == nil || mediaFailureDetails(err).code != tc.wantCode {
				t.Fatalf("proof error=%v", err)
			}
		})
	}
}
