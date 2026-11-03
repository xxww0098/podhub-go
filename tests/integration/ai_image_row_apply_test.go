package integration

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"reflect"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgconn"
	"github.com/xxww0098/podhub-go/internal/app"
	listingcore "github.com/xxww0098/podhub-go/internal/listing/core"
	listingread "github.com/xxww0098/podhub-go/internal/listing/read/domain"
	listingrules "github.com/xxww0098/podhub-go/internal/listing/rules"
	"github.com/xxww0098/podhub-go/internal/platform/config"
	"github.com/xxww0098/podhub-go/internal/platform/db"
)

// Existing live artifacts are local inputs only: this test never generates or
// downloads images. The schema is a tote fixture, not a catalog-sync claim.
func TestAIImageRowApplyPersistence(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()
	out := os.Getenv("PODHUB_AI_ROW_APPLY_EVIDENCE_DIR")
	input := imageRowInputs(t, out)
	t.Setenv("PODHUB_PARITY_DSN", "")
	t.Setenv("PODHUB_ALLOW_SUPERUSER_DB", "1")
	dsn := securityDSN(t, ctx)
	fixture, err := db.Connect(ctx, config.Config{DatabaseURL: dsn})
	if err != nil {
		t.Fatal(err)
	}
	defer fixture.Close()
	if err = db.Migrate(ctx, fixture); err != nil {
		t.Fatal(err)
	}
	if _, err = fixture.Exec(ctx, `ALTER ROLE podhub_login_api PASSWORD 'isolated-row-apply-login'`); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PODHUB_ALLOW_SUPERUSER_DB", "")
	apiDSN, err := url.Parse(swapUser(dsn, "podhub_login_api", "isolated-row-apply-login"))
	if err != nil {
		t.Fatal(err)
	}
	query := apiDSN.Query()
	query.Set("pool_max_conns", "1")
	apiDSN.RawQuery = query.Encode()
	apiPool, err := db.Connect(ctx, config.Config{DatabaseURL: apiDSN.String()})
	if err != nil {
		t.Fatal(err)
	}
	defer apiPool.Close()
	var role string
	var super, bypass, inherit bool
	if err = apiPool.QueryRow(ctx, `SELECT current_user,rolsuper,rolbypassrls,rolinherit FROM pg_roles WHERE rolname=current_user`).Scan(&role, &super, &bypass, &inherit); err != nil || role != "podhub_login_api" || super || bypass || inherit {
		t.Fatal("normal NOINHERIT API role required")
	}
	assertBareRole := func() {
		t.Helper()
		var current, setting string
		if err := apiPool.QueryRow(ctx, `SELECT current_user,current_setting('role')`).Scan(&current, &setting); err != nil || current != role || setting != "none" {
			t.Fatal("transaction role leaked into shared API connection")
		}
		for _, table := range []string{"ozon_category_current", "banned_tags"} {
			var count int64
			err := apiPool.QueryRow(ctx, `SELECT count(*) FROM public.`+table).Scan(&count)
			var denied *pgconn.PgError
			if !errors.As(err, &denied) || denied.Code != "42501" {
				t.Fatalf("API login unexpectedly has bare %s SELECT: %v", table, err)
			}
		}
	}
	assertBareRole()
	t.Setenv("CLOUD_COOKIE_SECURE", "0")
	t.Setenv("OZON_WRITE_KILL_SWITCH", "1")
	if _, err = fixture.Exec(ctx, `INSERT INTO account_users(public_id,email,password_hash,role,name,target,supplier_id,plan,created_at,updated_at) VALUES('00000000-0000-4000-8000-000000009994','row-apply-owner@example.invalid','x','super_admin','Owner','/workspace','','free',clock_timestamp(),clock_timestamp()); UPDATE platform_initialization SET owner_account_id=(SELECT id FROM account_users WHERE email='row-apply-owner@example.invalid'),initialized_at=clock_timestamp() WHERE singleton`); err != nil {
		t.Fatal(err)
	}
	fixtureHandler := app.Handler(fixture)
	register := func(email, key string) (string, int64) {
		response := postJSON(t, fixtureHandler, "/api/auth/register", `{"email":"`+email+`","password":"correct-horse","name":"Tote Row"}`, key, "")
		if response.Code != http.StatusOK {
			t.Fatalf("fixture session issuance: HTTP %d %s", response.Code, response.Body.String())
		}
		var org int64
		if err := fixture.QueryRow(ctx, `SELECT o.id FROM organizations o JOIN account_users u ON u.id=o.owner_user_id WHERE u.email=$1`, email).Scan(&org); err != nil {
			t.Fatal(err)
		}
		return sessionCookie(response), org
	}
	cookie, org := register("row-apply@example.invalid", "row-apply-register")
	foreignCookie, _ := register("row-apply-foreign@example.invalid", "row-apply-foreign-register")
	handler := app.Handler(apiPool)
	request := func(method, path, cookie string, body any) *httptest.ResponseRecorder {
		t.Helper()
		var encoded []byte
		if body != nil {
			encoded, err = json.Marshal(body)
			if err != nil {
				t.Fatal(err)
			}
		}
		r := httptest.NewRequest(method, path, bytes.NewReader(encoded))
		r.Header.Set("Content-Type", "application/json")
		r.Header.Set("Cookie", cookie)
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, r)
		return response
	}
	// Only schema/auth fixtures use the fixture pool. Card and row creation,
	// editing and reading all go through the unchanged normal HTTP surface.
	const category, productType = 990001, 990002
	fields := []byte(`[{"key":"name","label":"Tote name","group":"Attrs","editor":"text","required":false,"collection":false,"attribute_id":"4180","options":[]},{"key":"attr:23171","label":"Tote tags","group":"Attrs","editor":"text","required":false,"collection":true,"attribute_id":"23171","options":[]}]`)
	module, err := listingcore.OpenEmbedded(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer module.Close(context.Background())
	snapshotInput, _ := json.Marshal(map[string]any{"description_category_id": category, "type_id": productType, "fields": json.RawMessage(fields)})
	snapshot, err := module.Snapshot(ctx, snapshotInput)
	if err != nil {
		t.Fatal(err)
	}
	var schema struct {
		Revision string `json:"schema_revision"`
	}
	if json.Unmarshal(snapshot, &schema) != nil || schema.Revision == "" {
		t.Fatal("real native schema revision missing")
	}
	if _, err = fixture.Exec(ctx, `INSERT INTO listing_schema_revisions(schema_revision,snapshot) VALUES($1,$2::jsonb)`, schema.Revision, string(snapshot)); err != nil {
		t.Fatal(err)
	}
	if _, err = fixture.Exec(ctx, `INSERT INTO ozon_category_current(description_category_id,type_id,language,fields,content_digest,fetched_at_ms,schema_revision) VALUES($1,$2,'default',$3::jsonb,$4,$5,$6)`, category, productType, string(fields), "sha256:"+imageRowDigest(fields), time.Now().UnixMilli(), schema.Revision); err != nil {
		t.Fatal(err)
	}
	if _, err = fixture.Exec(ctx, `INSERT INTO banned_tags(term,match_mode,note,created_by) VALUES('запреттест','exact','','fixture')`); err != nil {
		t.Fatal(err)
	}
	listingrules.InvalidateBannedTags()
	t.Cleanup(listingrules.InvalidateBannedTags)
	cardPayload := map[string]any{"categoryKey": "internal-tote-fixture", "descriptionCategoryId": category, "typeId": productType, "language": "default", "defaults": map[string]any{"values": map[string]any{}, "complex_values": []any{}}, "aiFieldPolicy": map[string]any{"allowed_field_keys": []any{}, "protected_field_keys": []any{}}}
	cardResponse := request(http.MethodPost, "/api/listing/cards", cookie, map[string]any{"title": "Tote image application", "createMode": "blank", "payload": cardPayload})
	var card struct {
		Data struct{ ID string } `json:"data"`
	}
	if cardResponse.Code != 200 || json.Unmarshal(cardResponse.Body.Bytes(), &card) != nil || card.Data.ID == "" {
		t.Fatalf("normal card create: HTTP %d %s", cardResponse.Code, cardResponse.Body.String())
	}
	originalValues := map[string]any{"name": imageRowText("Сумка-шоппер из хлопка"), "price": imageRowText("90"), "description": imageRowText("Сохранённое ручное описание"), "attr:23171": map[string]any{"kind": "text_list", "value": []string{"canvas", "tote"}}, "images": map[string]any{"kind": "url_list", "value": []string{input.OriginalURL}}, "primary_image": imageRowText(input.OriginalURL)}
	rowResponse := request(http.MethodPost, "/api/listing/rows", cookie, map[string]any{"cardId": card.Data.ID, "source": map[string]any{"sha256": input.SourceSHA, "fileName": "product-tote.jpg"}, "draft": map[string]any{"values": originalValues, "complex_values": []any{}}, "createKey": "tote-apply-row", "requestFingerprint": input.SourceSHA})
	decode := func(response *httptest.ResponseRecorder) listingread.RowView {
		t.Helper()
		var body struct {
			Data listingread.RowView `json:"data"`
		}
		if response.Code != 200 || json.Unmarshal(response.Body.Bytes(), &body) != nil || body.Data.ID == "" {
			t.Fatalf("normal row HTTP %d: %s", response.Code, response.Body.String())
		}
		return body.Data
	}
	created := decode(rowResponse)
	path := "/api/listing/rows/" + created.ID
	patch := func(view listingread.RowView, urls []string, name string) map[string]any {
		t.Helper()
		var draft map[string]any
		if json.Unmarshal(view.Draft, &draft) != nil {
			t.Fatal("draft missing")
		}
		values := draft["values"].(map[string]any)
		values["images"] = map[string]any{"kind": "url_list", "value": urls}
		values["primary_image"] = imageRowText(urls[0])
		if name != "" {
			values["name"] = imageRowText(name)
		}
		// This is the UI binding's wire shape: no client-supplied hand-edit or
		// source/media/render evidence. Native edit computes protected metadata.
		return map[string]any{"baseRevision": view.Revision, "draft": draft}
	}
	baseline := decode(request(http.MethodPatch, path, cookie, patch(created, []string{input.OriginalURL}, "Сумка-шоппер из хлопка, ручной заголовок")))
	readDB := func(view listingread.RowView) map[string]any {
		t.Helper()
		var revision int64
		var payload []byte
		var mediaState string
		if err = fixture.QueryRow(ctx, `SELECT revision,payload,media_state FROM listing_rows WHERE org_id=$1 AND id=$2::uuid`, org, created.ID).Scan(&revision, &payload, &mediaState); err != nil {
			t.Fatal(err)
		}
		stored := imageRowObject(t, payload)
		projected := imageRowObject(t, view.Payload)
		if hydrated, ok := projected["schemaSnapshot"]; ok {
			if !reflect.DeepEqual(hydrated, imageRowObject(t, snapshot)) {
				t.Fatal("GET schema hydration differs from registered native snapshot")
			}
			if _, persisted := stored["schemaSnapshot"]; !persisted {
				delete(projected, "schemaSnapshot")
			}
		}
		if revision != view.Revision || mediaState != view.MediaState || !reflect.DeepEqual(stored, projected) {
			t.Fatal("independent PG row disagrees with HTTP view")
		}
		return stored
	}
	before := readDB(baseline)
	if imageRowObject(t, baseline.Source)["sha256"] != input.SourceSHA {
		t.Fatal("normal row did not retain the verified tote source SHA256")
	}
	beforeHands := imageRowKeys(t, before)
	if !slices.Contains(beforeHands, "name") {
		t.Fatal("normal draft PATCH did not establish existing manual field")
	}
	blockedBody := patch(baseline, []string{input.OriginalURL}, "")
	blockedBody["draft"].(map[string]any)["values"].(map[string]any)["attr:23171"] = map[string]any{"kind": "text_list", "value": []string{"запреттест"}}
	blocked := request(http.MethodPatch, path, cookie, blockedBody)
	if blocked.Code != http.StatusBadRequest || !reflect.DeepEqual(readDB(decode(request(http.MethodGet, path, cookie, nil))), before) {
		t.Fatalf("normal-role rules loader failed to reject banned tag without writing: HTTP %d %s", blocked.Code, blocked.Body.String())
	}
	verify := func(view listingread.RowView, urls []string, revision int64) map[string]any {
		t.Helper()
		stored := readDB(view)
		values := stored["draft"].(map[string]any)["values"].(map[string]any)
		wantImages := imageRowObject(t, imageRowJSON(t, map[string]any{"kind": "url_list", "value": urls}))
		if view.Revision != revision || !reflect.DeepEqual(values["images"], wantImages) || !reflect.DeepEqual(values["primary_image"], imageRowText(urls[0])) {
			t.Fatalf("paired manual image fields/revision not persisted: revision=%d", view.Revision)
		}
		for key, value := range before["draft"].(map[string]any)["values"].(map[string]any) {
			if key != "images" && key != "primary_image" && !reflect.DeepEqual(values[key], value) {
				t.Fatalf("unrelated manual field changed: %s", key)
			}
		}
		for _, key := range []string{"source", "media", "renderEvidence"} {
			if !reflect.DeepEqual(stored[key], before[key]) {
				t.Fatalf("protected section changed: %s", key)
			}
		}
		if view.MediaState != baseline.MediaState || len(view.RenderEvidence) != 0 {
			t.Fatal("manual URLs must not fabricate PSD/media readiness")
		}
		hands := imageRowKeys(t, stored)
		for _, key := range append(append([]string{}, beforeHands...), "images", "primary_image") {
			if !slices.Contains(hands, key) {
				t.Fatalf("server-computed hand-edit marker missing: %s", key)
			}
		}
		return stored
	}
	urls := []string{input.URLs[1], input.URLs[0], input.URLs[2]}
	applyBody := patch(baseline, urls, "")
	applied := decode(request(http.MethodPatch, path, cookie, applyBody))
	verify(applied, urls, baseline.Revision+1)
	appliedRead := decode(request(http.MethodGet, path, cookie, nil))
	appliedDB := verify(appliedRead, urls, baseline.Revision+1)
	stale := request(http.MethodPatch, path, cookie, patch(baseline, []string{input.URLs[0]}, ""))
	if stale.Code != http.StatusConflict {
		t.Fatalf("stale CAS: HTTP %d %s", stale.Code, stale.Body.String())
	}
	foreignRead := request(http.MethodGet, path, foreignCookie, nil)
	foreignPatch := request(http.MethodPatch, path, foreignCookie, patch(appliedRead, []string{input.URLs[2]}, ""))
	if foreignRead.Code != 404 || foreignPatch.Code != 404 {
		t.Fatalf("cross-org row leakage: GET %d PATCH %d", foreignRead.Code, foreignPatch.Code)
	}
	unchanged := decode(request(http.MethodGet, path, cookie, nil))
	if !reflect.DeepEqual(verify(unchanged, urls, applied.Revision), appliedDB) {
		t.Fatal("refused CAS/cross-org request mutated the row")
	}
	restored := decode(request(http.MethodPatch, path, cookie, patch(unchanged, []string{input.OriginalURL}, "")))
	verify(restored, []string{input.OriginalURL}, applied.Revision+1)
	restoredRead := decode(request(http.MethodGet, path, cookie, nil))
	restoredDB := verify(restoredRead, []string{input.OriginalURL}, applied.Revision+1)
	assertBareRole()
	report := map[string]any{"passed": true, "completed_at": time.Now().UTC(), "boundary": "Internal AI-output URL -> normal Go row draft PATCH/CAS -> GET and independent PostgreSQL readback; not browser end-to-end, catalog sync, PSD rendering/restoration, or external publication", "input": input, "database": "fresh fully migrated PostgreSQL16", "authentication": "real session cookie + app.Handler normal middleware + membership; register/session issuance only uses fixture pool", "api_role": map[string]any{"name": role, "superuser": super, "bypass_rls": bypass, "inherit": inherit}, "native_engine": "real embedded listing-core seed/edit + fixed tote schema fixture; no SQL row seeding/readiness/evidence injection", "http": map[string]any{"card_create": cardResponse.Code, "row_create": rowResponse.Code, "apply_patch": 200, "apply_get": 200, "stale_cas": stale.Code, "foreign_get": foreignRead.Code, "foreign_patch": foreignPatch.Code, "restore_patch": 200, "restore_get": 200}, "revisions": map[string]any{"created": created.Revision, "manual_baseline": baseline.Revision, "applied": applied.Revision, "restored": restored.Revision}, "applied_images": urls, "primary_image": urls[0], "server_hand_edited_keys": imageRowKeys(t, appliedDB), "protected_source_media_render_evidence_unchanged": true, "other_manual_fields_unchanged": true, "stale_and_foreign_requests_no_write": true, "restore": "Previous manual URL list and first image restored via the same paired draft PATCH; no real PSD input and no PSD recovery claim", "applied_payload_sha256": imageRowDigest(imageRowJSON(t, appliedDB)), "restored_payload_sha256": imageRowDigest(imageRowJSON(t, restoredDB)), "new_model_calls": 0, "new_r2_calls": 0, "new_external_cost_cny": "0", "production_writes": false, "command": "go test ./tests/integration -run '^TestAIImageRowApplyPersistence$' -count=1 -v"}
	report["role_regression"] = "Single-connection API pool; role none/current_user login before and after; bare category/banned-tag SELECT both SQLSTATE42501; no grants or RLS changes"
	report["banned_tag_rejection_http"] = blocked.Code
	report["http_patch_fields"] = []string{"baseRevision", "draft"}
	report["independent_pg_readback"] = map[string]any{"applied_draft": appliedDB["draft"], "restored_draft": restoredDB["draft"], "source": restoredDB["source"], "media": restoredDB["media"], "render_evidence": restoredDB["renderEvidence"]}
	report["original_manual_url_provenance"] = "Known canonical source SHA path in prior real-storage prefix; source bytes locally verified; no public URL availability recheck in this internal persistence run"
	if out != "" {
		report["command"] = "PODHUB_AI_ROW_APPLY_EVIDENCE_DIR=" + out + " go test ./tests/integration -run '^TestAIImageRowApplyPersistence$' -count=1 -v"
		report["logs"] = []string{"/tmp/podhub-ai-row-apply-default.log", "/tmp/podhub-ai-row-apply-real.log", "/tmp/podhub-ai-row-apply-unit-arch.log"}
		liveWrite(t, out, "row-apply-persistence.json", report)
	}
	t.Log("PASS normal-cookie NOINHERIT card/row seed + atomic scene-first image PATCH + GET/PG readback + stale CAS/cross-org refusal + previous-manual restoration; zero external calls")
}

