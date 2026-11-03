package integration

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"image"
	"image/color"
	"image/jpeg"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/xxww0098/podhub-go/internal/app"
)

type avatarTargetEnvelope struct {
	Data struct {
		UploadTicket string `json:"upload_ticket"`
		Upload       *struct {
			URL     string `json:"url"`
			Headers struct {
				ContentType string `json:"content_type"`
				IfNoneMatch string `json:"if_none_match"`
			} `json:"headers"`
		} `json:"upload"`
	} `json:"data"`
}

func testJPEG(t *testing.T) []byte {
	t.Helper()
	img := image.NewRGBA(image.Rect(0, 0, 2, 2))
	img.Set(0, 0, color.RGBA{R: 220, G: 40, B: 20, A: 255})
	var buf bytes.Buffer
	if err := jpeg.Encode(&buf, img, &jpeg.Options{Quality: 80}); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

func TestAvatarReadWriteFlow(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Minute)
	defer cancel()
	pool := migratedPool(t, ctx)
	t.Setenv("CLOUD_SELLER_CREDENTIAL_KEY", "avatar-test-key")
	t.Setenv("CLOUD_COOKIE_SECURE", "0")
	t.Setenv("CLOUD_PUBLIC_URL", "http://127.0.0.1:18080")

	if _, err := pool.Exec(ctx, "INSERT INTO account_users "+
		"(public_id,email,password_hash,role,name,target,supplier_id,plan,created_at,updated_at) "+
		"VALUES ('00000000-0000-4000-8000-000000009996','avatar-owner@example.invalid','x','super_admin','Owner','/workspace','','free',clock_timestamp(),clock_timestamp())"); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, "UPDATE platform_initialization SET owner_account_id="+
		"(SELECT id FROM account_users WHERE email='avatar-owner@example.invalid'),initialized_at=clock_timestamp() WHERE singleton"); err != nil {
		t.Fatal(err)
	}

	handler := app.Handler(pool)
	email := "avatar-reader@avatar.example"
	payload, _ := json.Marshal(map[string]string{"email": email, "password": "workspace-test-pass-1", "name": "Avatar Reader"})
	rec := postJSON(t, handler, "/api/auth/register", string(payload), "avatar-reader-register", "")
	if rec.Code != http.StatusOK {
		t.Fatalf("register: %d %s", rec.Code, rec.Body.String())
	}
	cookies := rec.Header().Values("Set-Cookie")
	if len(cookies) == 0 {
		t.Fatal("register returned no cookie")
	}
	cookie := strings.Split(cookies[0], ";")[0]
	workspaceID := workspaceIDForEmail(t, handler, cookie, email)

	imageBytes := testJPEG(t)
	sum := sha256.Sum256(imageBytes)
	spec, _ := json.Marshal(map[string]any{"bytes": len(imageBytes), "sha256": hex.EncodeToString(sum[:]), "content_type": "image/jpeg"})
	init := postJSON(t, handler, fmt.Sprintf("/api/avatars/workspaces/%d/upload", workspaceID), string(spec), "avatar-init", cookie)
	if init.Code != http.StatusOK {
		t.Fatalf("avatar init: %d %s", init.Code, init.Body.String())
	}
	var target avatarTargetEnvelope
	if err := json.Unmarshal(init.Body.Bytes(), &target); err != nil {
		t.Fatal(err)
	}
	if target.Data.UploadTicket == "" || target.Data.Upload == nil || !strings.HasPrefix(target.Data.Upload.URL, "http://127.0.0.1:18080/") {
		t.Fatalf("avatar target: %s", init.Body.String())
	}
	grantURL, err := url.Parse(target.Data.Upload.URL)
	if err != nil {
		t.Fatal(err)
	}
	put := func(body []byte) int {
		req := httptest.NewRequest(http.MethodPut, grantURL.RequestURI(), bytes.NewReader(body))
		req.Header.Set("Content-Type", "image/jpeg")
		req.Header.Set("If-None-Match", "*")
		out := httptest.NewRecorder()
		handler.ServeHTTP(out, req)
		return out.Code
	}
	if code := put(imageBytes); code != http.StatusOK {
		t.Fatalf("avatar bytes = %d", code)
	}
	if code := put(imageBytes); code != http.StatusPreconditionFailed {
		t.Fatalf("avatar bytes replay = %d, want 412", code)
	}

	confirm, _ := json.Marshal(map[string]string{"upload_ticket": target.Data.UploadTicket})
	confirmReq := httptest.NewRequest(http.MethodPut, fmt.Sprintf("/api/avatars/workspaces/%d", workspaceID), bytes.NewReader(confirm))
	confirmReq.Header.Set("Content-Type", "application/json")
	confirmReq.Header.Set("Cookie", cookie)
	confirmed := httptest.NewRecorder()
	handler.ServeHTTP(confirmed, confirmReq)
	if confirmed.Code != http.StatusOK {
		t.Fatalf("avatar confirm: %d %s", confirmed.Code, confirmed.Body.String())
	}
	if !strings.Contains(confirmed.Body.String(), `"avatar_revision"`) {
		t.Fatalf("avatar confirm body: %s", confirmed.Body.String())
	}

	read := get(t, handler, fmt.Sprintf("/api/avatars/workspaces/%d", workspaceID), cookie)
	if read.Code != http.StatusOK || read.Header().Get("Content-Type") != "image/jpeg" {
		t.Fatalf("avatar read: %d %s", read.Code, read.Body.String())
	}
	if !bytes.Equal(read.Body.Bytes(), imageBytes) {
		t.Fatal("avatar bytes differ")
	}

	if _, err := pool.Exec(ctx, "UPDATE account_profiles SET avatar_bytes=$1, avatar_updated_at_ms=7 WHERE user_id=(SELECT id FROM account_users WHERE email=$2)", imageBytes, email); err != nil {
		t.Fatal(err)
	}
	me := get(t, handler, "/api/avatars/me", cookie)
	if me.Code != http.StatusOK || !bytes.Equal(me.Body.Bytes(), imageBytes) {
		t.Fatalf("personal avatar read: %d %s", me.Code, me.Body.String())
	}
	delReq := httptest.NewRequest(http.MethodDelete, "/api/avatars/me", nil)
	delReq.Header.Set("Cookie", cookie)
	delOut := httptest.NewRecorder()
	handler.ServeHTTP(delOut, delReq)
	if delOut.Code != http.StatusNoContent {
		t.Fatalf("personal avatar delete: %d %s", delOut.Code, delOut.Body.String())
	}
	if meAgain := get(t, handler, "/api/avatars/me", cookie); meAgain.Code != http.StatusNotFound {
		t.Fatalf("personal avatar after delete: %d %s", meAgain.Code, meAgain.Body.String())
	}
}
