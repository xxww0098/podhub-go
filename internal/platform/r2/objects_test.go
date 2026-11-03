package r2

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"

	"github.com/xxww0098/podhub-go/internal/platform/r2/sigv4"
)

func TestObjectListingPaginationAndNamespace(t *testing.T) {
	const prefix = "podhub-slices/test/uploads/"
	var body atomic.Value
	body.Store(`<ListBucketResult><Contents><Key>` + prefix + `a.png</Key><Size>42</Size><ETag>abc</ETag></Contents><CommonPrefixes><Prefix>` + prefix + `folder/</Prefix></CommonPrefixes><IsTruncated>true</IsTruncated><NextContinuationToken>next</NextContinuationToken></ListBucketResult>`)
	var calls atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		q := r.URL.Query()
		if q.Get("prefix") != prefix || q.Get("list-type") != "2" || q.Get("max-keys") != "100" || q.Get("delimiter") != "/" || q.Get("continuation-token") != "prior" || q.Get("X-Amz-Signature") == "" {
			t.Error("listing did not preserve its signed query")
		}
		fmt.Fprint(w, body.Load().(string))
	}))
	defer srv.Close()
	account := sigv4.Account{Provider: sigv4.ProviderCloudflare, Endpoint: srv.URL, Bucket: "test", Region: "auto", ForcePathStyle: true, AccessKeyID: "access", SecretAccessKey: "secret", KeyPrefix: "podhub-slices/test/"}
	page, err := ListObjects(context.Background(), account, prefix, "prior", 100, true)
	if err != nil || page.Next != "next" || len(page.Objects) != 1 || page.Objects[0].Size != 42 || len(page.Folders) != 1 {
		t.Fatalf("page=%+v error=%v", page, err)
	}
	for _, bad := range []string{
		`<ListBucketResult><Contents><Key>another/key</Key></Contents></ListBucketResult>`,
		`<ListBucketResult><CommonPrefixes><Prefix>another/</Prefix></CommonPrefixes></ListBucketResult>`,
		`<ListBucketResult><IsTruncated>true</IsTruncated></ListBucketResult>`,
		`<ListBucketResult><IsTruncated>true</IsTruncated><NextContinuationToken>prior</NextContinuationToken></ListBucketResult>`,
		`<ListBucketResult><Contents><Key>` + prefix + `a</Key><Size>-1</Size></Contents></ListBucketResult>`,
		`<ListBucketResult><Contents><Key>` + prefix + `a</Key><Size>18446744073709551615</Size></Contents></ListBucketResult>`,
		`<not-a-list/>`,
	} {
		body.Store(bad)
		if _, err := ListObjects(context.Background(), account, prefix, "prior", 100, true); err == nil {
			t.Errorf("accepted invalid response %s", bad)
		}
	}
	before := calls.Load()
	if _, err := ListObjects(context.Background(), account, "other/", "", 100, true); err == nil || calls.Load() != before {
		t.Fatal("out-of-scope listing reached the upstream")
	}
}
