package receipt

import (
	"encoding/base64"
	"strings"
	"testing"
	"time"

	sign "github.com/xxww0098/podhub-go/internal/platform/r2/sigv4"
)

func TestIssueAndVerify(t *testing.T) {
	now := time.Date(2026, 10, 15, 12, 0, 0, 0, time.UTC)
	account := testAccount()
	workspace := int64(7)
	object := Object{
		Key:         "images/teams/550e8400-e29b-41d4-a716-446655440000/sha256/" + strings.Repeat("ab", 32) + ".jpg",
		ContentType: "image/jpeg",
		ByteLength:  12,
		SHA256:      strings.Repeat("ab", 32),
	}
	subject := Subject{Purpose: "a<b", ActorID: 3, WorkspaceID: &workspace}
	target, err := Issue(account, subject, object, now, true, nil)
	if err != nil {
		t.Fatal(err)
	}
	payload, _, ok := strings.Cut(target.Ticket, ".")
	if !ok {
		t.Fatal("ticket")
	}
	raw, err := base64.RawURLEncoding.DecodeString(payload)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(raw), `\u003c`) || !strings.Contains(string(raw), "a<b") {
		t.Fatalf("payload escaped HTML: %s", raw)
	}
	if strings.Contains(string(raw), "multipart_upload_id") || strings.Contains(string(raw), "no_body_read") {
		t.Fatalf("empty optional fields must be omitted: %s", raw)
	}
	if !strings.Contains(string(raw), `"checksum_enforced":true`) {
		t.Fatalf("enforced checksum must be present: %s", raw)
	}
	got, err := Verify(account, target.Ticket, subject, now.Add(time.Hour))
	if err != nil || got.Key != object.Key || got.SHA256 != object.SHA256 {
		t.Fatalf("%+v %v", got, err)
	}
	if _, err := Verify(account, target.Ticket, subject, now.Add(4*time.Hour)); err != ErrInvalid {
		t.Fatalf("expired ticket: %v", err)
	}
	other := subject
	other.ActorID = 4
	if _, err := Verify(account, target.Ticket, other, now); err != ErrInvalid {
		t.Fatal("actor mismatch must fail")
	}
	tampered := target.Ticket[:len(target.Ticket)-1] + "A"
	if _, err := Verify(account, tampered, subject, now); err != ErrInvalid {
		t.Fatal("tampered mac must fail")
	}
}

func TestStorageIdentityChangesWithTheBucket(t *testing.T) {
	left := StorageIdentity(testAccount())
	right := testAccount()
	right.Bucket = "other"
	if left == "" || left == StorageIdentity(right) {
		t.Fatal("storage identity must follow the bucket")
	}
}

func TestUppercaseDigestIsRejected(t *testing.T) {
	object := Object{
		Key: "k", ContentType: "image/jpeg", ByteLength: 1,
		SHA256: strings.Repeat("AB", 32),
	}
	_, err := Issue(testAccount(), Subject{Purpose: "p", ActorID: 1}, object, time.Now(), false, nil)
	if err != ErrInvalid {
		t.Fatalf("got %v", err)
	}
}

func testAccount() sign.Account {
	return sign.Account{
		ID: "acct", Provider: sign.ProviderCloudflare,
		Endpoint: "https://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.r2.cloudflarestorage.com",
		Region:   "auto", Bucket: "podhub-slices", ForcePathStyle: true,
		AccessKeyID: "AKID", SecretAccessKey: "secret",
		PublicBaseURL: "https://cdn.example",
	}
}
