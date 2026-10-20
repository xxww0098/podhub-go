package testkit

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"
)

const tinySpec = `
openapi: 3.0.3
paths:
  /api/items/{id}:
    get:
      responses:
        200:
          description: item
          content:
            application/json:
              schema: {$ref: "#/components/schemas/Item"}
        "204": {description: gone}
        "404": {$ref: "#/components/responses/Err"}
  /api/items/export:
    get:
      responses:
        "200":
          description: csv
          content:
            text/csv:
              schema: {type: string}
components:
  responses:
    Err:
      description: error
      content:
        application/json:
          schema:
            type: object
            additionalProperties: false
            required: [error]
            properties:
              error: {type: string}
  schemas:
    Item:
      type: object
      additionalProperties: false
      required: [id, kind, tags, note]
      properties:
        id: {type: integer, format: int64, minimum: 1}
        kind: {type: string, enum: [a, b]}
        tags:
          type: array
          maxItems: 2
          items: {type: string}
        note: {type: string, nullable: true}
        extra: {type: object}
`

func TestOpenAPICheckResponse(t *testing.T) {
	spec, err := ParseOpenAPI([]byte(tinySpec))
	if err != nil {
		t.Fatal(err)
	}
	if bad := spec.Refs(); len(bad) != 0 {
		t.Fatalf("refs %v", bad)
	}
	jsonHeader := http.Header{"Content-Type": {"application/json"}}
	check := func(method, path string, status int, header http.Header, body string) error {
		return spec.CheckResponse(method, path, status, header, []byte(body))
	}
	if err := check("GET", "/api/items/{id}", 200, jsonHeader, `{"id":1,"kind":"a","tags":["x"],"note":null,"extra":{"any":[1]}}`); err != nil {
		t.Fatal(err)
	}
	if err := check("GET", "/api/items/{id}", 404, http.Header{"Content-Type": {"application/json; charset=utf-8"}}, `{"error":"no"}`); err != nil {
		t.Fatal(err)
	}
	if err := check("GET", "/api/items/{id}", 204, http.Header{}, ``); err != nil {
		t.Fatal(err)
	}
	if err := check("GET", "/api/items/export", 200, http.Header{"Content-Type": {"text/csv; charset=utf-8"}}, "id\n1\n"); err != nil {
		t.Fatal(err)
	}
	if err := check("GET", "/api/items/export", 200, http.Header{}, ""); err == nil {
		t.Fatal("undocumented absent body was accepted")
	}
	for _, tc := range []struct {
		name, method, path string
		status             int
		header             http.Header
		body, want         string
	}{
		{"path", "GET", "/api/nope", 200, jsonHeader, `{}`, "not in openapi.yaml"},
		{"method", "POST", "/api/items/{id}", 200, jsonHeader, `{}`, "not in openapi.yaml"},
		{"status", "GET", "/api/items/{id}", 500, jsonHeader, `{}`, "does not document status 500"},
		{"media", "GET", "/api/items/{id}", 200, http.Header{"Content-Type": {"text/plain"}}, `x`, "does not document text/plain"},
		{"body on empty", "GET", "/api/items/{id}", 204, http.Header{}, `x`, "documents no body"},
		{"required", "GET", "/api/items/{id}", 200, jsonHeader, `{"id":1,"kind":"a","tags":[]}`, `missing required "note"`},
		{"extra", "GET", "/api/items/{id}", 200, jsonHeader, `{"id":1,"kind":"a","tags":[],"note":"","x":1}`, `undocumented property "x"`},
		{"enum", "GET", "/api/items/{id}", 200, jsonHeader, `{"id":1,"kind":"c","tags":[],"note":""}`, "not in enum"},
		{"integer", "GET", "/api/items/{id}", 200, jsonHeader, `{"id":1.5,"kind":"a","tags":[],"note":""}`, "not an integer"},
		{"minimum", "GET", "/api/items/{id}", 200, jsonHeader, `{"id":0,"kind":"a","tags":[],"note":""}`, "below minimum"},
		{"maxItems", "GET", "/api/items/{id}", 200, jsonHeader, `{"id":1,"kind":"a","tags":["a","b","c"],"note":""}`, "maxItems"},
		{"item type", "GET", "/api/items/{id}", 200, jsonHeader, `{"id":1,"kind":"a","tags":[1],"note":""}`, "$.tags[0] is json.Number, want string"},
		{"null", "GET", "/api/items/{id}", 200, jsonHeader, `{"id":1,"kind":"a","tags":null,"note":""}`, "not nullable"},
		{"ref response", "GET", "/api/items/{id}", 404, jsonHeader, `{"error":1}`, "want string"},
	} {
		err := check(tc.method, tc.path, tc.status, tc.header, tc.body)
		if err == nil || !strings.Contains(err.Error(), tc.want) {
			t.Errorf("%s: got %v, want %q", tc.name, err, tc.want)
		}
	}
}

