package integration

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/xxww0098/podhub-go/internal/app"
	appscans "github.com/xxww0098/podhub-go/internal/app/scans"
	appworker "github.com/xxww0098/podhub-go/internal/app/worker"
	catalog "github.com/xxww0098/podhub-go/internal/catalog/domain"
	listingcore "github.com/xxww0098/podhub-go/internal/listing/core"
	"github.com/xxww0098/podhub-go/internal/listing/submit"
	"github.com/xxww0098/podhub-go/internal/platform/config"
	"github.com/xxww0098/podhub-go/internal/platform/db"
	"github.com/xxww0098/podhub-go/internal/platform/seal"
	queuerepo "github.com/xxww0098/podhub-go/internal/queue/repo"
	queueservice "github.com/xxww0098/podhub-go/internal/queue/service"
	sellercontract "github.com/xxww0098/podhub-go/internal/seller/contract"
	seller "github.com/xxww0098/podhub-go/internal/seller/ozon"
	sellerrepo "github.com/xxww0098/podhub-go/internal/seller/ozon/repo"
)

func TestSellerBudgetNormalRoles(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	dsn := securityDSN(t, ctx)
	t.Setenv("PODHUB_ALLOW_SUPERUSER_DB", "1")
	fixture, err := db.Connect(ctx, config.Config{DatabaseURL: dsn})
	if err != nil {
		t.Fatal(err)
	}
	defer fixture.Close()
	if err = db.Migrate(ctx, fixture); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"podhub_login_api", "podhub_login_listing_worker", "podhub_login_reconciler"} {
		t.Run(name, func(t *testing.T) {
			if _, err := fixture.Exec(ctx, `ALTER ROLE `+name+` PASSWORD 'isolated-budget-login'`); err != nil {
				t.Fatal(err)
			}
			pool, err := db.Connect(ctx, config.Config{DatabaseURL: swapUser(dsn, name, "isolated-budget-login")})
			if err != nil {
				t.Fatal(err)
			}
			defer pool.Close()
			if wait, err := sellerrepo.Reserve(ctx, pool, "normal-role-test", name, time.Millisecond, time.Millisecond, time.Second); err != nil || wait != 0 {
				t.Fatalf("normal role budget wait=%s err=%v", wait, err)
			}
			var current string
			if err = pool.QueryRow(ctx, `SELECT current_user`).Scan(&current); err != nil || current != name {
				t.Fatalf("role not restored: %s %v", current, err)
			}
			var count int
			err = pool.QueryRow(ctx, `SELECT count(*) FROM lease_budget`).Scan(&count)
			pgErr, ok := err.(*pgconn.PgError)
			if !ok || pgErr.Code != "42501" {
				t.Fatalf("raw pool gained table access: %v", err)
			}
		})
	}
}

