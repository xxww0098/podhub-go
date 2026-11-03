package app

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"image"
	"image/png"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	ai "github.com/xxww0098/podhub-go/internal/ai/contract"
	access "github.com/xxww0098/podhub-go/internal/identity/contract"
	"github.com/xxww0098/podhub-go/internal/media/domain/receipt"
	sign "github.com/xxww0098/podhub-go/internal/platform/r2/sigv4"
)

func ocrTestPNG(t *testing.T, width, height int) []byte {
	t.Helper()
	var out bytes.Buffer
	if err := png.Encode(&out, image.NewGray(image.Rect(0, 0, width, height))); err != nil {
		t.Fatal(err)
	}
	return out.Bytes()
}

func ocrTestImage(raw []byte) ai.Image {
	sum := sha256.Sum256(raw)
	return ai.Image{Bytes: uint64(len(raw)), SHA256: hex.EncodeToString(sum[:]), ContentType: "image/png"}
}

func ocrTestSubject(endpoint string) (sign.Account, access.Principal, ai.Claim, ai.Binding, time.Time) {
	return sign.Account{ID: "private-ocr-test", Provider: sign.ProviderGeneric, Endpoint: endpoint, Region: "auto", Bucket: "private-test", KeyPrefix: "qa", ForcePathStyle: true, AccessKeyID: "test-access", SecretAccessKey: "test-secret"},
		access.Principal{UserID: 21, OrgID: 31},
		ai.Claim{JobID: "c4c9de2e-1eba-478e-a1ec-65eb177aa8d7", Lease: ai.Lease{Owner: "browser-worker", Epoch: 7}},
		ai.Binding{Fingerprint: strings.Repeat("a", 64)}, time.Date(2026, 10, 25, 8, 0, 0, 0, time.UTC)
}

func ocrTestTicket(t *testing.T, account sign.Account, p access.Principal, claim ai.Claim, binding ai.Binding, in ai.Image, now time.Time) string {
	t.Helper()
	target, err := ocrUploadTarget(account, p, claim, binding, in, now)
	if err != nil {
		t.Fatal(err)
	}
	ticket, ok := target.(map[string]any)["upload_ticket"].(string)
	if !ok || ticket == "" {
		t.Fatal("missing upload ticket")
	}
	return ticket
}

