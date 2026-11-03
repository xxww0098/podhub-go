package cloudflare

import (
	"context"
	"os"
	"testing"
	"time"
)

// This opt-in creates and retains one named private bucket. It never deletes it.
func TestLiveCreateBucket(t *testing.T) {
	if os.Getenv("PODHUB_CLOUDFLARE_LIVE_CREATE") != "1" {
		t.Skip("real bucket creation requires explicit PODHUB_CLOUDFLARE_LIVE_CREATE=1")
	}
	account, name, token := os.Getenv("CLOUDFLARE_TEST_ACCOUNT_ID"), os.Getenv("CLOUDFLARE_TEST_BUCKET"), os.Getenv("CLOUDFLARE_TEST_API_TOKEN")
	if !ValidBucket(account, name) || !validToken(token) {
		t.Fatal("set CLOUDFLARE_TEST_ACCOUNT_ID, CLOUDFLARE_TEST_BUCKET and CLOUDFLARE_TEST_API_TOKEN")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
	defer cancel()
	bucket, err := New(nil).CreateBucket(ctx, token, account, name)
	if err != nil || bucket.Name != name {
		t.Fatalf("creation/readback was not confirmed: %v", err)
	}
	t.Logf("created and read back private bucket %s", bucket.Name)
}