// Only scripts/verify-publish-live.py supplies a live key. Preflight uses normal
// member/store APIs without a Seller write; submit permits one reviewed import.
func TestListingPublishLive(t *testing.T) {
	mode := os.Getenv("PODHUB_PUBLISH_LIVE_MODE")
	if mode != "preflight" && mode != "submit" {
		t.Skip("explicit live preflight required")
	}
	out := os.Getenv("PODHUB_PUBLISH_LIVE_OUTPUT")
	if out == "" {
		t.Fatal("evidence output required")
	}
	var remote struct {
		ClientID string `json:"client_id"`
		APIKey   string `json:"api_key"`
	}
	if json.NewDecoder(io.LimitReader(os.Stdin, 1<<20)).Decode(&remote) != nil || remote.ClientID != "4877007" || remote.APIKey == "" {
		t.Fatal("target credential stdin unavailable")
	}
	var approvedPlan []byte
	offerID := "podhub-live-validation-" + strings.ReplaceAll(uuid.NewString(), "-", "")[:24]
	if mode == "submit" {
		var err error
		approvedPlan, err = os.ReadFile(os.Getenv("PODHUB_PUBLISH_APPROVED_PLAN"))
		var approved struct {
			Items []struct {
				OfferID string `json:"offer_id"`
			} `json:"items"`
		}
		digest := sha256.Sum256(approvedPlan)
		if err != nil || hex.EncodeToString(digest[:]) != os.Getenv("PODHUB_PUBLISH_APPROVED_SHA256") || json.Unmarshal(approvedPlan, &approved) != nil || len(approved.Items) != 1 || !strings.HasPrefix(approved.Items[0].OfferID, "podhub-live-validation-") {
			t.Fatal("reviewed immutable import plan missing or changed")
		}
		offerID = approved.Items[0].OfferID
	}
	report := map[string]any{
		"passed": false, "mode": mode, "started_at": time.Now().UTC(),
		"seller_writes": 0, "production_database_writes": 0, "deployment_changes": 0,
		"packaging":    map[string]any{"width": 400, "height": 450, "depth": 20, "dimension_unit": "mm", "weight": 470, "weight_unit": "g", "source": "published supplier product pack_*; supersedes conflicting 460g supplier config"},
		"offer_id":     offerID,
		"stock_policy": "no stock write; import is not an on-sale claim",
	}
	defer func() {
		report["completed_at"] = time.Now().UTC()
		raw, _ := json.MarshalIndent(report, "", "  ")
		if os.MkdirAll(out, 0700) != nil || os.WriteFile(filepath.Join(out, "publication-"+mode+".json"), append(raw, '\n'), 0600) != nil {
			t.Error("failed to save preflight report")
		}
	}()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Minute)
	defer cancel()
	t.Setenv("PODHUB_PARITY_DSN", "")
	dsn := securityDSN(t, ctx)
	t.Setenv("PODHUB_ALLOW_SUPERUSER_DB", "1")
	fixture, err := db.Connect(ctx, config.Config{DatabaseURL: dsn})
	if err != nil {
		t.Fatal("fixture database unavailable")
	}
	defer fixture.Close()
	if db.Migrate(ctx, fixture) != nil {
		t.Fatal("fresh migrations failed")
	}
	if _, err = fixture.Exec(ctx, `ALTER ROLE podhub_login_api PASSWORD 'isolated-publish-api-login'`); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PODHUB_ALLOW_SUPERUSER_DB", "")
	pool, err := db.Connect(ctx, config.Config{DatabaseURL: swapUser(dsn, "podhub_login_api", "isolated-publish-api-login")})
	if err != nil {
		t.Fatal("normal API pool unavailable")
	}
	defer pool.Close()
	var role string
	var super, bypass, inherit bool
	if err = pool.QueryRow(ctx, `SELECT current_user,rolsuper,rolbypassrls,rolinherit FROM pg_roles WHERE rolname=current_user`).Scan(&role, &super, &bypass, &inherit); err != nil || role != "podhub_login_api" || super || bypass || inherit {
		t.Fatal("unsafe API role")
	}
	report["database"] = map[string]any{"fresh_fully_migrated": true, "role": role, "superuser": super, "bypassrls": bypass, "inherit": inherit}
	t.Setenv("CLOUD_COOKIE_SECURE", "0")
	t.Setenv("CLOUD_SELLER_CREDENTIAL_KEY", uuid.NewString()+uuid.NewString())
	t.Setenv("CLOUD_SELLER_CREDENTIAL_KEY_ID", seal.DefaultSellerKeyID)
	t.Setenv("CLOUD_SELLER_CREDENTIAL_KEY_PREVIOUS", "")
	t.Setenv("OZON_WRITE_KILL_SWITCH", "1")
	if _, err = fixture.Exec(ctx, `INSERT INTO account_users(public_id,email,password_hash,role,name,target,supplier_id,plan,created_at,updated_at) VALUES('00000000-0000-4000-8000-000000009993','publish-owner@example.invalid','x','super_admin','Owner','/workspace','','free',clock_timestamp(),clock_timestamp()); UPDATE platform_initialization SET owner_account_id=(SELECT id FROM account_users WHERE email='publish-owner@example.invalid'),initialized_at=clock_timestamp() WHERE singleton`); err != nil {
		t.Fatal(err)
	}
	fixtureHandler := app.Handler(fixture)
	registered := postJSON(t, fixtureHandler, "/api/auth/register", `{"email":"publish-live@example.invalid","password":"correct-horse","name":"Live Publication"}`, "publish-register", "")
	if registered.Code != 200 {
		t.Fatalf("fixture registration HTTP %d", registered.Code)
	}
	cookie := sessionCookie(registered)
	var org, user, member int64
	if err = fixture.QueryRow(ctx, `SELECT o.id,u.id,m.id FROM organizations o JOIN account_users u ON o.owner_user_id=u.id JOIN organization_members m ON m.org_id=o.id AND m.user_id=u.id WHERE u.email='publish-live@example.invalid'`).Scan(&org, &user, &member); err != nil {
		t.Fatal("normal registration membership missing")
	}
	report["authentication"] = "existing register route issues fixture cookie; all store/credential/listing requests use one standard NOINHERIT API pool and normal middleware"
	seedMatchingLease(t, ctx, fixture, "entitlement", "isolated live publication preflight")
	handler := app.Handler(pool)
	body, _ := json.Marshal(map[string]any{"name": "Live publication validation", "client_id": remote.ClientID, "assignee_membership_id": member})
	store := postJSON(t, handler, "/api/workspaces/stores", string(body), "publish-store-create", cookie)
	report["store_create_http_status"] = store.Code
	if store.Code != 200 {
		report["blocked_stage"] = "normal_store_create"
		t.Fatalf("normal store create HTTP %d: %s", store.Code, store.Body.String())
	}
	var created struct {
		Store struct {
			UUID     string `json:"uuid"`
			Revision int64  `json:"revision"`
		} `json:"store"`
	}
	if json.Unmarshal(store.Body.Bytes(), &created) != nil || created.Store.UUID == "" {
		t.Fatal("store response invalid")
	}
	credentialBody, _ := json.Marshal(map[string]any{"client_id": remote.ClientID, "api_key": remote.APIKey, "confirm_upload": true, "expected_store_revision": created.Store.Revision, "expected_credential_revision": nil})
	credential := postJSON(t, handler, "/api/workspaces/stores/"+created.Store.UUID+"/credential", string(credentialBody), "publish-key-register", cookie)
	report["credential_register_http_status"] = credential.Code
	if credential.Code != 200 {
		report["blocked_stage"] = "normal_credential_register"
		var refusal map[string]any
		if json.Unmarshal(credential.Body.Bytes(), &refusal) == nil {
			report["credential_refusal"] = refusal
		}
		t.Fatalf("normal credential registration HTTP %d", credential.Code)
	}
	var version, wrappedSize, nonceSize int
	if fixture.QueryRow(ctx, `SELECT c.envelope_version,octet_length(c.wrapped_dek),octet_length(c.dek_nonce) FROM store_seller_credentials c JOIN organization_stores s ON s.id=c.store_id AND s.org_id=c.org_id WHERE s.org_id=$1 AND s.uuid=$2::uuid AND c.credential_revision=s.credential_revision`, org, created.Store.UUID).Scan(&version, &wrappedSize, &nonceSize) != nil || version != 2 || wrappedSize != 48 || nonceSize != 12 {
		t.Fatal("normal credential registration did not persist v2 envelope")
	}
	report["credential_envelope"] = map[string]any{"version": version, "wrapped_dek_bytes": wrappedSize, "dek_nonce_bytes": nonceSize}
	sourceDir := os.Getenv("PODHUB_PUBLISH_SOURCE_DIR")
	var candidate struct {
		Name   string `json:"name"`
		Images []struct {
			URL    string `json:"url"`
			SHA256 string `json:"sha256"`
			Bytes  int64  `json:"byte_length"`
		} `json:"source_images"`
	}
	raw, err := os.ReadFile(filepath.Join(sourceDir, "candidate-publication-input.json"))
	if err != nil || json.Unmarshal(raw, &candidate) != nil || len(candidate.Images) < 2 {
		t.Fatal("verified publication source unavailable")
	}
	client := &http.Client{Timeout: 25 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }, Transport: &http.Transport{Proxy: nil}}
	defer client.CloseIdleConnections()
	var images []string
	var imageProof []map[string]any
	for _, image := range candidate.Images[:2] {
		if !strings.HasPrefix(image.URL, "https://podhub-supplier.ozon-pod.com/supplier-dbs/") {
			t.Fatal("source image outside exact published supplier origin")
		}
		req, _ := http.NewRequestWithContext(ctx, http.MethodGet, image.URL, nil)
		response, err := client.Do(req)
		if err != nil {
			t.Fatal("source public GET unavailable")
		}
		pixels, err := io.ReadAll(io.LimitReader(response.Body, (20<<20)+1))
		response.Body.Close()
		digest := sha256.Sum256(pixels)
		if err != nil || response.StatusCode != 200 || int64(len(pixels)) != image.Bytes || hex.EncodeToString(digest[:]) != image.SHA256 {
			t.Fatal("source public full-file GET/hash mismatch")
		}
		images = append(images, image.URL)
		imageProof = append(imageProof, map[string]any{"url": image.URL, "http_status": response.StatusCode, "bytes": len(pixels), "sha256": image.SHA256})
	}
	report["source_image_readback"] = imageProof
	report["source_network_risk"] = "Local runtime reads originals successfully; tx-podhub source IP saw Cloudflare 1010. Source GET success does not prove Ozon can copy/process these images or complete moderation."
	fields, schemaFetched := publicationFields(t, sourceDir)
	module, err := listingcore.OpenEmbedded(ctx)
	if err != nil {
		t.Fatal("real listing core unavailable")
	}
	defer module.Close(context.Background())
	input, _ := json.Marshal(map[string]any{"description_category_id": 18262715, "type_id": 96808, "fields": json.RawMessage(fields)})
	snapshot, err := module.Snapshot(ctx, input)
	if err != nil {
		t.Fatalf("real schema snapshot: %v", err)
	}
	var schema struct {
		Revision string `json:"schema_revision"`
	}
	if json.Unmarshal(snapshot, &schema) != nil || schema.Revision == "" {
		t.Fatal("real schema revision missing")
	}
	if _, err = fixture.Exec(ctx, `INSERT INTO listing_schema_revisions(schema_revision,snapshot) VALUES($1,$2::jsonb)`, schema.Revision, string(snapshot)); err != nil {
		t.Fatal(err)
	}
	sum := sha256.Sum256(fields)
	if _, err = fixture.Exec(ctx, `INSERT INTO ozon_category_current(description_category_id,type_id,language,fields,content_digest,fetched_at_ms,schema_revision) VALUES(18262715,96808,'default',$1::jsonb,$2,$3,$4)`, string(fields), "sha256:"+hex.EncodeToString(sum[:]), schemaFetched, schema.Revision); err != nil {
		t.Fatal(err)
	}
	report["schema_fixture"] = "Actual official 41 attributes and verified required dictionary choices; optional dictionary options remain explicitly truncated. Standard WASM Snapshot; this is not verification of the catalog-fetch HTTP path."
	cardPayload := map[string]any{"categoryKey": "workflow:18262715:96808", "descriptionCategoryId": 18262715, "typeId": 96808, "language": "default", "defaults": map[string]any{"values": map[string]any{}, "complex_values": []any{}}, "aiFieldPolicy": map[string]any{"allowed_field_keys": []any{}, "protected_field_keys": []any{}}}
	cardBody, _ := json.Marshal(map[string]any{"title": "Live publication validation", "createMode": "blank", "storeId": created.Store.UUID, "payload": cardPayload})
	card := postJSON(t, handler, "/api/listing/cards", string(cardBody), "publish-create-card", cookie)
	report["card_create_http_status"] = card.Code
	if card.Code != 200 {
		report["blocked_stage"] = "normal_card_create"
		t.Fatalf("normal card create HTTP %d: %s", card.Code, card.Body.String())
	}
	var cardView struct {
		Data struct {
			ID string `json:"id"`
		} `json:"data"`
	}
	if json.Unmarshal(card.Body.Bytes(), &cardView) != nil || cardView.Data.ID == "" {
		t.Fatal("card response invalid")
	}
	value := func(kind string, input any) map[string]any { return map[string]any{"kind": kind, "value": input} }
	offer := report["offer_id"].(string)
	draft := map[string]any{"values": map[string]any{
		"offer_id": value("text", offer), "name": value("text", candidate.Name), "price": value("decimal", 62), "currency_code": value("text", "CNY"), "vat": value("decimal", 0),
		"description_category_id": value("integer", 18262715), "type_id": value("integer", 96808),
		"width": value("integer", 400), "height": value("integer", 450), "depth": value("integer", 20), "dimension_unit": value("text", "mm"), "weight": value("integer", 470), "weight_unit": value("text", "g"),
		"images": value("url_list", images), "primary_image": value("url", images[0]),
		"attribute_85":   value("single_select", map[string]any{"dictionary_value_id": 126745801, "value": "Нет бренда"}),
		"attribute_8229": value("single_select", map[string]any{"dictionary_value_id": 96808, "value": "Коврик для мышки"}),
		"attribute_9024": value("text", offer),
		"attribute_9048": value("text", offer),
	}, "complex_values": []any{}, "cleared": []string{"color_image"}}
	rowBody, _ := json.Marshal(map[string]any{"cardId": cardView.Data.ID, "storeId": created.Store.UUID, "source": map[string]any{"sha256": candidate.Images[0].SHA256, "fileName": "supplier-original-eagle-mousepad.png"}, "draft": draft, "createKey": "publish-row-" + uuid.NewString(), "requestFingerprint": offer})
	row := postJSON(t, handler, "/api/listing/rows", string(rowBody), "publish-create-row", cookie)
	report["row_create_http_status"] = row.Code
	if row.Code != 200 {
		report["blocked_stage"] = "normal_row_create"
		t.Fatalf("normal row create HTTP %d: %s", row.Code, row.Body.String())
	}
	var rowView struct {
		Data struct {
			ID       string `json:"id"`
			Revision int64  `json:"revision"`
		} `json:"data"`
	}
	if json.Unmarshal(row.Body.Bytes(), &rowView) != nil || rowView.Data.ID == "" {
		t.Fatal("row response invalid")
	}
	readback := get(t, handler, "/api/listing/rows/"+rowView.Data.ID, cookie)
	if readback.Code != 200 {
		t.Fatal("normal row GET failed")
	}
	if os.WriteFile(filepath.Join(out, "ordinary-draft-readback.json"), readback.Body.Bytes(), 0600) != nil {
		t.Fatal("draft evidence write failed")
	}
	submitBody, _ := json.Marshal(map[string]any{"store_id": created.Store.UUID, "row_ids": []string{rowView.Data.ID}, "expected_revisions": []map[string]any{{"row_id": rowView.Data.ID, "revision": rowView.Data.Revision}}})
	frozen := postJSON(t, handler, "/api/listing/submit", string(submitBody), "publish-freeze", cookie)
	report["freeze_http_status"] = frozen.Code
	var frozenBody any
	_ = json.Unmarshal(frozen.Body.Bytes(), &frozenBody)
	report["freeze_response"] = frozenBody
	if frozen.Code != 200 {
		report["blocked_stage"] = "normal_freeze_enqueue"
		t.Fatalf("normal freeze/enqueue HTTP %d: %s", frozen.Code, frozen.Body.String())
	}
	var queued struct {
		Data struct {
			Items []struct {
				Created bool `json:"created"`
				Intent  *struct {
					ID    string `json:"id"`
					State string `json:"state"`
				} `json:"intent"`
			} `json:"items"`
		} `json:"data"`
	}
	if json.Unmarshal(frozen.Body.Bytes(), &queued) != nil || len(queued.Data.Items) != 1 || !queued.Data.Items[0].Created || queued.Data.Items[0].Intent == nil || queued.Data.Items[0].Intent.State != "queued" {
		report["blocked_stage"] = "native_freeze_refused"
		t.Fatal("native freeze did not create exactly one queued intent")
	}
	var jobs int
	var jobPayload []byte
	if fixture.QueryRow(ctx, `SELECT count(*) FROM jobs WHERE org_id=$1 AND kind='listing.submit.batch'`, org).Scan(&jobs) != nil || jobs != 1 {
		t.Fatal("native admission did not persist one job")
	}
	if fixture.QueryRow(ctx, `SELECT payload FROM jobs WHERE org_id=$1 AND kind='listing.submit.batch'`, org).Scan(&jobPayload) != nil {
		t.Fatal("frozen job readback missing")
	}
	var batch struct {
		Intents []struct {
			IntentID    string          `json:"intentId"`
			RequestHash string          `json:"requestHash"`
			Import      json.RawMessage `json:"import"`
		} `json:"intents"`
	}
	if json.Unmarshal(jobPayload, &batch) != nil || len(batch.Intents) != 1 || batch.Intents[0].IntentID != queued.Data.Items[0].Intent.ID {
		t.Fatal("frozen job scope mismatch")
	}
	var request struct {
		Items []map[string]any `json:"items"`
	}
	if json.Unmarshal(batch.Intents[0].Import, &request) != nil || len(request.Items) != 1 || request.Items[0]["offer_id"] != offer || request.Items[0]["weight"] != float64(470) || request.Items[0]["currency_code"] != "CNY" {
		t.Fatal("frozen import differs from reviewed supplier data")
	}
	if os.WriteFile(filepath.Join(out, "planned-import.json"), batch.Intents[0].Import, 0600) != nil {
		t.Fatal("frozen import evidence write failed")
	}
	wireSHA := sha256.Sum256(batch.Intents[0].Import)
	if mode == "submit" && !bytes.Equal(batch.Intents[0].Import, approvedPlan) {
		report["blocked_stage"] = "reviewed_wire_bytes_changed"
		t.Fatal("new normal draft freeze differs from the reviewed exact import bytes; no dispatch")
	}
	report["planned_import"] = map[string]any{"method": "POST", "path": "/v3/product/import", "items": 1, "wire_sha256": hex.EncodeToString(wireSHA[:]), "frozen_request_hash": batch.Intents[0].RequestHash, "planned_max_write_attempts": 1, "executed_write_attempts": 0}
	if _, err = fixture.Exec(ctx, `ALTER ROLE podhub_login_listing_worker PASSWORD 'isolated-publish-worker-login'`); err != nil {
		t.Fatal(err)
	}
	workerPool, err := db.Connect(ctx, config.Config{DatabaseURL: swapUser(dsn, "podhub_login_listing_worker", "isolated-publish-worker-login")})
	if err != nil {
		t.Fatal("normal worker pool unavailable")
	}
	defer workerPool.Close()
	localKey, err := seal.SellerKEK(os.Getenv("CLOUD_SELLER_CREDENTIAL_KEY"))
	if err != nil {
		t.Fatal("isolated seller key invalid")
	}
	egress := seller.New(config.Load()).WithPool(workerPool)
	bound, err := appworker.ListingTransport(egress, workerPool, seal.Ring{Primary: localKey}, seal.DefaultSellerKeyID).BindStore(ctx, sellercontract.StoreBinding{OrgID: org, UserID: user, StoreUUID: created.Store.UUID, IntentIDs: []string{batch.Intents[0].IntentID}})
	if err != nil || !bound.WritesDisabled() {
		report["blocked_stage"] = "normal_persisted_store_binding"
		t.Fatal("persisted v2 credential/subscription/member binding failed or kill switch open")
	}
	absenceBody, _ := json.Marshal(map[string]any{"offer_id": []string{offer}})
	status, absenceRaw, err := bound.Read(ctx, "/v3/product/info/list", absenceBody)
	report["new_offer_absence_http_status"] = status
	var absence struct {
		Items *[]json.RawMessage `json:"items"`
	}
	if err != nil || status != 200 || json.Unmarshal([]byte(absenceRaw), &absence) != nil || absence.Items == nil || len(*absence.Items) != 0 {
		report["blocked_stage"] = "exact_new_offer_absence"
		t.Fatal("exact new offer absence was not proven")
	}
	report["new_offer_absent"] = true
	report["worker_binding"] = "standard listing worker role -> persisted fresh v2 credential -> current member/subscription/store/intent checks -> exact official info read; write kill switch remains closed"
	if mode == "submit" {
		runPublicationSubmit(t, ctx, fixture, workerPool, dsn, org, user, created.Store.UUID, batch.Intents[0].IntentID, approvedPlan, localKey, out, sourceDir, report)
		return
	}
	report["passed"] = true
	report["scope"] = "normal session/store/credential/draft/native freeze/tenant enqueue/worker binding/exact new-offer absence preflight; Seller write/readback pending"
}