func TestOCRImageUploadAndPrivateRead(t *testing.T) {
	raw := ocrTestPNG(t, 2, 3)
	in := ocrTestImage(raw)
	var puts, gets, publicGets atomic.Int32
	public := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		publicGets.Add(1)
		http.Error(w, "public access forbidden", http.StatusForbidden)
	}))
	defer public.Close()
	var stored []byte
	objectPath := "/private-test/qa/ocr/31/c4c9de2e-1eba-478e-a1ec-65eb177aa8d7/7/" + in.SHA256
	private := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != objectPath || r.URL.Query().Get("X-Amz-Signature") == "" {
			t.Error("request did not use the exact signed private object")
			http.Error(w, "invalid target", http.StatusBadRequest)
			return
		}
		switch r.Method {
		case http.MethodPut:
			puts.Add(1)
			if r.Header.Get("Content-Type") != in.ContentType || r.Header.Get("If-None-Match") != "*" {
				t.Error("upload did not preserve content type and conditional creation")
			}
			var err error
			stored, err = io.ReadAll(r.Body)
			if err != nil {
				t.Error(err)
			}
		case http.MethodGet:
			gets.Add(1)
			if r.Header.Get("Accept-Encoding") != "" {
				t.Error("private proof read requested compressed bytes")
			}
			w.Header().Set("Content-Type", in.ContentType)
			_, _ = w.Write(stored)
		default:
			t.Errorf("unexpected object operation %s", r.Method)
			w.WriteHeader(http.StatusMethodNotAllowed)
		}
	}))
	defer private.Close()
	account, p, claim, binding, now := ocrTestSubject(private.URL)
	account.PublicBaseURL = public.URL
	target, err := ocrUploadTarget(account, p, claim, binding, in, now)
	if err != nil {
		t.Fatal(err)
	}
	encoded, err := json.Marshal(target)
	if err != nil || bytes.Contains(encoded, []byte(public.URL)) || bytes.Contains(encoded, []byte(account.SecretAccessKey)) {
		t.Fatal("upload target exposed the public URL or account secret")
	}
	grant := target.(map[string]any)
	upload := grant["upload"].(map[string]any)
	putURL := upload["url"].(string)
	parsed, err := url.Parse(putURL)
	if err != nil || parsed.Scheme+"://"+parsed.Host != private.URL || parsed.Path != objectPath {
		t.Fatal("upload grant did not target private storage")
	}
	request, err := http.NewRequest(http.MethodPut, putURL, bytes.NewReader(raw))
	if err != nil {
		t.Fatal(err)
	}
	headers := upload["headers"].(map[string]any)
	request.Header.Set("Content-Type", headers["content_type"].(string))
	request.Header.Set("If-None-Match", headers["if_none_match"].(string))
	if checksum, ok := headers["checksum_sha256"].(string); ok {
		request.Header.Set("X-Amz-Checksum-Sha256", checksum)
	}
	response, err := private.Client().Do(request)
	if err != nil {
		t.Fatal(err)
	}
	response.Body.Close()
	if response.StatusCode != http.StatusOK {
		t.Fatalf("PUT status = %d", response.StatusCode)
	}
	got, mime, err := readOCRUpload(context.Background(), account, p, claim, binding, grant["upload_ticket"].(string), now)
	if err != nil || !bytes.Equal(got, raw) || mime != "image/png" || puts.Load() != 1 || gets.Load() != 1 || publicGets.Load() != 0 {
		t.Fatalf("private round trip: bytes=%d mime=%q puts=%d gets=%d public=%d err=%v", len(got), mime, puts.Load(), gets.Load(), publicGets.Load(), err)
	}
}

func TestOCRImageTicketRejectsChangedBindingBeforeNetwork(t *testing.T) {
	var requests atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests.Add(1)
		w.WriteHeader(http.StatusInternalServerError)
	}))
	defer server.Close()
	account, p, claim, binding, now := ocrTestSubject(server.URL)
	ticket := ocrTestTicket(t, account, p, claim, binding, ocrTestImage(ocrTestPNG(t, 1, 1)), now)
	for _, name := range []string{"tampered", "actor", "organization", "job", "lease owner", "lease epoch", "fingerprint", "account ID", "provider", "endpoint", "region", "bucket", "prefix", "path style", "secret", "expired", "not issued yet"} {
		t.Run(name, func(t *testing.T) {
			a, principal, c, b, at, token := account, p, claim, binding, now, ticket
			switch name {
			case "tampered":
				pieces := strings.Split(token, ".")
				pieces[1] = "A" + pieces[1][1:]
				if pieces[1] == strings.Split(token, ".")[1] {
					pieces[1] = "B" + pieces[1][1:]
				}
				token = strings.Join(pieces, ".")
			case "actor":
				principal.UserID++
			case "organization":
				principal.OrgID++
			case "job":
				c.JobID = "another-job"
			case "lease owner":
				c.Lease.Owner = "another-worker"
			case "lease epoch":
				c.Lease.Epoch++
			case "fingerprint":
				b.Fingerprint = strings.Repeat("b", 64)
			case "account ID":
				a.ID += "-changed"
			case "provider":
				a.Provider = sign.ProviderLegacyS3
			case "endpoint":
				a.Endpoint += "/changed"
			case "region":
				a.Region = "another-region"
			case "bucket":
				a.Bucket = "another-bucket"
			case "prefix":
				a.KeyPrefix = "another-prefix"
			case "path style":
				a.ForcePathStyle = false
			case "secret":
				a.SecretAccessKey += "-rotated"
			case "expired":
				at = at.Add(4 * time.Hour)
			case "not issued yet":
				at = at.Add(-10 * time.Second)
			}
			got, mime, err := readOCRUpload(context.Background(), a, principal, c, b, token, at)
			if !errors.Is(err, receipt.ErrInvalid) || len(got) != 0 || mime != "" || requests.Load() != 0 {
				t.Fatalf("invalid binding reached storage or yielded bytes: requests=%d mime=%q err=%v", requests.Load(), mime, err)
			}
		})
	}
}

