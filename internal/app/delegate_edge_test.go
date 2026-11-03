package app

import (
	"bytes"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/xxww0098/podhub-go/internal/delegate/contract"
	delegatesvc "github.com/xxww0098/podhub-go/internal/delegate/service"
	"github.com/xxww0098/podhub-go/internal/platform/config"
	sign "github.com/xxww0098/podhub-go/internal/platform/r2/sigv4"
	"github.com/xxww0098/podhub-go/internal/platform/seal"
)

func TestDelegateUsesTheStoreCredentialKeyDerivation(t *testing.T) {
	key := bytes.Repeat([]byte{7}, 32)
	for _, raw := range []string{hex.EncodeToString(key), base64.StdEncoding.EncodeToString(key), strings.Repeat("k", 32)} {
		cfg := config.Config{SellerCredentialKey: raw, SellerCredentialKeyID: "k1"}
		dek := bytes.Repeat([]byte{8}, 32)
		nonce, ciphertext, err := seal.SealBlob(dek, seal.StoreAAD(7, 42, 3), []byte("client\x00fixture-api-key"))
		if err != nil {
			t.Fatal(err)
		}
		dekNonce, wrapped, err := seal.SealBlob(seal.DeriveKEK(raw), seal.WrapAAD(7, 42, "k1"), dek)
		if err != nil {
			t.Fatal(err)
		}
		cred := contract.SealedCredential{OrgID: 7, StorePK: 42, CredentialRevision: 3,
			KeyID: "k1", EnvelopeVersion: 2, Nonce: nonce, Ciphertext: ciphertext, DEKNonce: dekNonce, WrappedDEK: wrapped}
		id, api, err := openDelegateCredential(cfg, cred)
		if err != nil || id != "client" || api != "fixture-api-key" {
			t.Fatalf("store credential cannot be opened: %v", err)
		}
		cred.CredentialRevision++
		if _, _, err := openDelegateCredential(cfg, cred); err == nil {
			t.Fatal("credential generation mismatch accepted")
		}
	}
}

func TestDelegateCredentialVectors(t *testing.T) {
	raw, err := os.ReadFile("../platform/seal/testdata/crypto-vectors.json")
	if err != nil {
		t.Fatal(err)
	}
	var doc struct {
		V1 struct {
			Key      string `json:"key_string"`
			ClientID string `json:"client_id"`
			APIKey   string `json:"api_key"`
			Nonce    string `json:"nonce_hex"`
			Cipher   string `json:"ciphertext_hex"`
		} `json:"store_credential_v1"`
		V2 struct {
			Nonce   string `json:"payload_nonce_hex"`
			DEK     string `json:"dek_nonce_hex"`
			Payload string `json:"payload_ciphertext_hex"`
			Wrapped string `json:"wrapped_dek_hex"`
		} `json:"store_credential_v2"`
	}
	if err := json.Unmarshal(raw, &doc); err != nil {
		t.Fatal(err)
	}

	cfg := config.Config{SellerCredentialKey: doc.V1.Key, SellerCredentialKeyID: "k1"}
	id, api, err := openDelegateCredential(cfg, contract.SealedCredential{
		KeyID: "k1", OrgID: 7, StorePK: 42, CredentialRevision: 3,
		Nonce: decodeHex(t, doc.V1.Nonce), Ciphertext: decodeHex(t, doc.V1.Cipher),
	})
	if err != nil || id != doc.V1.ClientID || api != doc.V1.APIKey {
		t.Fatalf("v1 open %v %s %s", err, id, api)
	}
	id, api, err = openDelegateCredential(cfg, contract.SealedCredential{
		KeyID: "k1", OrgID: 7, StorePK: 42, CredentialRevision: 3,
		Nonce: decodeHex(t, doc.V2.Nonce), Ciphertext: decodeHex(t, doc.V2.Payload),
		WrappedDEK: decodeHex(t, doc.V2.Wrapped), DEKNonce: decodeHex(t, doc.V2.DEK),
	})
	if err != nil || id != doc.V1.ClientID || api != doc.V1.APIKey {
		t.Fatalf("v2 open %v %s %s", err, id, api)
	}
}

