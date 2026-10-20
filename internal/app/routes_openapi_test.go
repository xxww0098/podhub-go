package app

import (
	"fmt"
	"os"
	"sort"
	"strings"
	"testing"

	"go.yaml.in/yaml/v3"
)

// routesOpenAPIAllowlistMax is the number of routes.txt entries absent from
// api/openapi.yaml when this ratchet was added. Lower it when a route is
// documented and deleted from the allowlist. Do not raise it.
//
// The unit is method+path, not path. A path-level allowlist let a documented
// GET hide an undocumented POST on the same path, which is how
// POST /api/admin/banned-tags stayed invisible.
const routesOpenAPIAllowlistMax = 0

// TestRoutePathsCoveredByOpenAPI keeps every routes.txt entry inside the
// OpenAPI document or the shrinking allowlist.
func TestRoutePathsCoveredByOpenAPI(t *testing.T) {
	routeText, err := os.ReadFile("testdata/routes.txt")
	if err != nil {
		t.Fatal(err)
	}
	specText, err := os.ReadFile("../../api/openapi.yaml")
	if err != nil {
		t.Fatal(err)
	}
	allowText, err := os.ReadFile("testdata/routes_openapi_allowlist.txt")
	if err != nil {
		t.Fatal(err)
	}
	routes, err := routeEntries(string(routeText))
	if err != nil {
		t.Fatal(err)
	}
	spec, wildcards, err := openAPIOperations(specText)
	if err != nil {
		t.Fatal(err)
	}
	// Catch-alls are compared in chi's own spelling so the coverage loop
	// sees them as documented, not as missing.
	for _, w := range wildcards {
		spec = append(spec, w)
	}
	sort.Strings(spec)
	allow, err := allowlistEntries(string(allowText))
	if err != nil {
		t.Fatal(err)
	}
	if len(allow) != routesOpenAPIAllowlistMax {
		t.Errorf("allowlist has %d entries, ceiling is %d; the ceiling may only decrease", len(allow), routesOpenAPIAllowlistMax)
	}
	for _, msg := range openAPICoverageErrors(routes, spec, allow) {
		t.Error(msg)
	}
}

func TestOpenAPICoverageRatchet(t *testing.T) {
	routes := []string{"GET /api/a", "POST /api/b", "GET /api/c/{id}"}
	spec := []string{"GET /api/a", "GET /api/c/{id}"}
	allow := []string{"POST /api/b"}
	if msgs := openAPICoverageErrors(routes, spec, allow); len(msgs) != 0 {
		t.Fatalf("covered set: %v", msgs)
	}
	if msgs := openAPICoverageErrors(append(routes, "GET /api/new"), spec, allow); len(msgs) != 1 || !strings.Contains(msgs[0], "/api/new") {
		t.Fatalf("new route: %v", msgs)
	}
	if msgs := openAPICoverageErrors(append(routes, "POST /api/a"), spec, allow); len(msgs) != 1 || !strings.Contains(msgs[0], "POST /api/a") {
		t.Fatalf("a documented method must not hide an undocumented one: %v", msgs)
	}
	if msgs := openAPICoverageErrors(routes, append(spec, "POST /api/b"), allow); len(msgs) != 1 || !strings.Contains(msgs[0], "delete") {
		t.Fatalf("covered allowlist entry: %v", msgs)
	}
	if msgs := openAPICoverageErrors(routes[:1], spec, allow); len(msgs) != 1 || !strings.Contains(msgs[0], "not in routes.txt") {
		t.Fatalf("stale allowlist entry: %v", msgs)
	}
}

func openAPICoverageErrors(routes, spec, allow []string) []string {
	routeSet := setOf(routes)
	specSet := setOf(spec)
	allowSet := setOf(allow)
	var msgs []string
	for _, entry := range allow {
		switch {
		case specSet[entry]:
			msgs = append(msgs, "allowlist entry is now in openapi.yaml, delete it: "+entry)
		case !routeSet[entry]:
			msgs = append(msgs, "allowlist entry is not in routes.txt, delete it: "+entry)
		}
	}
	for _, entry := range routes {
		if specSet[entry] || allowSet[entry] {
			continue
		}
		msgs = append(msgs, "route is not in openapi.yaml: "+entry)
	}
	return msgs
}

// routeEntries keeps the method: a path that is documented for GET says
// nothing about whether POST exists.
func routeEntries(src string) ([]string, error) {
	seen := map[string]bool{}
	var out []string
	for i, line := range splitLines(src) {
		method, p, ok := strings.Cut(line, " ")
		if !ok || method == "" || !strings.HasPrefix(p, "/") || strings.Contains(p, " ") {
			return nil, errLine("routes.txt", i+1)
		}
		entry := method + " " + p
		if !seen[entry] {
			seen[entry] = true
			out = append(out, entry)
		}
	}
	sort.Strings(out)
	return out, nil
}

// openAPIOperations returns every "METHOD /path" the document declares, plus
// the "METHOD /path/*" spelling of any operation carrying x-podhub-path.
//
// It parses YAML rather than scanning indentation, so a reformatted spec
// cannot silently empty the spec side of the ratchet. OpenAPI 3.0 has no
// native multi-segment wildcard, so a chi catch-all is documented as a named
// parameter plus x-podhub-path. chi registers "/*", and the two spellings
// must be compared as equal or the route could never leave the allowlist.
func openAPIOperations(src []byte) ([]string, []string, error) {
	var doc struct {
		Paths map[string]map[string]any `yaml:"paths"`
	}
	if err := yaml.Unmarshal(src, &doc); err != nil {
		return nil, nil, err
	}
	if len(doc.Paths) == 0 {
		return nil, nil, errLine("openapi.yaml has no paths", 0)
	}
	var out, wild []string
	for path, item := range doc.Paths {
		ext, _ := item["x-podhub-path"].(string)
		for method := range item {
			switch strings.ToLower(method) {
			case "get", "post", "put", "patch", "delete", "head", "options", "trace":
				out = append(out, strings.ToUpper(method)+" "+path)
				if ext != "" {
					wild = append(wild, strings.ToUpper(method)+" "+ext)
				}
			}
		}
	}
	sort.Strings(out)
	sort.Strings(wild)
	return out, wild, nil
}

func allowlistEntries(src string) ([]string, error) {
	var out []string
	seen := map[string]bool{}
	for i, line := range splitLines(src) {
		if strings.HasPrefix(line, "#") {
			continue
		}
		method, p, ok := strings.Cut(line, " ")
		if !ok || method != strings.ToUpper(method) || !strings.HasPrefix(p, "/") || strings.Contains(p, " ") {
			return nil, errLine("routes_openapi_allowlist.txt", i+1)
		}
		if seen[line] {
			return nil, errLine("duplicate allowlist entry "+line, i+1)
		}
		seen[line] = true
		out = append(out, line)
	}
	if !sort.StringsAreSorted(out) {
		return nil, errLine("routes_openapi_allowlist.txt is not sorted", 0)
	}
	return out, nil
}

func splitLines(src string) []string {
	src = strings.TrimSuffix(src, "\n")
	if src == "" {
		return nil
	}
	return strings.Split(src, "\n")
}

func setOf(entries []string) map[string]bool {
	out := make(map[string]bool, len(entries))
	for _, e := range entries {
		out[e] = true
	}
	return out
}

func errLine(what string, n int) error {
	if n == 0 {
		return fmt.Errorf("%s", what)
	}
	return fmt.Errorf("%s:%d", what, n)
}
