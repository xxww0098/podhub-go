package integration

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/xxww0098/podhub-go/internal/listing/core"
	"github.com/xxww0098/podhub-go/internal/platform/seal"
)

func TestCatalogLiveSchemaProductionRolePersistsAndReadsSearchMaterial(t *testing.T) {
	const secret = "qa-catalog-live-key"
	var calls atomic.Int32
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		if r.Method != http.MethodPost || r.Header.Get("Client-Id") != "qa-catalog" || r.Header.Get("Api-Key") != secret {
			t.Error("catalog read lost its admitted credential")
		}
		switch r.URL.Path {
		case "/v1/description-category/attribute":
			_, _ = io.WriteString(w, `{"result":[{"id":85,"name":"Бренд","type":"string","dictionary_id":33,"is_required":true}]}`)
		case "/v1/description-category/attribute/values":
			values := make([]map[string]any, 201)
			for i := range values {
				values[i] = map[string]any{"id": i + 1, "value": fmt.Sprintf("brand-%d", i+1)}
			}
			_ = json.NewEncoder(w).Encode(map[string]any{"result": values, "has_next": false})
		default:
			t.Errorf("unexpected catalog path %s", r.URL.Path)
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	t.Cleanup(upstream.Close)
	t.Setenv("CLOUD_SELLER_BASE_URL", upstream.URL+"/")
	t.Setenv("CLOUD_SELLER_CREDENTIAL_KEY", "qa-catalog-live-seal-key")
	f := newIdentityRuntimeFixture(t)
	nonce, ciphertext, err := seal.SealBlob(seal.DeriveKEK("qa-catalog-live-seal-key"), "catalog-v1", []byte(secret))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.fixture.Exec(f.ctx, `INSERT INTO platform_catalog_fetch_config(singleton) VALUES(true)`); err != nil {
		t.Fatal(err)
	}
	if _, err := f.fixture.Exec(f.ctx, `INSERT INTO platform_catalog_fetch_keys(position,client_id,api_key_key_id,api_key_nonce,api_key_ciphertext) VALUES (1,'qa-catalog','catalog-v1',$1,$2)`, nonce, ciphertext); err != nil {
		t.Fatal(err)
	}
	if _, err := f.fixture.Exec(f.ctx, `INSERT INTO catalog_dictionary_search_material(description_category_id,type_id,language,attribute_id,dictionary_id,option_id,value) VALUES (17027906,91976,'ru',85,33,99999,'qa-indexed-brand')`); err != nil {
		t.Fatal(err)
	}
	token := identityRuntimeToken(t, f.request(http.MethodPost, "/api/auth/login", `{"email":"a96311@example.invalid","password":"original-password"}`, "", "catalog-live"))
	const path = "/api/catalog/schema?description_category_id=17027906&type_id=91976&language=ru"
	first := f.request(http.MethodGet, path, "", token, "")
	if first.Code != http.StatusOK || !strings.Contains(first.Body.String(), "qa-indexed-brand") || strings.Contains(first.Body.String(), secret) || !strings.Contains(first.Body.String(), `"options_truncated":true`) {
		t.Fatalf("live schema response: %d %s", first.Code, first.Body.String())
	}
	var stored int
	var revision string
	if err := f.fixture.QueryRow(f.ctx, `SELECT count(*), COALESCE(max(schema_revision), '') FROM ozon_category_current WHERE description_category_id=17027906 AND type_id=91976 AND language='ru' AND fields <> '[]'::jsonb`).Scan(&stored, &revision); err != nil || stored != 1 || revision == "" {
		t.Fatalf("live current row persisted=%d revision=%q err=%v", stored, revision, err)
	}
	if calls.Load() != 2 {
		t.Fatalf("live upstream calls=%d", calls.Load())
	}
	second := f.request(http.MethodGet, path, "", token, "")
	if second.Code != http.StatusOK || calls.Load() != 2 {
		t.Fatalf("cache was not reused: status=%d calls=%d", second.Code, calls.Load())
	}
	var firstBody, secondBody any
	if json.Unmarshal(first.Body.Bytes(), &firstBody) != nil || json.Unmarshal(second.Body.Bytes(), &secondBody) != nil || !reflect.DeepEqual(firstBody, secondBody) {
		t.Fatalf("cached response changed: %s vs %s", first.Body.String(), second.Body.String())
	}
	var updatedBefore, updatedAfter, revisionsBefore, revisionsAfter int64
	if err := f.fixture.QueryRow(f.ctx, `SELECT (extract(epoch FROM updated_at)*1000000)::bigint FROM ozon_category_current WHERE description_category_id=17027906 AND type_id=91976 AND language='ru'`).Scan(&updatedBefore); err != nil {
		t.Fatal(err)
	}
	if err := f.fixture.QueryRow(f.ctx, `SELECT count(*) FROM listing_schema_revisions`).Scan(&revisionsBefore); err != nil {
		t.Fatal(err)
	}
	third := f.request(http.MethodGet, path, "", token, "")
	if third.Code != http.StatusOK || calls.Load() != 2 {
		t.Fatalf("third read missed: status=%d calls=%d", third.Code, calls.Load())
	}
	if err := f.fixture.QueryRow(f.ctx, `SELECT (extract(epoch FROM updated_at)*1000000)::bigint FROM ozon_category_current WHERE description_category_id=17027906 AND type_id=91976 AND language='ru'`).Scan(&updatedAfter); err != nil {
		t.Fatal(err)
	}
	if err := f.fixture.QueryRow(f.ctx, `SELECT count(*) FROM listing_schema_revisions`).Scan(&revisionsAfter); err != nil {
		t.Fatal(err)
	}
	if updatedBefore != updatedAfter || revisionsBefore != revisionsAfter {
		t.Fatalf("fresh schema read wrote: current=%d->%d revisions=%d->%d", updatedBefore, updatedAfter, revisionsBefore, revisionsAfter)
	}
	var served struct {
		Fields json.RawMessage `json:"fields"`
		Native struct {
			Snapshot json.RawMessage `json:"snapshot"`
		} `json:"native_material"`
	}
	if err := json.Unmarshal(first.Body.Bytes(), &served); err != nil {
		t.Fatal(err)
	}
	mod, err := core.Shared(f.ctx)
	if err != nil {
		t.Fatal(err)
	}
	input, _ := json.Marshal(map[string]any{"description_category_id": 17027906, "type_id": 91976, "fields": served.Fields})
	snapshot, err := mod.Snapshot(f.ctx, input)
	if err != nil {
		t.Fatal(err)
	}
	var version struct {
		Revision string `json:"schema_revision"`
	}
	if err := json.Unmarshal(snapshot, &version); err != nil {
		t.Fatal(err)
	}
	var registered, servedSame bool
	if err := f.fixture.QueryRow(f.ctx, `SELECT snapshot=$2::jsonb,$2::jsonb=$3::jsonb FROM listing_schema_revisions WHERE schema_revision=$1`, version.Revision, string(snapshot), string(served.Native.Snapshot)).Scan(&registered, &servedSame); err != nil || !registered || !servedSame {
		t.Fatalf("canonical snapshot registry=%v served=%v err=%v", registered, servedSame, err)
	}
	var storedRevision string
	if err := f.fixture.QueryRow(f.ctx, `SELECT schema_revision FROM ozon_category_current WHERE description_category_id=17027906 AND type_id=91976 AND language='ru'`).Scan(&storedRevision); err != nil || storedRevision != version.Revision {
		t.Fatalf("current schema revision=%q want %q err=%v", storedRevision, version.Revision, err)
	}
	// An existing immutable version may have an older display order and labels.
	var historical map[string]any
	if err := json.Unmarshal(snapshot, &historical); err != nil {
		t.Fatal(err)
	}
	fields := historical["fields"].([]any)
	for i, j := 0, len(fields)-1; i < j; i, j = i+1, j-1 {
		fields[i], fields[j] = fields[j], fields[i]
	}
	fields[0].(map[string]any)["label"] = "Older display label"
	oldSnapshot, _ := json.Marshal(historical)
	if _, err := f.fixture.Exec(f.ctx, `UPDATE listing_schema_revisions SET snapshot=$2::jsonb WHERE schema_revision=$1`, version.Revision, string(oldSnapshot)); err != nil {
		t.Fatal(err)
	}
	if _, err := f.fixture.Exec(f.ctx, `UPDATE ozon_category_current SET fetched_at_ms=1`); err != nil {
		t.Fatal(err)
	}
	refreshed := f.request(http.MethodGet, path, "", token, "")
	if refreshed.Code != http.StatusOK || calls.Load() != 4 || !strings.Contains(refreshed.Body.String(), version.Revision) {
		t.Fatalf("display-only refresh rejected: %d calls=%d %s", refreshed.Code, calls.Load(), refreshed.Body.String())
	}
	if err := f.fixture.QueryRow(f.ctx, `SELECT snapshot=$2::jsonb FROM listing_schema_revisions WHERE schema_revision=$1`, version.Revision, string(oldSnapshot)).Scan(&registered); err != nil || !registered {
		t.Fatalf("display refresh overwrote immutable registry: %v %v", registered, err)
	}
	card := f.request(http.MethodPost, "/api/listing/cards", `{"title":"qa-catalog-live","createMode":"blank","payload":{"categoryKey":"workflow:17027906:91976","descriptionCategoryId":17027906,"typeId":91976,"language":"ru","aiFieldPolicy":{"allowed_field_keys":[],"protected_field_keys":[]},"defaults":{"values":{},"complex_values":[]}}}`, token, "catalog-live-card")
	var created struct {
		Data struct{ ID string } `json:"data"`
	}
	if card.Code != http.StatusOK || json.Unmarshal(card.Body.Bytes(), &created) != nil || created.Data.ID == "" {
		t.Fatalf("create card: %d %s", card.Code, card.Body.String())
	}
	rowBody, _ := json.Marshal(map[string]any{"cardId": created.Data.ID, "source": map[string]string{"sha256": strings.Repeat("a", 64), "fileName": "qa-catalog-source.png"}, "draft": map[string]any{"values": map[string]any{}, "complex_values": []any{}}})
	row := f.request(http.MethodPost, "/api/listing/rows", string(rowBody), token, "catalog-live-row")
	if row.Code != http.StatusOK || !strings.Contains(row.Body.String(), version.Revision) {
		t.Fatalf("live schema could not create a canonical row: %d %s", row.Code, row.Body.String())
	}
	// The same claimed revision with changed constraints remains a conflict.
	field := fields[0].(map[string]any)
	field["required"] = !field["required"].(bool)
	corrupt, _ := json.Marshal(historical)
	if _, err := f.fixture.Exec(f.ctx, `UPDATE listing_schema_revisions SET snapshot=$2::jsonb WHERE schema_revision=$1`, version.Revision, string(corrupt)); err != nil {
		t.Fatal(err)
	}
	rowConflict := f.request(http.MethodPost, "/api/listing/rows", string(rowBody), token, "catalog-conflicting-row")
	if rowConflict.Code != http.StatusConflict {
		t.Fatalf("semantic conflict accepted for row: %d %s", rowConflict.Code, rowConflict.Body.String())
	}
	if _, err := f.fixture.Exec(f.ctx, `UPDATE ozon_category_current SET fetched_at_ms=1`); err != nil {
		t.Fatal(err)
	}
	conflict := f.request(http.MethodGet, path, "", token, "")
	if conflict.Code != http.StatusBadGateway {
		t.Fatalf("semantic conflict accepted for refresh: %d %s", conflict.Code, conflict.Body.String())
	}
	if err := f.fixture.QueryRow(f.ctx, `SELECT snapshot=$2::jsonb FROM listing_schema_revisions WHERE schema_revision=$1`, version.Revision, string(corrupt)).Scan(&registered); err != nil || !registered {
		t.Fatalf("conflicting refresh overwrote immutable registry: %v %v", registered, err)
	}
	f.assertClean(t)
}
