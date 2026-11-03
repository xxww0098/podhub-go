package integration

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/xxww0098/podhub-go/internal/app"
	mediarepo "github.com/xxww0098/podhub-go/internal/media/repo"
	"github.com/xxww0098/podhub-go/internal/platform/db"
	sign "github.com/xxww0098/podhub-go/internal/platform/r2/sigv4"
	"github.com/xxww0098/podhub-go/internal/platform/seal"
)

func TestMediaPresignUsesTheSessionOrg(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Minute)
	defer cancel()
	pool := migratedPool(t, ctx)
	seedMatchingLease(t, ctx, pool, "recipe", "media presign tenant isolation")
	t.Setenv("CLOUD_SELLER_CREDENTIAL_KEY", "parity-test-key")
	t.Setenv("CLOUD_COOKIE_SECURE", "0")
	const integrationKey = "media-presign-fixture-encryption-key"
	t.Setenv("CLOUD_INTEGRATION_CONFIG_KEY", integrationKey)
	if _, err := pool.Exec(ctx, `
		INSERT INTO account_users
		    (public_id, email, password_hash, role, name, target, supplier_id, plan, created_at, updated_at)
		VALUES ('00000000-0000-4000-8000-0000000000a1', 'owner-media@pod.example', 'x', 'super_admin', 'owner', '/workspace', '', 'free', clock_timestamp(), clock_timestamp())`); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `
		UPDATE platform_initialization
		SET owner_account_id = (SELECT id FROM account_users WHERE email = 'owner-media@pod.example'),
		    initialized_at = clock_timestamp()
		WHERE singleton AND owner_account_id IS NULL`); err != nil {
		t.Fatal(err)
	}

	handler := app.Handler(pool)
	ada := postJSON(t, handler, "/api/auth/register", `{"email":"media-ada@pod.example","password":"correct-horse","name":"Ada"}`, "media-reg-ada", "")
	if ada.Code != http.StatusOK {
		t.Fatalf("ada %d %s", ada.Code, ada.Body.Bytes())
	}
	bob := postJSON(t, handler, "/api/auth/register", `{"email":"media-bob@pod.example","password":"correct-horse","name":"Bob"}`, "media-reg-bob", "")
	if bob.Code != http.StatusOK {
		t.Fatalf("bob %d %s", bob.Code, bob.Body.Bytes())
	}
	adaUUID := orgUUID(t, ctx, pool, "media-ada@pod.example")
	bobUUID := orgUUID(t, ctx, pool, "media-bob@pod.example")
	if adaUUID == bobUUID || adaUUID == "" {
		t.Fatalf("uuids %s %s", adaUUID, bobUUID)
	}
	accounts := map[string]string{}
	for _, email := range []string{"media-ada@pod.example", "media-bob@pod.example"} {
		var userID, orgID int64
		if err := pool.QueryRow(ctx, `SELECT u.id,o.id FROM account_users u JOIN organizations o ON o.owner_user_id=u.id WHERE u.email=$1`, email).Scan(&userID, &orgID); err != nil {
			t.Fatal(err)
		}
		account := sign.Account{ID: uuid.NewString(), Endpoint: "https://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.r2.cloudflarestorage.com", Bucket: "presign-" + strings.Split(email, "@")[0], PublicBaseURL: "https://pub-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.r2.dev", AccessKeyID: "fixture-access", SecretAccessKey: "fixture-secret"}
		accounts[email] = account.ID
		if err := db.InTx(ctx, pool, db.App(orgID), func(tx pgx.Tx) error {
			if err := mediarepo.StageSliceStorage(ctx, tx, orgID, userID, account, seal.DeriveKEK(integrationKey)); err != nil {
				return err
			}
			return mediarepo.ActivateSliceStorage(ctx, tx, orgID, userID, account.ID)
		}); err != nil {
			t.Fatal(err)
		}
	}
	digest := "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
	adaBody := presign(t, handler, digest, sessionCookie(ada))
	bobBody := presign(t, handler, digest, sessionCookie(bob))
	if adaBody.Code != http.StatusOK || !strings.Contains(adaBody.Body.String(), "podhub-slices/"+accounts["media-ada@pod.example"]+"/uploads/") || !strings.Contains(adaBody.Body.String(), "/"+digest+".jpg") {
		t.Fatalf("ada %d %s", adaBody.Code, adaBody.Body.Bytes())
	}
	if strings.Contains(adaBody.Body.String(), accounts["media-bob@pod.example"]) || strings.Contains(adaBody.Body.String(), adaUUID) || strings.Contains(adaBody.Body.String(), bobUUID) {
		t.Fatalf("ada key contains another identity %s", adaBody.Body.Bytes())
	}
	if bobBody.Code != http.StatusOK || !strings.Contains(bobBody.Body.String(), "podhub-slices/"+accounts["media-bob@pod.example"]+"/uploads/") || !strings.Contains(bobBody.Body.String(), "/"+digest+".jpg") {
		t.Fatalf("bob %d %s", bobBody.Code, bobBody.Body.Bytes())
	}
	anon := presign(t, handler, digest, "")
	if anon.Code != http.StatusUnauthorized {
		t.Fatalf("anon %d %s", anon.Code, anon.Body.Bytes())
	}
}

func orgUUID(t *testing.T, ctx context.Context, pool *pgxpool.Pool, email string) string {
	t.Helper()
	var uuid string
	err := pool.QueryRow(ctx, `
		SELECT o.uuid::text FROM organizations o
		JOIN account_users u ON u.id = o.owner_user_id
		WHERE u.email = $1`, email).Scan(&uuid)
	if err != nil {
		t.Fatal(err)
	}
	return uuid
}

func sessionCookie(rec *httptest.ResponseRecorder) string {
	for _, cookie := range rec.Header().Values("Set-Cookie") {
		if strings.HasPrefix(cookie, "sid=") {
			return cookie
		}
	}
	return rec.Header().Get("Set-Cookie")
}

func presign(t *testing.T, handler http.Handler, digest, cookie string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(http.MethodPost, "/api/media/objects/"+digest+"/jpg/presign", strings.NewReader(`{"byte_length":12}`))
	req.Header.Set("Content-Type", "application/json")
	if cookie != "" {
		req.Header.Set("Cookie", cookie)
	}
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	return rec
}
