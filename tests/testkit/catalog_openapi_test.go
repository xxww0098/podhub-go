package testkit

import (
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"go.yaml.in/yaml/v3"
)

func TestCatalogTreeFlatContract(t *testing.T) {
	spec, err := LoadOpenAPI()
	if err != nil {
		t.Fatal(err)
	}
	const root = `{"language":"en","fetched_at_ms":1,"items":[` +
		`{"description_category_id":1,"category_name":"root","type_id":10,"type_name":"type","disabled":false,"parent_id":null},` +
		`{"description_category_id":0,"category_name":"","type_id":30,"type_name":"leaf","disabled":false,"parent_id":10}]}`
	for _, tc := range []struct {
		name      string
		node      string
		wantError string
	}{
		{"flat nodes", root, ""},
		{"wrong node type", strings.Replace(root, `"disabled":false,"parent_id":10`, `"disabled":"false","parent_id":10`, 1), ".disabled"},
		{"missing node field", strings.Replace(root, `"type_name":"leaf",`, "", 1), `missing required "type_name"`},
		{"unknown node field", strings.Replace(root, `"parent_id":10`, `"parent_id":10,"unexpected":true`, 1), "unexpected"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			err := spec.CheckResponse(http.MethodGet, "/api/catalog/tree", http.StatusOK,
				http.Header{"Content-Type": {"application/json"}}, []byte(tc.node))
			if tc.wantError == "" {
				if err != nil {
					t.Fatal(err)
				}
				return
			}
			if err == nil || !strings.Contains(err.Error(), tc.wantError) {
				t.Fatalf("expected error containing %q, got %v", tc.wantError, err)
			}
		})
	}
}

func TestCatalogTreeGeneratedModelIsolation(t *testing.T) {
	_, file, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("runtime caller")
	}
	root := filepath.Join(filepath.Dir(file), "..", "..")
	configs, err := filepath.Glob(filepath.Join(root, "api", "codegen", "*.yaml"))
	if err != nil {
		t.Fatal(err)
	}
	if len(configs) == 0 {
		t.Fatal("no generator configs")
	}
	for _, path := range configs {
		t.Run(filepath.Base(path), func(t *testing.T) {
			raw, err := os.ReadFile(path)
			if err != nil {
				t.Fatal(err)
			}
			var cfg struct {
				Output string `yaml:"output"`
			}
			if err := yaml.Unmarshal(raw, &cfg); err != nil {
				t.Fatal(err)
			}
			generated, err := os.ReadFile(filepath.Join(root, cfg.Output))
			if err != nil {
				t.Fatal(err)
			}
			count := strings.Count(string(generated), "type CatalogTreeNode struct {")
			want := 0
			if filepath.Base(path) == "catalog-reads.yaml" {
				want = 1
			}
			if count != want {
				t.Fatalf("%s: CatalogTreeNode declarations = %d, want %d", cfg.Output, count, want)
			}
		})
	}
}
