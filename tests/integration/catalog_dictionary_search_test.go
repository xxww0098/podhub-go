package integration

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/xxww0098/podhub-go/internal/platform/seal"
)

func TestCatalogDictionarySearchPersistsConfirmedValuesAndRefusesFailures(t *testing.T) {
	var searches atomic.Int32
	var broken atomic.Bool
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Client-Id") != "search-client" || r.Header.Get("Api-Key") != "search-secret" {
			t.Error("catalog credential missing")
		}
		switch r.URL.Path {
		case "/v1/description-category/attribute":
			io.WriteString(w, `{"result":[{"id":85,"name":"Brand","type":"String","dictionary_id":33,"is_required":true}]}`)
		case "/v1/description-category/attribute/values":
			values := make([]map[string]any, 201)
			for i := range values {
				values[i] = map[string]any{"id": i + 1, "value": fmt.Sprintf("brand-%d", i+1)}
			}
			json.NewEncoder(w).Encode(map[string]any{"result": values, "has_next": false})
		case "/v1/description-category/attribute/values/search":
			searches.Add(1)
			var input map[string]any
			json.NewDecoder(r.Body).Decode(&input)
			if input["attribute_id"] != float64(85) || input["language"] != "ZH_HANS" || input["value"] != "live" {
				t.Errorf("bad official search input: %+v", input)
			}
			if broken.Load() {
				io.WriteString(w, `{"result":null}`)
				return
			}
			io.WriteString(w, `{"result":[{"id":99999,"value":"live-brand","info":"confirmed","picture":""}]}`)
		default:
			t.Errorf("unexpected upstream path %s", r.URL.Path)
			w.WriteHeader(404)
		}
	}))
	defer upstream.Close()
	t.Setenv("CLOUD_SELLER_BASE_URL", upstream.URL+"/")
	t.Setenv("CLOUD_SELLER_CREDENTIAL_KEY", "search-seal-key")
	f := newIdentityRuntimeFixture(t)
	nonce, cipher, err := seal.SealBlob(seal.DeriveKEK("search-seal-key"), "v1", []byte("search-secret"))
	if err != nil {
		t.Fatal(err)
	}
	if _, err = f.fixture.Exec(f.ctx, `INSERT INTO platform_catalog_fetch_config(singleton) VALUES(true);`); err != nil {
		t.Fatal(err)
	}
	if _, err = f.fixture.Exec(f.ctx, `INSERT INTO platform_catalog_fetch_keys(position,client_id,api_key_key_id,api_key_nonce,api_key_ciphertext) VALUES(1,'search-client','v1',$1,$2)`, nonce, cipher); err != nil {
		t.Fatal(err)
	}
	token := identityRuntimeToken(t, f.request("POST", "/api/auth/login", `{"email":"a96311@example.invalid","password":"original-password"}`, "", "dictionary-search"))
	path := "/api/catalog/schema?description_category_id=17027906&type_id=91976&language=zh_hans"
	if response := f.request("GET", path, "", token, ""); response.Code != 200 {
		t.Fatalf("schema: %d %s", response.Code, response.Body.String())
	}
	query := `{"description_category_id":17027906,"type_id":91976,"attribute_id":85,"language":"zh_hans","limit":100,"value":"live"}`
	const endpoint = "/api/catalog/schema/dictionary-search"
	response := f.request("POST", endpoint, query, token, "")
	if response.Code != 200 || !strings.Contains(response.Body.String(), `"id":"99999"`) || strings.Contains(response.Body.String(), "search-secret") {
		t.Fatalf("search: %d %s", response.Code, response.Body.String())
	}
	var label string
	if err = f.fixture.QueryRow(f.ctx, `SELECT value FROM catalog_dictionary_search_material WHERE attribute_id=85 AND option_id=99999`).Scan(&label); err != nil || label != "live-brand" {
		t.Fatalf("confirmed value not persisted: %q %v", label, err)
	}
	if response = f.request("GET", path, "", token, ""); response.Code != 200 || !strings.Contains(response.Body.String(), "live-brand") {
		t.Fatalf("independent material read: %d %s", response.Code, response.Body.String())
	}
	before := searches.Load()
	for _, tc := range []struct {
		body, token string
		status      int
	}{{query, "", 401}, {strings.Replace(query, `"attribute_id":85`, `"attribute_id":999`, 1), token, 400}, {strings.Replace(query, `"limit":100`, `"limit":1000`, 1), token, 400}} {
		if response = f.request("POST", endpoint, tc.body, tc.token, ""); response.Code != tc.status {
			t.Fatalf("invalid request: %d want %d %s", response.Code, tc.status, response.Body.String())
		}
	}
	if searches.Load() != before {
		t.Fatal("invalid requests reached Seller")
	}
	broken.Store(true)
	if response = f.request("POST", endpoint, query, token, ""); response.Code != 502 {
		t.Fatalf("malformed success accepted: %d %s", response.Code, response.Body.String())
	}
	f.assertClean(t)
}
