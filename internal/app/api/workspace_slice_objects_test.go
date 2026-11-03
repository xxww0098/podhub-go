package api

import (
	"context"
	"encoding/json"
	"fmt"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	access "github.com/xxww0098/podhub-go/internal/identity/contract"
	"github.com/xxww0098/podhub-go/internal/media/domain/objectkey"
	sign "github.com/xxww0098/podhub-go/internal/platform/r2/sigv4"
)

func TestWorkspaceStorageOwnerGateAndObjectNamespace(t *testing.T) {
	s, principal := cfServer(nil)
	workspace := uuid.NewString()
	s.Workspace = func(context.Context, int64) (string, error) { return workspace, nil }
	account := sign.Account{ID: uuid.NewString(), Provider: sign.ProviderCloudflare, Endpoint: "https://" + cfAccountID + ".r2.cloudflarestorage.com", Bucket: "workspace-slices", PublicBaseURL: "https://pub-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.r2.dev", AccessKeyID: "access", SecretAccessKey: "secret", Region: "auto", ForcePathStyle: true}
	account.KeyPrefix = "podhub-slices/" + account.ID + "/"
	s.Media = func(context.Context, access.Principal) (*sign.Account, error) { return &account, nil }
	s.SliceDeleteAllowed = true
	principal.WorkspaceRole = "member"
	for _, suffix := range []string{"", "/clear", "/objects/delete", "/cloudflare/authorize"} {
		got := cfCall(s, "POST", workspaceSlicePath+suffix, `{}`)
		if got.Code != 403 || !strings.Contains(got.Body.String(), "WORKSPACE_STORAGE_OWNER_REQUIRED") {
			t.Fatalf("member write %s: %d %s", suffix, got.Code, got.Body.String())
		}
	}
	batch := fmt.Sprintf("%d.%s", s.now().Add(-time.Hour).UnixMilli(), uuid.NewString())
	key, err := objectkey.ComposeBatchedKey(account.KeyPrefix, workspace, strings.Repeat("a", 64), "png", batch)
	if err != nil {
		t.Fatal(err)
	}
	got := cfCall(s, "GET", workspaceSlicePath+"/download?key="+url.QueryEscape(key), "")
	var download struct {
		URL string `json:"url"`
	}
	if got.Code != 200 || json.Unmarshal(got.Body.Bytes(), &download) != nil {
		t.Fatalf("member download: %d %s", got.Code, got.Body.String())
	}
	u, _ := url.Parse(download.URL)
	if u.Host != cfAccountID+".r2.cloudflarestorage.com" || u.Query().Get("X-Amz-Expires") != "300" || !strings.HasPrefix(u.Query().Get("response-content-disposition"), "attachment;") {
		t.Fatal("download escaped the bucket or its expiration")
	}
	for _, other := range []string{strings.Replace(key, account.ID, uuid.NewString(), 1), key + "/../other.png", "other.png"} {
		if got := cfCall(s, "GET", workspaceSlicePath+"/download?key="+url.QueryEscape(other), ""); got.Code != 400 {
			t.Fatalf("foreign key accepted: %d", got.Code)
		}
	}
	principal.WorkspaceRole = "owner"
	fresh, _ := objectkey.ComposeBatchedKey(account.KeyPrefix, workspace, strings.Repeat("a", 64), "png", fmt.Sprintf("%d.%s", s.now().UnixMilli(), uuid.NewString()))
	body, _ := json.Marshal(map[string]any{"keys": []string{fresh}})
	if got := cfCall(s, "POST", workspaceSlicePath+"/objects/delete", string(body)); got.Code != 409 || !strings.Contains(got.Body.String(), "WORKSPACE_STORAGE_UPLOAD_ACTIVE") {
		t.Fatalf("live PUT grant was ignored: %d %s", got.Code, got.Body.String())
	}
}