func TestOCRImageReadRejectsMissingOrInvalidObject(t *testing.T) {
	pngBytes := ocrTestPNG(t, 2, 3)
	oversized := ocrTestPNG(t, 2001, 2000)
	corrupt := pngBytes[:33] // Valid PNG dimensions without its image data.
	wrongHash := ocrTestImage(pngBytes)
	wrongHash.SHA256 = strings.Repeat("0", 64)
	wrongType := ocrTestImage(pngBytes)
	wrongType.ContentType = "image/jpeg"
	for _, tc := range []struct {
		name          string
		body          []byte
		image         ai.Image
		status        int
		declaredBytes int
		missing       bool
	}{
		{name: "missing", image: ocrTestImage(pngBytes), status: http.StatusNotFound, missing: true},
		{name: "storage failure", image: ocrTestImage(pngBytes), status: http.StatusServiceUnavailable},
		{name: "wrong sha256", body: pngBytes, image: wrongHash},
		{name: "wrong encoded MIME", body: pngBytes, image: wrongType},
		{name: "short body", body: pngBytes[:len(pngBytes)-1], image: ocrTestImage(pngBytes)},
		{name: "extra bytes", body: append(append([]byte{}, pngBytes...), 0, 0), image: ocrTestImage(pngBytes)},
		{name: "truncated HTTP body", body: pngBytes[:len(pngBytes)-1], image: ocrTestImage(pngBytes), declaredBytes: len(pngBytes)},
		{name: "oversized dimensions", body: oversized, image: ocrTestImage(oversized)},
		{name: "corrupt image data", body: corrupt, image: ocrTestImage(corrupt)},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var requests atomic.Int32
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				requests.Add(1)
				if r.Method != http.MethodGet {
					t.Errorf("proof used %s instead of a full GET", r.Method)
				}
				w.Header().Set("Content-Type", tc.image.ContentType)
				if tc.declaredBytes > 0 {
					w.Header().Set("Content-Length", strconv.Itoa(tc.declaredBytes))
				}
				if tc.status != 0 {
					w.WriteHeader(tc.status)
				}
				_, _ = w.Write(tc.body)
			}))
			defer server.Close()
			account, p, claim, binding, now := ocrTestSubject(server.URL)
			ticket := ocrTestTicket(t, account, p, claim, binding, tc.image, now)
			got, mime, err := readOCRUpload(context.Background(), account, p, claim, binding, ticket, now)
			if err == nil || len(got) != 0 || mime != "" || requests.Load() != 1 || errors.Is(err, ai.ErrImageMissing) != tc.missing {
				t.Fatalf("invalid object accepted or misclassified: requests=%d bytes=%d mime=%q err=%v", requests.Load(), len(got), mime, err)
			}
		})
	}
}

func TestOCRImageUploadRejectsInvalidMetadata(t *testing.T) {
	account, p, claim, binding, now := ocrTestSubject("http://127.0.0.1:1")
	valid := ocrTestImage(ocrTestPNG(t, 1, 1))
	for _, name := range []string{"empty", "too large", "unsupported MIME", "invalid digest"} {
		t.Run(name, func(t *testing.T) {
			in := valid
			switch name {
			case "empty":
				in.Bytes = 0
			case "too large":
				in.Bytes = 1_400_001
			case "unsupported MIME":
				in.ContentType = "image/webp"
			case "invalid digest":
				in.SHA256 = "not-a-sha256"
			}
			if target, err := ocrUploadTarget(account, p, claim, binding, in, now); err == nil || target != nil {
				t.Fatal("invalid image received an upload target")
			}
		})
	}
}