func TestDelegateIssueConfirmDeleteLoopback(t *testing.T) {
	body := []byte("delegate-object")
	sum := sha256.Sum256(body)
	sha := hex.EncodeToString(sum[:])
	var hits []string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits = append(hits, r.Method+" "+r.URL.Path)
		switch r.Method {
		case http.MethodGet:
			if strings.HasSuffix(r.URL.Path, "/missing.png") {
				http.NotFound(w, r)
				return
			}
			if strings.HasSuffix(r.URL.Path, "/wrong.png") {
				w.Header().Set("Content-Type", "image/png")
				w.Header().Set("Content-Length", "4")
				_, _ = w.Write([]byte("nope"))
				return
			}
			w.Header().Set("Content-Type", "image/png")
			w.Header().Set("Content-Length", "15")
			_, _ = io.WriteString(w, string(body))
		case http.MethodDelete:
			if strings.HasSuffix(r.URL.Path, "/fail.png") {
				http.Error(w, "no", http.StatusInternalServerError)
				return
			}
			w.WriteHeader(http.StatusNoContent)
		default:
			http.Error(w, "method", http.StatusMethodNotAllowed)
		}
	}))
	defer srv.Close()
	account := sign.Account{
		ID: "delegate", Provider: sign.ProviderCloudflare, Endpoint: srv.URL, Region: "auto",
		Bucket: "delegate-assets", ForcePathStyle: true, AccessKeyID: "AKIA", SecretAccessKey: "secret",
	}
	now := time.Unix(1_700_000_000, 0).UTC()
	target, err := issueDelegate(account, delegatesvc.Issue{
		Key: "7/" + sha + ".png", ContentType: "image/png", SHA: sha, Purpose: "delegate-asset:b:s",
		Bytes: uint64(len(body)), ActorID: 4, WorkspaceID: 7,
	}, now)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(target.Upload.URL, "X-Amz-Expires=600") || !strings.Contains(target.Upload.URL, sha) {
		t.Fatalf("put url %s", target.Upload.URL)
	}
	if target.Upload.Headers.IfNoneMatch != "*" || target.Upload.Headers.ContentType != "image/png" || target.UploadTicket == "" {
		t.Fatalf("grant %+v", target.Upload)
	}
	confirmed, err := confirmDelegate(t.Context(), account, "delegate-asset:b:s", 4, 7, target.UploadTicket, now)
	if err != nil || confirmed.SHA != sha || confirmed.Bytes != int64(len(body)) || confirmed.Key != "7/"+sha+".png" {
		t.Fatalf("confirm %v %+v", err, confirmed)
	}

	missing, err := issueDelegate(account, delegatesvc.Issue{
		Key: "7/missing.png", ContentType: "image/png", SHA: sha, Purpose: "delegate-asset:b:s",
		Bytes: uint64(len(body)), ActorID: 4, WorkspaceID: 7,
	}, now)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := confirmDelegate(t.Context(), account, "delegate-asset:b:s", 4, 7, missing.UploadTicket, now); err == nil || err.Error() != "上传对象尚不存在" {
		t.Fatalf("missing: %v", err)
	}

	wrong, err := issueDelegate(account, delegatesvc.Issue{
		Key: "7/wrong.png", ContentType: "image/png", SHA: sha, Purpose: "delegate-asset:b:s",
		Bytes: uint64(len(body)), ActorID: 4, WorkspaceID: 7,
	}, now)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := confirmDelegate(t.Context(), account, "delegate-asset:b:s", 4, 7, wrong.UploadTicket, now); err == nil || !statusIs(err, 409) {
		t.Fatalf("mismatch: %v", err)
	}

	remote := account
	remote.Endpoint = "https://example.r2.cloudflarestorage.com"
	remoteTicket, err := issueDelegate(remote, delegatesvc.Issue{
		Key: "7/" + sha + ".png", ContentType: "image/png", SHA: sha, Purpose: "delegate-asset:b:s",
		Bytes: uint64(len(body)), ActorID: 4, WorkspaceID: 7,
	}, now)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := confirmDelegate(t.Context(), remote, "delegate-asset:b:s", 4, 7, remoteTicket.UploadTicket, now); err == nil || err.Error() != "对象存储确认暂不可用，请稍后重试确认" {
		t.Fatalf("remote: %v", err)
	}

	before := len(hits)
	deleteDelegate(t.Context(), account, "7/"+sha+".png", false)
	if len(hits) != before {
		t.Fatalf("delete switch off dialed: %v", hits[before:])
	}
	deleteDelegate(t.Context(), account, "7/"+sha+".png", true)
	deleteDelegate(t.Context(), account, "7/fail.png", true)
	deleteDelegate(t.Context(), remote, "7/"+sha+".png", true)
	joined := strings.Join(hits, "\n")
	if !strings.Contains(joined, "DELETE /delegate-assets/7/"+sha+".png") || !strings.Contains(joined, "DELETE /delegate-assets/7/fail.png") {
		t.Fatalf("hits %s", joined)
	}
	if strings.Contains(joined, "example.r2") {
		t.Fatal("remote delete was dialed")
	}
}

