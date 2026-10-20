package domain

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/sha256"
	"strings"
	"testing"
)

func TestPaths(t *testing.T) {
	prefix, err := NormalizeKeyPrefix(" /ozon-pod/ ")
	if err != nil || prefix != "ozon-pod/" {
		t.Fatal(prefix, err)
	}
	if _, err := NormalizeKeyPrefix(`a\b`); err != ErrPrefix {
		t.Fatal(err)
	}
	if _, err := RelativePath("", false); err != ErrPathEmpty {
		t.Fatal(err)
	}
	if got, err := RelativePath("", true); err != nil || got != "" {
		t.Fatal(got, err)
	}
	if _, err := RelativePath("/a", false); err != ErrPathShape {
		t.Fatal(err)
	}
	if _, err := RelativePath("C:/a", false); err != ErrPathShape {
		t.Fatal(err)
	}
	if _, err := RelativePath("a/.direct-uploads/b", false); err != ErrReserved {
		t.Fatal(err)
	}
	if _, err := RelativePath("photo.verified", false); err != ErrReserved {
		t.Fatal(err)
	}
	if got, err := RelativePath("image.verified.png", false); err != nil || got != "image.verified.png" {
		t.Fatalf("got %q %v", got, err)
	}
	if !HasDirectUploadSegment("a/.direct-uploads/b") || HasDirectUploadSegment("a/file.verified") {
		t.Fatal("stage segment")
	}
	key, err := ObjectKey("ozon-pod/", "a/b")
	if err != nil || key != "ozon-pod/a/b" {
		t.Fatal(key, err)
	}
	dir, err := DirectoryPrefix("ozon-pod/", "a")
	if err != nil || dir != "ozon-pod/a/" {
		t.Fatal(dir, err)
	}
	empty := ""
	if err := ParseMediaCursor(&empty); err != ErrCursor {
		t.Fatal(err)
	}
	if err := ParseMediaCursor(nil); err != nil {
		t.Fatal(err)
	}
	if _, err := NormalizeListPrefix("ozon-pod/", "other/"); err != ErrPrefixInside {
		t.Fatal(err)
	}
	if err := ContentType(" text/plain"); err != ErrContentType {
		t.Fatal(err)
	}
	if err := ContentType("text/plain"); err != nil {
		t.Fatal(err)
	}
}

func TestListXMLAndGroups(t *testing.T) {
	page := ParseListPage(`<List><Contents><Key>a&amp;lt;b</Key><Size>2</Size></Contents><Contents><Key></Key><Size>1</Size></Contents><CommonPrefixes><Prefix>p&amp;amp;</Prefix></CommonPrefixes><IsTruncated>true</IsTruncated><NextContinuationToken>n&amp;x</NextContinuationToken></List>`)
	if len(page.Contents) != 1 || page.Contents[0].Key != "a&lt;b" || page.Contents[0].Size != 2 {
		t.Fatalf("%+v", page.Contents)
	}
	if len(page.Prefixes) != 1 || page.Prefixes[0] != "p&amp;" || !page.Truncated || page.NextToken != "n&x" {
		t.Fatalf("%+v", page)
	}
	bad := ParseListPage(`<Contents><Key>z</Key><Size>nope</Size></Contents>`)
	if len(bad.Contents) != 1 || bad.Contents[0].Size != 0 {
		t.Fatal(bad.Contents)
	}
	id := "11111111-1111-4111-8111-111111111111"
	groups, objects, bytes, truncated := GroupRows("root/", []ListedObject{
		{Key: "root/images/teams/" + id + "/a", Size: 5},
		{Key: "root/images/teams/" + id + "/b", Size: 5},
		{Key: "root/loose", Size: 1},
		{Key: "root/teams/" + strings.ToUpper(id) + "/c", Size: 9},
	})
	if objects != 4 || bytes != 20 || truncated {
		t.Fatal(objects, bytes, truncated)
	}
	if groups[0].Bytes != 10 || groups[0].UUID != id || groups[0].Objects != 2 {
		t.Fatalf("%+v", groups[0])
	}
	if groups[1].Prefix != "root/teams/"+strings.ToUpper(id)+"/" || groups[1].UUID != id {
		t.Fatalf("%+v", groups[1])
	}
	if groups[2].WorkspaceName != "其他" || groups[2].Bytes != 1 {
		t.Fatalf("%+v", groups[2])
	}
}

func TestSnapshotAndAccounts(t *testing.T) {
	secret := strings.Repeat("k", 32)
	plain := []byte(`{"schemaVersion":1,"storageBuckets":[{"id":"a","role":"transit","bucket":"podhub-transit","active":true,"keyPrefix":"ozon/"},{"id":"b","role":"assets","bucket":"podhub-assets","active":true}]}`)
	nonce := []byte("0123456789ab")
	sealed, err := SealSnapshot(secret, nonce, plain)
	if err != nil {
		t.Fatal(err)
	}
	accounts, err := OpenSnapshot(secret, nonce, sealed)
	if err != nil || len(accounts) != 2 || accounts[0].Provider != "legacy_s3" {
		t.Fatal(err, accounts)
	}
	if _, err := OpenSnapshot("short", nonce, sealed); err != ErrKeyMissing {
		t.Fatal(err)
	}
	if _, err := OpenSnapshot(exampleKey, nonce, sealed); err != ErrKeyExample {
		t.Fatal(err)
	}
	if _, err := OpenSnapshot(secret, []byte("short"), sealed); err != ErrSnapshot {
		t.Fatal(err)
	}
	legacy, err := sealBare(secret, nonce, plain)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := OpenSnapshot(secret, nonce, legacy); err != nil {
		t.Fatal(err)
	}
	chosen, err := ResolveAccount(accounts, nil)
	if err != nil || chosen.ID != "a" {
		t.Fatal(chosen, err)
	}
	inactive := []CloudAccount{{ID: "a", Bucket: "podhub-transit", Active: false}}
	if _, err := ResolveAccount(inactive, nil); err != ErrNoConfig {
		t.Fatal(err)
	}
	id := " missing "
	if _, err := ResolveAccount(accounts, &id); err != ErrAccount {
		t.Fatal(err)
	}
	want := "b"
	got, err := ResolveAccount(accounts, &want)
	if err != nil || got.ID != "b" {
		t.Fatal(got, err)
	}
	if err := RequirePersistent(got); err != nil {
		t.Fatal(err)
	}
	if err := RequirePersistent(CloudAccount{Role: "transit", Bucket: "podhub-transit"}); err != ErrTransit {
		t.Fatal(err)
	}
	if err := RequirePersistent(CloudAccount{Role: "assets", Bucket: "podhub-assets"}); err != nil {
		t.Fatal(err)
	}
}

func sealBare(secret string, nonce, plain []byte) ([]byte, error) {
	sum := sha256.Sum256([]byte(secret))
	block, err := aes.NewCipher(sum[:])
	if err != nil {
		return nil, err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}
	return gcm.Seal(nil, nonce, plain, nil), nil
}