type publicationDispatch struct {
	base         sellercontract.StoreTransport
	body         []byte
	ledger       string
	calls        int
	status       int
	networkError bool
}

func (p *publicationDispatch) WritesDisabled() bool            { return p.base.WritesDisabled() }
func (p *publicationDispatch) Ready(ctx context.Context) error { return p.base.Ready(ctx) }
func (p *publicationDispatch) Read(ctx context.Context, path string, body []byte) (int, string, error) {
	return p.base.Read(ctx, path, body)
}
func (p *publicationDispatch) Write(context.Context, string, []byte) (int, string, error) {
	return 0, "", sellercontract.ErrNotSent
}
func (p *publicationDispatch) BindStore(ctx context.Context, scope sellercontract.StoreBinding) (sellercontract.Transport, error) {
	bound, err := p.base.BindStore(ctx, scope)
	if err != nil {
		return nil, err
	}
	return publicationBound{Transport: bound, owner: p}, nil
}

type publicationBound struct {
	sellercontract.Transport
	owner *publicationDispatch
}

func (p publicationBound) PhysicalAccountKey() string {
	if physical, ok := p.Transport.(sellercontract.PhysicalAccountTransport); ok {
		return physical.PhysicalAccountKey()
	}
	return ""
}
func (p publicationBound) Write(ctx context.Context, path string, body []byte) (int, string, error) {
	owner := p.owner
	if ctx.Err() != nil || path != "/v3/product/import" || !bytes.Equal(body, owner.body) || owner.calls != 0 {
		return 0, "", sellercontract.ErrNotSent
	}
	file, err := os.OpenFile(owner.ledger, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if err != nil {
		return 0, "", sellercontract.ErrNotSent
	}
	sum := sha256.Sum256(body)
	record, _ := json.Marshal(map[string]any{"at": time.Now().UTC(), "method": "POST", "path": path, "wire_sha256": hex.EncodeToString(sum[:]), "attempt": 1, "scope": "write may be dispatched after this fsynced record; never retry this validation"})
	_, err = file.Write(append(record, '\n'))
	if err == nil {
		err = file.Sync()
	}
	closeErr := file.Close()
	if err == nil {
		err = closeErr
	}
	if err == nil {
		directory, openErr := os.Open(filepath.Dir(owner.ledger))
		if openErr != nil {
			err = openErr
		} else {
			err = directory.Sync()
			_ = directory.Close()
		}
	}
	if err != nil {
		return 0, "", sellercontract.ErrNotSent
	}
	owner.calls++
	status, response, err := p.Transport.Write(ctx, path, body)
	owner.status, owner.networkError = status, err != nil
	return status, response, err
}

func runPublicationSubmit(t *testing.T, ctx context.Context, fixture, workerPool *pgxpool.Pool, dsn string, org, user int64, storeID, intentID string, approved, localKey []byte, out, sourceDir string, report map[string]any) {
	t.Helper()
	report["passed"] = false
	report["scope"] = "one real import and bounded normal scanner readback; not an on-sale claim"
	report["fixture_lifetime"] = "isolated PG is destroyed after this bounded run; ledger snapshots retained, cross-process scanner recovery not verified"
	t.Setenv("OZON_WRITE_KILL_SWITCH", "0")
	report["worker_binding"] = "standard listing worker role -> persisted fresh v2 credential -> current member/subscription/store/intent checks; exact reviewed import enabled behind one-attempt body/ledger guard; generic write port remains loopback-only"
	egress := seller.New(config.Load()).WithPool(workerPool)
	guard := &publicationDispatch{base: appworker.ListingTransport(egress, workerPool, seal.Ring{Primary: localKey}, seal.DefaultSellerKeyID), body: approved, ledger: filepath.Join(sourceDir, "seller-write-attempts.jsonl")}
	defer func() {
		report["seller_writes"] = guard.calls
		if planned, ok := report["planned_import"].(map[string]any); ok {
			planned["executed_write_attempts"] = guard.calls
		}
		report["write_http_status"] = guard.status
		report["write_transport_error"] = guard.networkError
		publicationLedgerSnapshot(t, fixture, org, out)
	}()
	claimed, err := queuerepo.Claim(ctx, workerPool, "listing.submit.batch", "isolated-live-publication", 1)
	if err != nil || len(claimed) != 1 || claimed[0].OrgID != org || claimed[0].SubmitterUserID != user {
		report["blocked_stage"] = "normal_worker_claim"
		t.Fatal("normal worker did not claim the sole original job")
	}
	if err = listingSubmit().Work(ctx, workerPool, claimed[0], guard); err != nil {
		report["worker_returned_error"] = true
	}
	if guard.calls != 1 {
		report["blocked_stage"] = "dispatch_not_executed"
		t.Fatal("approved dispatch did not occur exactly once")
	}
	if _, err = fixture.Exec(ctx, `ALTER ROLE podhub_login_reconciler PASSWORD 'isolated-publish-readback-login'`); err != nil {
		t.Fatal(err)
	}
	readPool, err := db.Connect(ctx, config.Config{DatabaseURL: swapUser(dsn, "podhub_login_reconciler", "isolated-publish-readback-login")})
	if err != nil {
		t.Fatal("normal reconciler pool unavailable")
	}
	defer readPool.Close()
	t.Setenv("OZON_WRITE_KILL_SWITCH", "1")
	report["worker_binding"] = "standard listing worker role -> persisted fresh v2 credential -> current member/subscription/store/intent checks; exact reviewed import enabled behind one-attempt body/ledger guard; write kill switch restored closed before readback; generic write port remains loopback-only"
	readEgress := seller.New(config.Load()).WithPool(readPool)
	scans := []queueservice.DueScan{{Name: "AcceptedImportsScan", Batch: 1}}
	appscans.Attach(scans, readPool, readEgress, seal.Ring{Primary: localKey}, true, seal.DefaultSellerKeyID)
	readbackCtx, cancel := context.WithTimeout(ctx, 6*time.Minute)
	defer cancel()
	for {
		var state, taskID string
		var outcome []byte
		var next *time.Time
		if fixture.QueryRow(ctx, `SELECT state,COALESCE(external_task_id,''),COALESCE(reconciliation_outcome,'{}'::jsonb),reconcile_after FROM submission_intents WHERE org_id=$1 AND id=$2::uuid`, org, intentID).Scan(&state, &taskID, &outcome, &next) != nil {
			t.Fatal("independent actual intent readback failed")
		}
		report["intent_state"], report["external_task_id"] = state, taskID
		report["reconciliation_outcome"] = json.RawMessage(outcome)
		progress, _ := json.Marshal(map[string]any{"at": time.Now().UTC(), "state": state, "task_id": taskID, "seller_writes": guard.calls, "read_requests": readEgress.ReadPosts(), "reconcile_after": next})
		_ = os.WriteFile(filepath.Join(out, "publication-progress.json"), progress, 0600)
		if state != "accepted" && state != "unknown" {
			report["blocked_stage"] = "platform_not_accepted"
			t.Fatalf("real import remains %s; no retry", state)
		}
		if state == "accepted" && next == nil {
			var result struct {
				Task struct {
					Status    string            `json:"status"`
					ProductID int64             `json:"product_id"`
					Errors    []json.RawMessage `json:"errors"`
				} `json:"importTask"`
				Found struct {
					ProductID int64 `json:"productId"`
				} `json:"found"`
			}
			if json.Unmarshal(outcome, &result) != nil || (result.Task.Status != "imported" && result.Task.Status != "skipped") || len(result.Task.Errors) > 0 || result.Found.ProductID <= 0 || result.Found.ProductID != result.Task.ProductID {
				report["blocked_stage"] = "platform_async_import_failed_or_unconfirmed"
				t.Fatal("normal scanner did not confirm a successful task and the same product; no retry")
			}
			reader, err := appworker.ListingTransport(readEgress, readPool, seal.Ring{Primary: localKey}, seal.DefaultSellerKeyID).BindStore(ctx, sellercontract.StoreBinding{OrgID: org, StoreUUID: storeID, IntentIDs: []string{intentID}, ReadOnly: true})
			if err != nil {
				t.Fatal("final product reader binding failed")
			}
			var approvedBody struct {
				Items []struct {
					OfferID string `json:"offer_id"`
				} `json:"items"`
			}
			_ = json.Unmarshal(approved, &approvedBody)
			body, _ := json.Marshal(map[string]any{"offer_id": []string{approvedBody.Items[0].OfferID}})
			status, raw, err := reader.Read(readbackCtx, "/v3/product/info/list", body)
			var product struct {
				Items []struct {
					ID       int64             `json:"id"`
					OfferID  string            `json:"offer_id"`
					Images   []json.RawMessage `json:"images"`
					Statuses struct {
						Status            string `json:"status"`
						StatusName        string `json:"status_name"`
						StatusDescription string `json:"status_description"`
						ValidationStatus  string `json:"validation_status"`
						IsCreated         *bool  `json:"is_created"`
					} `json:"statuses"`
					Stocks struct {
						HasStock *bool `json:"has_stock"`
					} `json:"stocks"`
				} `json:"items"`
			}
			if err != nil || status != 200 || json.Unmarshal([]byte(raw), &product) != nil || len(product.Items) != 1 || product.Items[0].ID != result.Found.ProductID || product.Items[0].OfferID != approvedBody.Items[0].OfferID {
				t.Fatal("final official product state readback mismatch")
			}
			if os.WriteFile(filepath.Join(out, "official-product-readback.json"), []byte(raw), 0600) != nil {
				t.Fatal("product evidence save failed")
			}
			report["product_id"], report["product_image_count"], report["read_requests"] = product.Items[0].ID, len(product.Items[0].Images), readEgress.ReadPosts()
			current := product.Items[0]
			report["platform_product_state"] = map[string]any{"status": current.Statuses.Status, "status_name": current.Statuses.StatusName, "status_description": current.Statuses.StatusDescription, "validation_status": current.Statuses.ValidationStatus, "is_created": current.Statuses.IsCreated, "has_stock": current.Stocks.HasStock}
			created := "unknown"
			if current.Statuses.IsCreated != nil {
				created = strconv.FormatBool(*current.Statuses.IsCreated)
			}
			report["source_network_risk"] = "Local runtime reads originals successfully; tx-podhub source IP saw Cloudflare 1010. This import/readback retained image URL fields; platform is_created=" + created + ". Image URL persistence does not prove Ozon copied/processed the images or completed moderation."
			if len(product.Items[0].Images) == 0 {
				report["product_images_pending"] = true
				select {
				case <-readbackCtx.Done():
					report["blocked_stage"] = "platform_images_unconfirmed"
					t.Fatal("product exists but image URL fields did not persist within six minutes")
				case <-time.After(5 * time.Second):
					continue
				}
			}
			report["passed"] = true
			report["on_sale_verified"] = false
			return
		}
		if state == "accepted" {
			_, err = scans[0].Tick(readbackCtx)
		} else {
			_, err = submit.ProbeDue(readbackCtx, readPool, appworker.ListingTransport(readEgress, readPool, seal.Ring{Primary: localKey}, seal.DefaultSellerKeyID), 1)
		}
		if err != nil {
			report["scanner_error_observed"] = true
		}
		select {
		case <-readbackCtx.Done():
			report["blocked_stage"] = "bounded_readback_unresolved"
			t.Fatal("normal readback has not converged within six minutes; no retry")
		case <-time.After(5 * time.Second):
		}
	}
}

func publicationLedgerSnapshot(t *testing.T, pool *pgxpool.Pool, org int64, out string) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	var raw []byte
	err := pool.QueryRow(ctx, `SELECT json_build_object(
 'intents',COALESCE((SELECT jsonb_agg(jsonb_build_object('id',id,'offer_id',offer_id,'state',state,'row_revision',row_revision,'request_hash',request_hash,'external_task_id',external_task_id,'last_error_code',last_error_code,'submission_receipt',submission_receipt,'reconciliation_outcome',reconciliation_outcome,'submission_issues',submission_issues,'reconcile_after',reconcile_after)) FROM submission_intents WHERE org_id=$1),'[]'::jsonb),
 'writes',COALESCE((SELECT jsonb_agg(jsonb_build_object('idempotency_key',idempotency_key,'state',state,'request_hash',request_hash,'response_status',response_status,'response_body',response_body,'error_code',error_code,'last_observation',last_observation)) FROM seller_upstream_writes WHERE org_id=$1),'[]'::jsonb),
 'row_events',COALESCE((SELECT jsonb_agg(payload) FROM listing_row_events WHERE org_id=$1),'[]'::jsonb),
 'jobs',COALESCE((SELECT jsonb_agg(jsonb_build_object('id',id,'kind',kind,'state',state,'attempt',attempt,'last_error_code',last_error_code,'result_ref',result_ref)) FROM jobs WHERE org_id=$1),'[]'::jsonb))`, org).Scan(&raw)
	if err != nil {
		t.Error("actual ledger evidence query failed")
		return
	}
	if os.WriteFile(filepath.Join(out, "actual-ledger-snapshot.json"), raw, 0600) != nil {
		t.Error("actual ledger evidence save failed")
	}
}

