package slicepurge

import (
	"crypto/sha256"
	"encoding/hex"
	"testing"
)

func TestFingerprintIsThePhysicalIdentity(t *testing.T) {
	namespace := "0123456789abcdef0123456789abcdef"
	account := Account{
		Role: "transit", Provider: "cloudflare",
		Endpoint: "https://" + namespace + ".r2.cloudflarestorage.com",
		Region:   "auto", Bucket: "podhub-transit", ForcePathStyle: true,
		AccessKeyID: "k", SecretAccessKey: "s",
	}
	got, err := Fingerprint(account)
	if err != nil {
		t.Fatal(err)
	}
	sum := sha256.Sum256([]byte("storage-bucket:v1\x00https://" + namespace + ".r2.cloudflarestorage.com\x00podhub-transit\x00"))
	if got != hex.EncodeToString(sum[:]) {
		t.Fatalf("got %s", got)
	}
	// Credentials and labels are not part of the identity: rotating a key
	// must not reset the day's continuity.
	rotated := account
	rotated.AccessKeyID, rotated.SecretAccessKey = "other", "other"
	if again, err := Fingerprint(rotated); err != nil || again != got {
		t.Fatalf("rotation changed the identity: %v %s", err, again)
	}
	account.Endpoint = "http://127.0.0.1:9000"
	if _, err := Fingerprint(account); err != nil {
		t.Fatalf("the loopback fake bucket is a valid drill target: %v", err)
	}
	account.Endpoint = "https://" + namespace + ".r2.cloudflarestorage.com"
	account.Provider = "qiniu"
	if _, err := Fingerprint(account); Code(err) != "slice_provider_invalid" {
		t.Fatal(err)
	}
	account.Provider = "cloudflare"
	account.Bucket = "podhub-transit/extra"
	if _, err := Fingerprint(account); Code(err) != "slice_bucket_invalid" {
		t.Fatal(err)
	}
}

func TestSelectTargetsKeepsOneTransitBucket(t *testing.T) {
	namespace := "0123456789abcdef0123456789abcdef"
	base := Account{
		Role: "transit", Provider: "generic",
		Endpoint: "https://" + namespace + ".r2.cloudflarestorage.com",
		Region:   "auto", Bucket: "podhub-transit", ForcePathStyle: true,
		AccessKeyID: "k", SecretAccessKey: "s", KeyPrefix: "ignore/",
	}
	selected, err := SelectTargets([]Account{
		base,
		{Role: "assets", Provider: "cloudflare", Endpoint: base.Endpoint, Region: "auto", Bucket: "podhub-assets", ForcePathStyle: true, AccessKeyID: "k", SecretAccessKey: "s"},
	})
	if err != nil || len(selected) != 1 || selected[0].Bucket != "podhub-transit" || selected[0].KeyPrefix != "" {
		t.Fatalf("%v %+v", err, selected)
	}
	// Two transit accounts are ambiguous and refuse the whole set.
	if _, err := SelectTargets([]Account{base, base}); Code(err) != "slice_target_duplicate" {
		t.Fatal(err)
	}
	weak := base
	weak.SecretAccessKey = ""
	if _, err := SelectTargets([]Account{weak}); Code(err) != "slice_credentials_invalid" {
		t.Fatal(err)
	}
	fake := FakeFingerprint("podhub-transit")
	real, _ := Fingerprint(base)
	if fake == real {
		t.Fatal("fake receipt key collided with a real fingerprint")
	}
}
