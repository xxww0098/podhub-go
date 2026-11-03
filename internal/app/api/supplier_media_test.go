package api

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"net/http"
	"net/http/httptest"
	"testing"

	sign "github.com/xxww0098/podhub-go/internal/platform/r2/sigv4"
)

func TestSupplierMediaChecksActualBytesAndConfinesURLs(t *testing.T) {
	original := []byte("8BPS real transfer test")
	body := original
	origin := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { _, _ = w.Write(body) }))
	defer origin.Close()
	account := sign.Account{Provider: sign.ProviderGeneric, Endpoint: origin.URL, Region: "auto", Bucket: "assets", PublicBaseURL: origin.URL + "/public", ForcePathStyle: true, AccessKeyID: "test", SecretAccessKey: "test"}
	sum := sha256.Sum256(original)
	digest := hex.EncodeToString(sum[:])
	file := supplierMediaFile{URL: sign.PublicURL(account, "supplier-dbs/source/"+digest+".psd"), Name: "test.psd", Bytes: int64(len(original))}
	if err := verifySupplierFile(context.Background(), account, "source", file, true); err != nil {
		t.Fatal(err)
	}
	body = []byte("8BPS wrong bytes proof!")
	if err := verifySupplierFile(context.Background(), account, "source", file, true); err == nil {
		t.Fatal("mismatched object was accepted")
	}
	for _, foreign := range []supplierMediaFile{{URL: file.URL + "?x=1", Bytes: file.Bytes}, {URL: origin.URL + "/foreign/" + digest + ".psd", Bytes: file.Bytes}, {URL: file.URL, Bytes: 501 << 20}} {
		if _, _, _, err := supplierMediaKey(account, "source", foreign, true); err == nil {
			t.Fatal("unbound asset accepted")
		}
	}
}