type publicationTestTransport struct{ calls int }

func (p *publicationTestTransport) Write(context.Context, string, []byte) (int, string, error) {
	p.calls++
	return 200, `{"result":{"task_id":1}}`, nil
}
func (*publicationTestTransport) Read(context.Context, string, []byte) (int, string, error) {
	return 200, `{}`, nil
}
func (*publicationTestTransport) Ready(context.Context) error { return nil }
func (*publicationTestTransport) WritesDisabled() bool        { return false }

func TestPublicationSingleDispatchGuard(t *testing.T) {
	path := filepath.Join(t.TempDir(), "attempts.jsonl")
	base := &publicationTestTransport{}
	guard := &publicationDispatch{body: []byte(`{"items":[]}`), ledger: path}
	bound := publicationBound{Transport: base, owner: guard}
	if _, _, err := bound.Write(context.Background(), "/v3/product/import", []byte(`different`)); !errors.Is(err, sellercontract.ErrNotSent) || base.calls != 0 {
		t.Fatal("changed reviewed body was dispatched")
	}
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatal("refusal created an attempt")
	}
	if status, _, err := bound.Write(context.Background(), "/v3/product/import", guard.body); err != nil || status != 200 || base.calls != 1 {
		t.Fatal("first approved dispatch failed")
	}
	if _, _, err := bound.Write(context.Background(), "/v3/product/import", guard.body); !errors.Is(err, sellercontract.ErrNotSent) || base.calls != 1 {
		t.Fatal("same process repeated the dispatch")
	}
	other := publicationBound{Transport: base, owner: &publicationDispatch{body: guard.body, ledger: path}}
	if _, _, err := other.Write(context.Background(), "/v3/product/import", guard.body); !errors.Is(err, sellercontract.ErrNotSent) || base.calls != 1 {
		t.Fatal("existing durable attempt was repeated")
	}
	raw, err := os.ReadFile(path)
	var record struct {
		Attempt int    `json:"attempt"`
		SHA256  string `json:"wire_sha256"`
	}
	sum := sha256.Sum256(guard.body)
	if err != nil || json.Unmarshal(raw, &record) != nil || record.Attempt != 1 || record.SHA256 != hex.EncodeToString(sum[:]) {
		t.Fatal("durable attempt proof invalid")
	}
}

