package domain

import (
	"strings"
	"testing"
	"time"
)

func TestParseUploadKeyTranscribesTheBatchShape(t *testing.T) {
	const (
		ms        = int64(1700000000000)
		workspace = "11111111-1111-4111-8111-111111111111"
		batch     = "22222222-2222-4222-8222-222222222222"
	)
	date := time.UnixMilli(ms).UTC().Format("2006-01-02")
	digest := strings.Repeat("a", 64)
	key := "https://cdn.example/uploads/" + date + "/" + "1700000000000-" + batch +
		"/images/teams/" + workspace + "/sha256/" + digest + ".jpg"
	got, ok := ParseUploadKey(key)
	if !ok || got.WorkspaceUUID != workspace || got.BatchMS != ms {
		t.Fatalf("%+v %v", got, ok)
	}
	if _, ok := ParseUploadKey(strings.Replace(key, "/uploads/", "/uploads/../", 1)); ok {
		t.Fatal("dotdot")
	}
	if _, ok := ParseUploadKey("https://media.example.invalid/hero.jpg"); ok {
		t.Fatal("foreign")
	}
	if skip, hit := ImageIssue([]string{key}, strings.ToUpper(workspace), ms+1000); hit {
		t.Fatal(skip)
	}
	if skip, hit := ImageIssue([]string{key}, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", ms); !hit || skip != MediaForeign {
		t.Fatal(skip, hit)
	}
	if skip, hit := ImageIssue([]string{key}, workspace, ms+int64(SubmitMaxAgeDays)*24*60*60*1000+1); !hit || skip != MediaExpired {
		t.Fatal(skip, hit)
	}
	if _, hit := ImageIssue([]string{"", "  "}, workspace, ms); hit {
		t.Fatal("blank urls are not foreign")
	}
}
