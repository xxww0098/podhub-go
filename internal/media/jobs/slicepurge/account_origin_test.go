package slicepurge

import (
	"context"
	"encoding/xml"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/xxww0098/podhub-go/internal/media/contract"
	"github.com/xxww0098/podhub-go/internal/media/domain/objectkey"
	sign "github.com/xxww0098/podhub-go/internal/platform/r2/sigv4"
)

func TestOriginClearsOnlyOlderCanonicalKeysWithinItsPrefix(t *testing.T) {
	id := uuid.NewString()
	prefix, _ := contract.SlicePrefix(id)
	now := time.Now().UTC()
	key := func(when time.Time) string {
		batch := fmt.Sprintf("%d.%s", when.UnixMilli(), uuid.NewString())
		value, err := objectkey.ComposeBatchedKey(prefix, "550e8400-e29b-41d4-a716-446655440000", strings.Repeat("a", 64), "png", batch)
		if err != nil {
			t.Fatal(err)
		}
		return value
	}
	old, recent := key(now.Add(-time.Hour)), key(now.Add(time.Hour))
	var deleted []string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.Method {
		case http.MethodGet:
			if r.URL.Query().Get("prefix") != prefix+"uploads/" {
				t.Error("wrong prefix")
			}
			if r.URL.Query().Get("continuation-token") == "" {
				fmt.Fprintf(w, "<ListBucketResult><Contents><Key>%s</Key></Contents><IsTruncated>true</IsTruncated><NextContinuationToken>next</NextContinuationToken></ListBucketResult>", recent)
			} else {
				fmt.Fprintf(w, "<ListBucketResult><Contents><Key>%s</Key></Contents><IsTruncated>false</IsTruncated></ListBucketResult>", old)
			}
		case http.MethodPost:
			if r.Header.Get("Content-Md5") == "" {
				t.Error("missing checksum")
			}
			var input struct {
				Objects []struct {
					Key string `xml:"Key"`
				} `xml:"Object"`
			}
			if err := xml.NewDecoder(r.Body).Decode(&input); err != nil {
				t.Fatal(err)
			}
			io.WriteString(w, "<DeleteResult>")
			for _, object := range input.Objects {
				deleted = append(deleted, object.Key)
				fmt.Fprintf(w, "<Deleted><Key>%s</Key></Deleted>", object.Key)
			}
			io.WriteString(w, "</DeleteResult>")
		default:
			w.WriteHeader(http.StatusMethodNotAllowed)
		}
	}))
	t.Cleanup(server.Close)
	origin := AccountOrigin{Account: sign.Account{ID: id, Provider: sign.ProviderCloudflare, Endpoint: server.URL, Bucket: "test-bucket", Region: "auto", ForcePathStyle: true, AccessKeyID: "key", SecretAccessKey: "secret", KeyPrefix: prefix}, Before: now}
	keys, err := origin.List(context.Background())
	if err != nil || len(keys) != 1 || keys[0] != old {
		t.Fatalf("listed %v: %v", keys, err)
	}
	result, err := origin.Delete(context.Background(), keys)
	if err != nil || result.Deleted != 1 || len(deleted) != 1 || deleted[0] != old {
		t.Fatalf("delete %+v %v", result, err)
	}
	for _, invalid := range []string{recent, strings.Replace(old, prefix, "other/", 1), old + "/../file"} {
		if _, err := origin.Delete(context.Background(), []string{invalid}); err == nil {
			t.Fatalf("accepted %s", invalid)
		}
	}
}

func TestOriginRefusesIncompleteDeleteReceipt(t *testing.T) {
	id := uuid.NewString()
	prefix, _ := contract.SlicePrefix(id)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { io.WriteString(w, "<DeleteResult/>") }))
	t.Cleanup(server.Close)
	now := time.Now()
	key, _ := objectkey.ComposeBatchedKey(prefix, "550e8400-e29b-41d4-a716-446655440000", strings.Repeat("b", 64), "jpg", fmt.Sprintf("%d.%s", now.Add(-time.Hour).UnixMilli(), uuid.NewString()))
	origin := AccountOrigin{Account: sign.Account{ID: id, Provider: sign.ProviderCloudflare, Endpoint: server.URL, Bucket: "test-bucket", Region: "auto", ForcePathStyle: true, AccessKeyID: "key", SecretAccessKey: "secret", KeyPrefix: prefix}, Before: now}
	if _, err := origin.Delete(context.Background(), []string{key}); err == nil {
		t.Fatal("incomplete receipt accepted")
	}
}

func TestOriginSkipsProtectedPagesWithoutHidingLaterEligibleKeys(t *testing.T) {
	id := uuid.NewString()
	prefix, _ := contract.SlicePrefix(id)
	now := time.Now()
	batch := fmt.Sprintf("%d.%s", now.Add(-48*time.Hour).UnixMilli(), uuid.NewString())
	key := func(i int) string {
		value, err := objectkey.ComposeBatchedKey(prefix, "550e8400-e29b-41d4-a716-446655440000", fmt.Sprintf("%064x", i), "png", batch)
		if err != nil {
			t.Fatal(err)
		}
		return value
	}
	want := key(1001)
	pages, filtered := 0, 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		pages++
		io.WriteString(w, "<ListBucketResult>")
		if r.URL.Query().Get("continuation-token") == "" {
			for i := 1; i <= 1000; i++ {
				fmt.Fprintf(w, "<Contents><Key>%s</Key></Contents>", key(i))
			}
			io.WriteString(w, "<IsTruncated>true</IsTruncated><NextContinuationToken>next</NextContinuationToken>")
		} else {
			fmt.Fprintf(w, "<Contents><Key>%s</Key></Contents>", want)
		}
		io.WriteString(w, "</ListBucketResult>")
	}))
	defer server.Close()
	origin := AccountOrigin{Account: sign.Account{ID: id, Provider: sign.ProviderCloudflare, Endpoint: server.URL, Bucket: "test-bucket", Region: "auto", ForcePathStyle: true, AccessKeyID: "key", SecretAccessKey: "secret", KeyPrefix: prefix}, Before: now,
		SelectKeys: func(_ context.Context, keys []string) ([]string, error) {
			filtered += len(keys)
			for _, candidate := range keys {
				if candidate == want {
					return []string{candidate}, nil
				}
			}
			return nil, nil
		},
	}
	keys, err := origin.List(context.Background())
	if err != nil || len(keys) != 1 || keys[0] != want || pages != 2 || filtered != 1001 {
		t.Fatalf("eligible=%v pages=%d filtered=%d err=%v", keys, pages, filtered, err)
	}
	origin.SelectKeys = func(context.Context, []string) ([]string, error) { return nil, fmt.Errorf("reference lookup failed") }
	if _, err := origin.List(context.Background()); err == nil {
		t.Fatal("reference lookup failure permitted cleanup")
	}
}
