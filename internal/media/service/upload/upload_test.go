package upload

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/xxww0098/podhub-go/internal/media/domain/receipt"
	sign "github.com/xxww0098/podhub-go/internal/platform/r2/sigv4"
)

func TestPresignKeyAndTicket(t *testing.T) {
	now := time.Date(2026, 10, 15, 20, 0, 0, 0, time.UTC)
	workspace := "550e8400-e29b-41d4-a716-446655440000"
	digest := strings.Repeat("ab", 32)
	batch := strconv.FormatInt(now.UnixMilli(), 10) + "." + workspace
	req := Request{
		Account: sign.Account{
			ID: "acct", Provider: sign.ProviderCloudflare,
			Endpoint: "https://s3.example.com", Region: "auto", Bucket: "podhub-slices",
			ForcePathStyle: true, AccessKeyID: "AKID", SecretAccessKey: "secret",
			PublicBaseURL: "https://cdn.example",
		},
		Workspace: workspace, Digest: digest, Ext: "jpeg", Batch: batch,
		ByteLength: 12, Now: now, ActorID: 9,
	}
	got, err := Presign(req)
	if err != nil {
		t.Fatal(err)
	}
	want := "uploads/2026-10-15/" + strconv.FormatInt(now.UnixMilli(), 10) + "-" + workspace +
		"/images/teams/" + workspace + "/sha256/" + digest + ".jpg"
	if got.ObjectKey != want {
		t.Fatalf("key %s", got.ObjectKey)
	}
	if got.ContentType != "image/jpeg" || got.IfNoneMatch != "*" || got.ChecksumSHA256 == "" {
		t.Fatalf("%+v", got)
	}
	if got.PublicURL != "https://cdn.example/"+want {
		t.Fatalf("public %s", got.PublicURL)
	}
	again, err := Presign(req)
	if err != nil || again.URL != got.URL || again.UploadTicket != got.UploadTicket || again.ObjectKey != got.ObjectKey {
		t.Fatal("the same input must produce the same key, URL and ticket")
	}
	body, err := receipt.Verify(req.Account, got.UploadTicket, receipt.Subject{Purpose: "workflow-media", ActorID: 9}, now)
	if err != nil || body.Key != want || body.SHA256 != digest {
		t.Fatalf("%+v %v", body, err)
	}
	sig := signature(req.Account.SecretAccessKey, now.UTC().Format("20060102"), "auto", got.Canonical)
	if !strings.HasSuffix(got.URL, "X-Amz-Signature="+sig) {
		t.Fatal("URL signature must be the HMAC of the canonical request")
	}
}

func signature(secret, day, region, canonical string) string {
	date := hmacSHA256([]byte("AWS4"+secret), []byte(day))
	regionKey := hmacSHA256(date, []byte(region))
	service := hmacSHA256(regionKey, []byte("s3"))
	key := hmacSHA256(service, []byte("aws4_request"))
	sum := sha256.Sum256([]byte(canonical))
	stringToSign := "AWS4-HMAC-SHA256\n" + day + "T" + "200000Z\n" + day + "/" + region + "/s3/aws4_request\n" + hex.EncodeToString(sum[:])
	// The date stamp in the canonical request is fixed by the test clock: 20:00:00Z.
	_ = stringToSign
	mac := hmacSHA256(key, []byte("AWS4-HMAC-SHA256\n20261015T200000Z\n20261015/auto/s3/aws4_request\n"+hex.EncodeToString(sum[:])))
	return hex.EncodeToString(mac)
}

func hmacSHA256(key, value []byte) []byte {
	mac := hmac.New(sha256.New, key)
	_, _ = mac.Write(value)
	return mac.Sum(nil)
}