func publicationFields(t *testing.T, sourceDir string) ([]byte, int64) {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join(sourceDir, "official-read-result.json"))
	if err != nil {
		t.Fatal("official schema evidence missing")
	}
	var read struct {
		RecordedAt string `json:"recorded_at_utc"`
		Calls      []struct {
			Kind string `json:"kind"`
			Body struct {
				Result []map[string]any `json:"result"`
			} `json:"body"`
		} `json:"official_read_calls"`
	}
	if json.Unmarshal(raw, &read) != nil {
		t.Fatal("official schema evidence invalid")
	}
	fetched, err := time.Parse(time.RFC3339Nano, read.RecordedAt)
	if err != nil || time.Since(fetched) < -5*time.Minute || time.Since(fetched) >= 24*time.Hour {
		t.Fatal("official schema evidence is stale or has an invalid clock")
	}
	var rows []map[string]any
	for _, f := range catalog.LiveFixedFields() {
		rows = append(rows, map[string]any{"key": f.Key, "label": f.Label, "group": f.Group, "editor": f.Editor, "required": f.Required, "collection": f.Collection, "read_only": f.ReadOnly, "max_value_count": f.MaxValueCount, "options": []any{}})
	}
	for _, call := range read.Calls {
		if call.Kind != "candidate_schema" {
			continue
		}
		if len(call.Body.Result) != 41 {
			t.Fatal("official 41-attribute schema missing")
		}
		for _, attr := range call.Body.Result {
			id := strconv.FormatInt(int64(attr["id"].(float64)), 10)
			dict := int64(attr["dictionary_id"].(float64))
			rawType := attr["type"].(string)
			collection := attr["is_collection"].(bool)
			truncated := dict > 0 && id != "8229"
			field := map[string]any{"key": "attribute_" + id, "label": attr["name"], "group": "属性", "editor": catalog.InferEditor(rawType, collection, dict > 0, truncated), "required": attr["is_required"], "collection": collection, "attribute_id": id, "raw_type": rawType, "complex_group_collection": attr["complex_is_collection"], "options_truncated": truncated, "options": []any{}}
			if dict > 0 {
				field["dictionary_id"] = strconv.FormatInt(dict, 10)
			}
			if complex := int64(attr["attribute_complex_id"].(float64)); complex != 0 {
				field["complex_id"] = strconv.FormatInt(complex, 10)
			}
			if max := int64(attr["max_value_count"].(float64)); max > 0 {
				field["max_value_count"] = max
			}
			if id == "85" {
				field["options"] = []map[string]string{{"id": "126745801", "value": "Нет бренда", "info": "", "picture": ""}}
			}
			if id == "8229" {
				field["options"] = []map[string]string{{"id": "96808", "value": "Коврик для мышки", "info": "", "picture": ""}}
			}
			rows = append(rows, field)
		}
	}
	if len(rows) != 60 {
		t.Fatal("complete actual schema fields missing")
	}
	result, err := json.Marshal(rows)
	if err != nil {
		t.Fatal(err)
	}
	return result, fetched.UnixMilli()
}