func TestDelegateChecksumHead(t *testing.T) {
	body := []byte("delegate-object")
	sum := sha256.Sum256(body)
	sha := hex.EncodeToString(sum[:])
	b64, ok := sign.ChecksumB64(sha)
	if !ok {
		t.Fatal("checksum")
	}
	other, ok := sign.ChecksumB64(strings.Repeat("00", 32))
	if !ok {
		t.Fatal("other checksum")
	}
	var methods []string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		methods = append(methods, r.Method+" "+r.URL.Path)
		switch {
		case strings.HasSuffix(r.URL.Path, "/bad.png"):
			w.Header().Set("x-amz-checksum-sha256", b64)
			w.Header().Set("Content-Length", "15")
			w.Header().Set("Content-Type", "text/plain")
		case strings.HasSuffix(r.URL.Path, "/digest.png"):
			w.Header().Set("x-amz-checksum-sha256", other)
			w.Header().Set("Content-Length", "15")
			w.Header().Set("Content-Type", "image/png")
		case strings.HasSuffix(r.URL.Path, "/open.png"):
			w.Header().Set("Content-Type", "image/png")
			w.Header().Set("Content-Length", "15")
			_, _ = w.Write(body)
		default:
			w.Header().Set("x-amz-checksum-sha256", b64)
			w.Header().Set("Content-Length", "15")
			w.Header().Set("Content-Type", "image/png")
		}
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()
	account := sign.Account{
		ID: "delegate", Provider: sign.ProviderCloudflare, Endpoint: srv.URL, Region: "auto",
		Bucket: "delegate-assets", ForcePathStyle: true, AccessKeyID: "AKIA", SecretAccessKey: "secret",
	}
	now := time.Unix(1_700_000_000, 0).UTC()
	issue := func(key string) string {
		t.Helper()
		target, err := issueDelegate(account, delegatesvc.Issue{
			Key: key, ContentType: "image/png", SHA: sha, Purpose: "delegate-asset:b:s",
			Bytes: uint64(len(body)), ActorID: 4, WorkspaceID: 7, Checksum: true,
		}, now)
		if err != nil {
			t.Fatal(err)
		}
		if target.Upload.Headers.ChecksumSHA256 == nil || *target.Upload.Headers.ChecksumSHA256 == "" {
			t.Fatal("checksum header missing")
		}
		return target.UploadTicket
	}
	confirmed, err := confirmDelegate(t.Context(), account, "delegate-asset:b:s", 4, 7, issue("7/"+sha+".png"), now)
	if err != nil || confirmed.SHA != sha {
		t.Fatalf("trusted head %v %+v", err, confirmed)
	}
	if strings.Contains(strings.Join(methods, "\n"), "GET ") {
		t.Fatalf("trusted head still downloaded the object: %s", strings.Join(methods, "\n"))
	}
	if _, err := confirmDelegate(t.Context(), account, "delegate-asset:b:s", 4, 7, issue("7/bad.png"), now); err == nil || err.Error() != "上传对象长度或类型与授权不一致" {
		t.Fatalf("type: %v", err)
	}
	if _, err := confirmDelegate(t.Context(), account, "delegate-asset:b:s", 4, 7, issue("7/digest.png"), now); err == nil || err.Error() != "上传对象校验不一致，请勿覆盖该对象" {
		t.Fatalf("digest: %v", err)
	}
	before := len(methods)
	if _, err := confirmDelegate(t.Context(), account, "delegate-asset:b:s", 4, 7, issue("7/open.png"), now); err != nil {
		t.Fatal(err)
	}
	tail := strings.Join(methods[before:], "\n")
	if !strings.Contains(tail, "HEAD ") || !strings.Contains(tail, "GET ") {
		t.Fatalf("unproven head should fall through to GET: %s", tail)
	}
}

func TestDelegatePlaintextHTTPIsRefused(t *testing.T) {
	account := sign.Account{
		ID: "delegate", Provider: sign.ProviderCloudflare, Endpoint: "http://storage.example", Region: "auto",
		Bucket: "b", ForcePathStyle: true, AccessKeyID: "AKIA", SecretAccessKey: "secret",
	}
	_, err := issueDelegate(account, delegatesvc.Issue{
		Key: "7/" + strings.Repeat("ab", 32) + ".png", ContentType: "image/png",
		SHA: strings.Repeat("ab", 32), Purpose: "delegate-asset:b:s", Bytes: 12, ActorID: 1, WorkspaceID: 7,
	}, time.Unix(1_700_000_000, 0).UTC())
	if err == nil || err.Error() != "浏览器直传需要 HTTPS 对象存储地址" {
		t.Fatalf("http: %v", err)
	}
}

func statusIs(err error, status int) bool {
	var api *contract.APIError
	return err != nil && asAPI(err, &api) && api.Status == status
}

func asAPI(err error, api **contract.APIError) bool {
	return errorAs(err, api)
}

func errorAs(err error, api **contract.APIError) bool {
	for err != nil {
		if value, ok := err.(*contract.APIError); ok {
			*api = value
			return true
		}
		unwrap, ok := err.(interface{ Unwrap() error })
		if !ok {
			return false
		}
		err = unwrap.Unwrap()
	}
	return false
}

func decodeHex(t *testing.T, s string) []byte {
	t.Helper()
	b, err := hex.DecodeString(s)
	if err != nil {
		t.Fatal(err)
	}
	return b
}
