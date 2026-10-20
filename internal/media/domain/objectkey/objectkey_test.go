package objectkey

import (
	"strconv"
	"strings"
	"testing"
	"time"
)

const workspace = "550e8400-e29b-41d4-a716-446655440000"
const digest = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"

func TestComposeAndParseRoundTrip(t *testing.T) {
	key, err := ComposeKey("root", ClassImage, " "+strings.ToUpper(workspace)+" ", digest, "jpeg")
	if err != nil {
		t.Fatal(err)
	}
	want := "root/images/teams/" + workspace + "/sha256/" + digest + ".jpg"
	if key != want {
		t.Fatalf("key %s", key)
	}
	ref, ok := ParseRef(key)
	if !ok || ref.Class != ClassImage || ref.Workspace != workspace || ref.Digest != digest {
		t.Fatalf("ref %+v %v", ref, ok)
	}
	if !KeyMatches(key, workspace, strings.ToUpper(digest)) {
		t.Fatal("key must match its own workspace and digest")
	}
	if KeyMatches("myteams/"+workspace+"/sha256/"+digest+".jpg", workspace, digest) {
		t.Fatal("myteams is a different object")
	}
}

func TestBatchedKeyMatchesRustShape(t *testing.T) {
	issued := time.Date(2026, 10, 15, 20, 0, 0, 0, time.UTC)
	ms := issued.UnixMilli()
	id := workspace
	raw := strconv.FormatInt(ms, 10) + "." + id
	key, err := ComposeBatchedKey("", workspace, digest, "png", raw)
	if err != nil {
		t.Fatal(err)
	}
	want := "uploads/2026-10-15/" + strconv.FormatInt(ms, 10) + "-" + id + "/images/teams/" + workspace + "/sha256/" + digest + ".png"
	if key != want {
		t.Fatalf("got %s", key)
	}
	parsed, ok := ParseUploadKey(key)
	if !ok || parsed.BatchMS != ms || parsed.Ext != "png" || parsed.Digest != digest {
		t.Fatalf("%+v %v", parsed, ok)
	}
	if BatchIdentity(key) != strconv.FormatInt(ms, 10)+"-"+id {
		t.Fatal(BatchIdentity(key))
	}
	if _, ok := ParseUploadKey(key + "/../x"); ok {
		t.Fatal("dot segment must not parse")
	}
	if _, ok := ParseUploadKey("images/teams/old/sha256/old.jpg"); ok {
		t.Fatal("legacy key is not a batch key")
	}
}

func TestLastSha256Wins(t *testing.T) {
	other := "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
	value := "teams/" + workspace + "/sha256/" + digest + ".jpg/teams/" + workspace + "/sha256/" + other + ".png"
	ref, ok := ParseRef(value)
	if !ok || ref.Digest != other || ref.Class != ClassImage {
		t.Fatalf("%+v %v", ref, ok)
	}
}

func TestHealthcheckDigestIsTheSQLConstant(t *testing.T) {
	const want = "aa7bb0431aaeb198a77c26a14fe6dd714a75e4d7db94e3e1238a1fdcbfe1f8d4"
	if HealthcheckDigest() != want {
		t.Fatalf("digest %s", HealthcheckDigest())
	}
	if !IsHealthcheckDigest(strings.ToUpper(want)) {
		t.Fatal("probe digest is case-insensitive")
	}
}

func TestEncodeKeepsSlash(t *testing.T) {
	if got := EncodeObjectPath("a b/c"); got != "a%20b/c" {
		t.Fatal(got)
	}
	if got := EncodePathSegment("a/b"); got != "a%2Fb" {
		t.Fatal(got)
	}
}
