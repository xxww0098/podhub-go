package integration

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/xxww0098/podhub-go/internal/app"
)

type catalogPromptEnvelope struct {
	Data struct {
		Prompts []struct {
			PromptID      string    `json:"prompt_id"`
			Content       *string   `json:"content"`
			FixedTags     *[]string `json:"fixed_tags"`
			TypeID        int64     `json:"type_id"`
			DescriptionID int64     `json:"description_category_id"`
		} `json:"prompts"`
	} `json:"data"`
}

type catalogVideoEnvelope struct {
	Data struct {
		Videos []struct {
			VideoID       string `json:"video_id"`
			Name          string `json:"name"`
			VideoURL      string `json:"video_url"`
			DurationMS    int64  `json:"duration_ms"`
			DescriptionID int64  `json:"description_category_id"`
			TypeID        int64  `json:"type_id"`
		} `json:"videos"`
	} `json:"data"`
}

func TestCatalogPromptAndVideoReads(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Minute)
	defer cancel()
	pool := migratedPool(t, ctx)
	t.Setenv("CLOUD_SELLER_CREDENTIAL_KEY", "catalog-assets-test-key")
	t.Setenv("CLOUD_COOKIE_SECURE", "0")

	if _, err := pool.Exec(ctx, "INSERT INTO account_users "+
		"(public_id,email,password_hash,role,name,target,supplier_id,plan,created_at,updated_at) "+
		"VALUES ('00000000-0000-4000-8000-000000009995','catalog-assets-owner@example.invalid','x','super_admin','Owner','/workspace','','free',clock_timestamp(),clock_timestamp())"); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, "UPDATE platform_initialization SET owner_account_id="+
		"(SELECT id FROM account_users WHERE email='catalog-assets-owner@example.invalid'),initialized_at=clock_timestamp() WHERE singleton"); err != nil {
		t.Fatal(err)
	}

	handler := app.Handler(pool)
	email := "catalog-reader@catalog-assets.example"
	payload, _ := json.Marshal(map[string]string{"email": email, "password": "workspace-test-pass-1", "name": "Catalog Reader"})
	rec := postJSON(t, handler, "/api/auth/register", string(payload), "catalog-reader-register", "")
	if rec.Code != http.StatusOK {
		t.Fatalf("register: %d %s", rec.Code, rec.Body.String())
	}
	cookies := rec.Header().Values("Set-Cookie")
	if len(cookies) == 0 {
		t.Fatal("register returned no cookie")
	}
	cookie := strings.Split(cookies[0], ";")[0]

	defer pool.Exec(ctx, "DELETE FROM category_prompts WHERE prompt_id IN ('catalog-read-prompt','catalog-read-staff-prompt')")
	defer pool.Exec(ctx, "DELETE FROM category_videos WHERE video_id='catalog-read-video'")
	tags, _ := json.Marshal([]string{"#tag"})
	if _, err := pool.Exec(ctx, "INSERT INTO category_prompts "+
		"(prompt_id,description_category_id,type_id,name,file_name,content,created_at_ms,updated_at_ms,created_by_account_uuid,fixed_tags) "+
		"VALUES ('catalog-read-prompt',17027999,91999,'Read Prompt','read.txt','secret prompt content',1,2,'test',$1)", tags); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, "INSERT INTO category_videos "+
		"(video_id,description_category_id,type_id,name,video_url,duration_ms,created_at_ms,updated_at_ms,created_by_account_uuid) "+
		"VALUES ('catalog-read-video',17027999,91999,'Read Video','https://cdn.example.invalid/read.mp4',1500,1,2,'test')"); err != nil {
		t.Fatal(err)
	}

	leaves := get(t, handler, "/api/prompts/categories", cookie)
	if leaves.Code != http.StatusOK {
		t.Fatalf("leaves: %d %s", leaves.Code, leaves.Body.String())
	}
	if !strings.Contains(leaves.Body.String(), `"description_category_id":17027999`) {
		t.Fatalf("leaves missing fixture: %s", leaves.Body.String())
	}

	prompts := get(t, handler, "/api/prompts/category/17027999/91999", cookie)
	if prompts.Code != http.StatusOK {
		t.Fatalf("prompts: %d %s", prompts.Code, prompts.Body.String())
	}
	var promptBody catalogPromptEnvelope
	if err := json.Unmarshal(prompts.Body.Bytes(), &promptBody); err != nil {
		t.Fatal(err)
	}
	if len(promptBody.Data.Prompts) != 1 {
		t.Fatalf("prompts = %d, want 1: %s", len(promptBody.Data.Prompts), prompts.Body.String())
	}
	prompt := promptBody.Data.Prompts[0]
	if prompt.Content != nil || prompt.FixedTags != nil {
		t.Fatalf("operator must not receive prompt content: %+v", prompt)
	}
	if prompt.PromptID != "catalog-read-prompt" || prompt.DescriptionID != 17027999 || prompt.TypeID != 91999 {
		t.Fatalf("prompt fields: %+v", prompt)
	}

	if _, err := pool.Exec(ctx, "UPDATE account_users SET role='admin' WHERE email=$1", email); err != nil {
		t.Fatal(err)
	}
	staffPrompts := get(t, handler, "/api/prompts/category/17027999/91999", cookie)
	if staffPrompts.Code != http.StatusOK {
		t.Fatalf("staff prompts: %d %s", staffPrompts.Code, staffPrompts.Body.String())
	}
	if !strings.Contains(staffPrompts.Body.String(), `"content":"secret prompt content"`) {
		t.Fatalf("staff prompt content missing: %s", staffPrompts.Body.String())
	}

	videos := get(t, handler, "/api/videos/category/17027999/91999", cookie)
	if videos.Code != http.StatusOK {
		t.Fatalf("videos: %d %s", videos.Code, videos.Body.String())
	}
	var videoBody catalogVideoEnvelope
	if err := json.Unmarshal(videos.Body.Bytes(), &videoBody); err != nil {
		t.Fatal(err)
	}
	if len(videoBody.Data.Videos) != 1 || videoBody.Data.Videos[0].VideoID != "catalog-read-video" || videoBody.Data.Videos[0].DurationMS != 1500 {
		t.Fatalf("videos: %s", videos.Body.String())
	}

	if rec := get(t, handler, "/api/prompts/category/17027999/91999", ""); rec.Code != http.StatusUnauthorized {
		t.Fatalf("unauthenticated prompt read = %d, want 401", rec.Code)
	}
	if rec := get(t, handler, "/api/videos/category/not-a-number/91999", cookie); rec.Code != http.StatusBadRequest {
		t.Fatalf("bad video coordinate = %d, want 400", rec.Code)
	}
}
