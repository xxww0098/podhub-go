package fence

import (
	"strings"
	"testing"
)

const (
	workspace = "550e8400-e29b-41d4-a716-446655440000"
	digest    = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
	probe     = "aa7bb0431aaeb198a77c26a14fe6dd714a75e4d7db94e3e1238a1fdcbfe1f8d4"
)

func TestImageKeyAndIdentity(t *testing.T) {
	key := "images/teams/" + workspace + "/sha256/" + digest + ".jpg"
	if !IsGCImageKey(key) {
		t.Fatal("image key")
	}
	if ImageIdentity(key) != workspace+":"+digest {
		t.Fatalf("identity %s", ImageIdentity(key))
	}
	upper := strings.ToUpper(key)
	if ImageIdentity(upper) != workspace+":"+digest {
		t.Fatal("identity is lowercase")
	}
	if IsGCImageKey("videos/teams/" + workspace + "/sha256/" + digest + ".mp4") {
		t.Fatal("video is not an image GC key")
	}
	if IsGCImageKey("images/teams/" + workspace + "/sha256/" + probe + ".png") {
		t.Fatal("healthcheck is not an image lease")
	}
	if IsGCImageKey("images/./teams/" + workspace + "/sha256/" + digest + ".jpg") {
		t.Fatal("dot segment")
	}
	if ImageIdentity("notes") != "" {
		t.Fatal("ordinary text has no identity")
	}
}

func TestCandidates(t *testing.T) {
	other := "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
	text := "see teams/" + strings.ToUpper(workspace) + "/sha256/" + digest + ".jpg and workspaces/" + workspace + "/sha256/" + other + ".png?x=1"
	got := Candidates(text)
	if len(got) != 2 || got[0].Digest != digest || got[1].Digest != other || got[0].Workspace != workspace {
		t.Fatalf("%+v", got)
	}
	again := Candidates(text + " " + text)
	if len(again) != 2 {
		t.Fatal("candidates are distinct")
	}
}
