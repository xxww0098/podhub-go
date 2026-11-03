package app

import (
	"context"
	"encoding/base64"
	"encoding/hex"
	"io"
	"net/http"
	"strings"
	"testing"

	registry "github.com/xxww0098/podhub-go/internal/media/service/registry"
)

type imageProofTransport func(*http.Request) (*http.Response, error)

func (f imageProofTransport) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

func TestImagePublicClientUsesConfiguredHost(t *testing.T) {
	account := registry.Account{PublicBaseURL: "https://pub-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.r2.dev"}
	assets := NewRegistryImageAssets(nil, account, nil).(registryImageAssets)
	if assets.publicClient == nil || assets.publicClient.CheckRedirect(nil, nil) != http.ErrUseLastResponse {
		t.Fatal("public image client must reject redirects")
	}
	transport := assets.publicClient.Transport.(*http.Transport)
	if transport.Proxy != nil {
		t.Fatal("public image client must bypass ambient proxies")
	}
	// Host refusal happens before DNS or a network request.
	if connection, err := transport.DialContext(context.Background(), "tcp", "podhub-supplier.ozon-pod.com:443"); err == nil {
		connection.Close()
		t.Fatal("test bucket public client accepted the production host")
	}
	if _, err := NewRegistryImageAssets(nil, registry.Account{}, nil).Save(context.Background(), 1, 1, []byte("image")); err == nil {
		t.Fatal("image save accepted missing public storage")
	}
}

// R2 exposes full-object CRC64NVME, not full-object SHA256. Only a complete
// independent GET may fill the SHA256 proof when that HEAD field is absent.
func TestImageReadbackR2ChecksumContract(t *testing.T) {
	pixels := []byte("stored-jpeg-pixels")
	digest := storedImageDigest(pixels)
	rawDigest, _ := hex.DecodeString(digest)
	for _, tc := range []struct {
		name, headSHA               string
		privateBad, publicBad, want bool
	}{
		{name: "CRC64 HEAD with full GET", want: true},
		{name: "full SHA256 HEAD and GET", headSHA: base64.StdEncoding.EncodeToString(rawDigest), want: true},
		{name: "composite SHA256 requires GET", headSHA: base64.StdEncoding.EncodeToString(rawDigest) + "-2", want: true},
		{name: "HEAD contradiction", headSHA: base64.StdEncoding.EncodeToString(make([]byte, 32))},
		{name: "CRC64 cannot rescue corrupt GET", privateBad: true},
		{name: "private match cannot rescue corrupt public GET", publicBad: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			privateGets, publicGets := 0, 0
			transport := imageProofTransport(func(r *http.Request) (*http.Response, error) {
				headers := http.Header{"Content-Type": {"image/jpeg"}, "Content-Length": {"18"}}
				body := pixels
				if r.Method == http.MethodHead {
					headers.Set("X-Amz-Checksum-Crc64nvme", "arbitrary-crc64")
					if tc.headSHA != "" {
						headers.Set("X-Amz-Checksum-Sha256", tc.headSHA)
					}
					body = nil
				} else if r.URL.Host == "pub-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.r2.dev" {
					publicGets++
					if r.Header.Get("Authorization") != "" || r.URL.RawQuery != "" {
						t.Fatal("public request carried credentials")
					}
					if tc.publicBad {
						body = []byte("bad")
					}
				} else {
					privateGets++
					if tc.privateBad {
						body = []byte("bad")
					}
				}
				return &http.Response{StatusCode: 200, Header: headers, Body: io.NopCloser(strings.NewReader(string(body)))}, nil
			})
			client := &http.Client{Transport: transport}
			s := registryImageAssets{account: registry.Account{Provider: "cloudflare", Endpoint: "https://example.r2.cloudflarestorage.com", Region: "auto", Bucket: "podhub-test-supplier", PublicBaseURL: "https://pub-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.r2.dev", ForcePathStyle: true, AccessKeyID: "test", SecretAccessKey: "test"}, client: client, publicClient: client}
			proof, err := s.readback(context.Background(), "dev/orgs/1/images/"+digest+".jpg", digest, int64(len(pixels)))
			if (err == nil) != tc.want {
				t.Fatalf("allowed=%v want %v: %v", err == nil, tc.want, err)
			}
			if tc.want && (proof.ReadbackSHA256Hex != digest || privateGets != 1 || publicGets != 1) {
				t.Fatalf("incomplete GET proof: private=%d public=%d", privateGets, publicGets)
			}
		})
	}
}