func TestOpenAPIRefsResolve(t *testing.T) {
	spec, err := LoadOpenAPI()
	if err != nil {
		t.Fatal(err)
	}
	if bad := spec.Refs(); len(bad) != 0 {
		t.Fatalf("unresolved $ref: %v", bad)
	}
	bad, err := ParseOpenAPI([]byte("paths:\n  /a:\n    get:\n      responses:\n        \"200\": {$ref: \"#/components/responses/Nope\"}\n"))
	if err != nil {
		t.Fatal(err)
	}
	if refs := bad.Refs(); len(refs) != 1 {
		t.Fatalf("missing ref not reported: %v", refs)
	}
}

func TestOpenAPIPropertiesUseSnakeCase(t *testing.T) {
	spec, err := LoadOpenAPI()
	if err != nil {
		t.Fatal(err)
	}
	var walk func(any, string)
	walk = func(v any, path string) {
		switch value := v.(type) {
		case map[string]any:
			if props, ok := value["properties"].(map[string]any); ok {
				for name := range props {
					if name != strings.ToLower(name) {
						t.Errorf("%s/properties/%s must use snake_case", path, name)
					}
				}
			}
			for key, child := range value {
				walk(child, path+"/"+key)
			}
		case []any:
			for _, child := range value {
				walk(child, path+"/[]")
			}
		}
	}
	walk(spec.doc, "")
}

func TestOpenAPICheckResponseRequiresSingleJSONValue(t *testing.T) {
	spec, err := ParseOpenAPI([]byte(tinySpec))
	if err != nil {
		t.Fatal(err)
	}
	const valid = `{"id":1,"kind":"a","tags":[],"note":null}`
	for _, tc := range []struct {
		name    string
		body    string
		wantErr bool
	}{
		{"single value", valid, false},
		{"trailing whitespace", valid + " \t\r\n", false},
		{"trailing garbage", valid + " garbage", true},
		{"second object", valid + ` {}`, true},
		{"second null", valid + ` null`, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			err := spec.CheckResponse("GET", "/api/items/{id}", 200,
				http.Header{"Content-Type": {"application/json"}}, []byte(tc.body))
			if (err != nil) != tc.wantErr {
				t.Fatalf("CheckResponse() = %v, want error %v", err, tc.wantErr)
			}
		})
	}
}

func TestOpenAPIEmptyBodyRequiresExplicitResponsePermission(t *testing.T) {
	spec, err := LoadOpenAPI()
	if err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		name, method, path string
		status             int
		wantErr            bool
	}{
		{"webhook acknowledged", "POST", "/api/billing/webhooks/{provider}", 200, false},
		{"webhook GET still requires body", "GET", "/api/billing/webhooks/{provider}", 200, true},
		{"webhook error still requires body", "POST", "/api/billing/webhooks/{provider}", 400, true},
		{"AI wallet still requires body", "GET", "/api/ai/wallet", 200, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			err := spec.CheckResponse(tc.method, tc.path, tc.status, http.Header{}, nil)
			if (err != nil) != tc.wantErr {
				t.Fatalf("CheckResponse() = %v, want error %v", err, tc.wantErr)
			}
		})
	}
	tiny, err := ParseOpenAPI([]byte(tinySpec))
	if err != nil {
		t.Fatal(err)
	}
	if err := tiny.CheckResponse("GET", "/api/items/{id}", 200, http.Header{}, nil); err == nil {
		t.Fatal("ordinary JSON response accepted an empty body")
	}
}

func TestOpenAPICheckedUsesRoutePattern(t *testing.T) {
	spec, err := ParseOpenAPI([]byte(tinySpec))
	if err != nil {
		t.Fatal(err)
	}
	router := chi.NewRouter()
	router.Get("/api/items/{id}", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if chi.URLParam(r, "id") == "bad" {
			_, _ = w.Write([]byte(`{"id":1}`))
			return
		}
		_, _ = w.Write([]byte(`{"id":1,"kind":"a","tags":[],"note":null}`))
	})
	router.Get("/api/other", func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`not checked`))
	})
	var failures []error
	h := spec.Checked(router, func(err error) { failures = append(failures, err) }, "/api/items/")
	for _, path := range []string{"/api/items/7", "/api/other", "/api/items/bad"} {
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, path, nil))
		if rec.Code != 200 || rec.Body.Len() == 0 {
			t.Fatalf("%s passthrough %d %q", path, rec.Code, rec.Body.String())
		}
	}
	if len(failures) != 1 || !strings.Contains(failures[0].Error(), "GET /api/items/bad") || !strings.Contains(failures[0].Error(), `missing required "kind"`) {
		t.Fatalf("failures %v", failures)
	}
}