type imageRowInput struct {
	Kind        string   `json:"kind"`
	SourceSHA   string   `json:"source_sha256"`
	SourceBytes int      `json:"source_bytes"`
	URLs        []string `json:"output_urls"`
	OriginalURL string   `json:"original_manual_url"`
}

func imageRowInputs(t *testing.T, out string) imageRowInput {
	t.Helper()
	if out == "" {
		source, err := os.ReadFile(filepath.Join("..", "..", "web", "public", "site", "product-tote.jpg"))
		if err != nil {
			t.Fatal(err)
		}
		return imageRowInput{Kind: "CI ordinary URL fixture + real public tote source bytes; no generation claim", SourceSHA: imageRowDigest(source), SourceBytes: len(source), URLs: []string{"https://media.example.invalid/tote-white.jpg", "https://media.example.invalid/tote-scene.jpg", "https://media.example.invalid/tote-detail.jpg"}, OriginalURL: "https://media.example.invalid/tote-source.jpg"}
	}
	var prior struct {
		Passed           bool `json:"passed"`
		ProviderAttempts int  `json:"provider_attempts"`
		Post             struct {
			Status string `json:"status"`
			Source string `json:"source_sha256"`
			Items  []struct {
				Ordinal int    `json:"ordinal"`
				Status  string `json:"status"`
				Asset   struct {
					URL string `json:"url"`
					SHA string `json:"sha256"`
				} `json:"asset"`
			} `json:"items"`
		} `json:"post"`
	}
	raw, err := os.ReadFile(filepath.Join(out, "live-validation.json"))
	if err != nil || json.Unmarshal(raw, &prior) != nil || !prior.Passed || prior.ProviderAttempts != 3 || prior.Post.Status != "ready" || len(prior.Post.Items) != 3 {
		t.Fatal("completed real three-image evidence required")
	}
	source, err := os.ReadFile(filepath.Join(out, "source-product-tote.jpg"))
	if err != nil || imageRowDigest(source) != prior.Post.Source {
		t.Fatal("actual tote source hash does not match generated set")
	}
	input := imageRowInput{Kind: "Previously generated real tote artifacts, local SHA verification only; no new network requests", SourceSHA: prior.Post.Source, SourceBytes: len(source)}
	for i, item := range prior.Post.Items {
		pixels, err := os.ReadFile(filepath.Join(out, []string{"set-1.jpg", "set-2.jpg", "set-3.jpg"}[i]))
		if err != nil || item.Ordinal != i || item.Status != "ready" || imageRowDigest(pixels) != item.Asset.SHA || !strings.HasPrefix(item.Asset.URL, "https://podhub-supplier.ozon-pod.com/podhub-live-admission-20261022/") || !strings.HasSuffix(item.Asset.URL, "/"+item.Asset.SHA+".jpg") {
			t.Fatal("real output artifact/URL mismatch")
		}
		input.URLs = append(input.URLs, item.Asset.URL)
	}
	input.OriginalURL = input.URLs[0][:strings.LastIndex(input.URLs[0], "/")+1] + input.SourceSHA + ".jpg"
	return input
}

func imageRowText(value string) map[string]any { return map[string]any{"kind": "text", "value": value} }

func imageRowDigest(value []byte) string {
	digest := sha256.Sum256(value)
	return hex.EncodeToString(digest[:])
}

func imageRowObject(t *testing.T, raw []byte) map[string]any {
	t.Helper()
	var value map[string]any
	if err := json.Unmarshal(raw, &value); err != nil {
		t.Fatal(err)
	}
	return value
}

func imageRowKeys(t *testing.T, payload map[string]any) []string {
	t.Helper()
	var keys []string
	if err := json.Unmarshal(imageRowJSON(t, payload["handEditedKeys"]), &keys); err != nil {
		t.Fatal(err)
	}
	return keys
}

func imageRowJSON(t *testing.T, value any) []byte {
	t.Helper()
	raw, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	return raw
}
