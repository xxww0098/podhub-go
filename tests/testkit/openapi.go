package testkit

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"mime"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strconv"
	"strings"

	"github.com/go-chi/chi/v5"
	"go.yaml.in/yaml/v3"
)

// OpenAPI checks recorded responses against the OpenAPI 3.0 document. It
// understands the schema keywords api/openapi.yaml uses: $ref, type,
// nullable, enum, required, properties, additionalProperties, items,
// minItems, maxItems, minimum, maximum, allOf, anyOf, and oneOf. Other
// keywords are ignored.
type OpenAPI struct {
	doc map[string]any
}

// LoadOpenAPI reads api/openapi.yaml from the repository root.
func LoadOpenAPI() (*OpenAPI, error) {
	_, file, _, ok := runtime.Caller(0)
	if !ok {
		return nil, fmt.Errorf("runtime caller")
	}
	raw, err := os.ReadFile(filepath.Join(filepath.Dir(file), "..", "..", "api", "openapi.yaml"))
	if err != nil {
		return nil, err
	}
	return ParseOpenAPI(raw)
}

func ParseOpenAPI(raw []byte) (*OpenAPI, error) {
	var doc any
	if err := yaml.Unmarshal(raw, &doc); err != nil {
		return nil, err
	}
	m, ok := stringKeys(doc).(map[string]any)
	if !ok {
		return nil, fmt.Errorf("openapi document is not a mapping")
	}
	return &OpenAPI{doc: m}, nil
}

// Refs lists every $ref in the document that does not resolve.
func (o *OpenAPI) Refs() []string {
	var bad []string
	var walk func(any)
	walk = func(v any) {
		switch t := v.(type) {
		case map[string]any:
			if ref, ok := t["$ref"].(string); ok {
				if _, err := o.lookup(ref); err != nil {
					bad = append(bad, ref)
				}
			}
			for _, child := range t {
				walk(child)
			}
		case []any:
			for _, child := range t {
				walk(child)
			}
		}
	}
	walk(o.doc)
	sort.Strings(bad)
	return bad
}

// CheckResponse fails when status is not documented for method and path, when
// the body's media type is not documented for that status, or when a JSON
// body does not match the documented schema. A response with no bytes and no
// Content-Type passes any documented content. path is the spec template, for
// example /api/items/{id}.
func (o *OpenAPI) CheckResponse(method, path string, status int, header http.Header, body []byte) error {
	paths, _ := o.doc["paths"].(map[string]any)
	item, ok := paths[path].(map[string]any)
	if !ok {
		return fmt.Errorf("%s is not in openapi.yaml", path)
	}
	op, ok := item[strings.ToLower(method)].(map[string]any)
	if !ok {
		return fmt.Errorf("%s %s is not in openapi.yaml", method, path)
	}
	responses, _ := op["responses"].(map[string]any)
	resp, ok := responses[strconv.Itoa(status)].(map[string]any)
	if !ok {
		if resp, ok = responses["default"].(map[string]any); !ok {
			return fmt.Errorf("%s %s does not document status %d", method, path, status)
		}
	}
	resp, err := o.deref(resp)
	if err != nil {
		return err
	}
	content, _ := resp["content"].(map[string]any)
	if len(content) == 0 {
		if len(body) != 0 {
			return fmt.Errorf("%s %s %d documents no body, got %d bytes", method, path, status, len(body))
		}
		return nil
	}
	// Only responses explicitly documenting an optional body may omit it.
	if resp["x-allow-empty-body"] == true && len(body) == 0 && header.Get("Content-Type") == "" {
		return nil
	}
	mediaType, _, err := mime.ParseMediaType(header.Get("Content-Type"))
	if err != nil {
		return fmt.Errorf("%s %s %d content type %q: %w", method, path, status, header.Get("Content-Type"), err)
	}
	media, ok := content[mediaType].(map[string]any)
	if !ok {
		return fmt.Errorf("%s %s %d does not document %s", method, path, status, mediaType)
	}
	if mediaType != "application/json" {
		return nil
	}
	schema, _ := media["schema"].(map[string]any)
	if schema == nil {
		return nil
	}
	dec := json.NewDecoder(bytes.NewReader(body))
	dec.UseNumber()
	var value any
	if err := dec.Decode(&value); err != nil {
		return fmt.Errorf("%s %s %d body: %w", method, path, status, err)
	}
	// A response must contain exactly one JSON value, followed only by whitespace.
	var extra any
	if err := dec.Decode(&extra); err != io.EOF {
		if err != nil {
			return fmt.Errorf("%s %s %d body trailing data: %w", method, path, status, err)
		}
		return fmt.Errorf("%s %s %d body contains multiple JSON values", method, path, status)
	}
	if err := o.validate(schema, value, "$"); err != nil {
		return fmt.Errorf("%s %s %d: %w", method, path, status, err)
	}
	return nil
}

// Checked wraps a chi router. Each response whose matched route pattern
// starts with one of prefixes is passed to CheckResponse, and a failure goes
// to report. The response reaches w unchanged, after h returns.
func (o *OpenAPI) Checked(h http.Handler, report func(error), prefixes ...string) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		rctx := chi.NewRouteContext()
		r = r.WithContext(context.WithValue(r.Context(), chi.RouteCtxKey, rctx))
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, r)
		for k, v := range rec.Header() {
			w.Header()[k] = v
		}
		w.WriteHeader(rec.Code)
		_, _ = w.Write(rec.Body.Bytes())
		pattern := rctx.RoutePattern()
		for _, prefix := range prefixes {
			if strings.HasPrefix(pattern, prefix) {
				if err := o.CheckResponse(r.Method, pattern, rec.Code, rec.Header(), rec.Body.Bytes()); err != nil {
					report(fmt.Errorf("%s %s: %w", r.Method, r.URL.RequestURI(), err))
				}
				return
			}
		}
	})
}

func (o *OpenAPI) validate(schema map[string]any, v any, at string) error {
	schema, err := o.deref(schema)
	if err != nil {
		return err
	}
	for _, sub := range schemaList(schema["allOf"]) {
		if err := o.validate(sub, v, at); err != nil {
			return err
		}
	}
	if subs := schemaList(schema["anyOf"]); len(subs) > 0 {
		if o.matches(subs, v, at) == 0 {
			return fmt.Errorf("%s matches no anyOf branch", at)
		}
	}
	if subs := schemaList(schema["oneOf"]); len(subs) > 0 {
		if n := o.matches(subs, v, at); n != 1 {
			return fmt.Errorf("%s matches %d oneOf branches", at, n)
		}
	}
	typ, _ := schema["type"].(string)
	if v == nil {
		if typ == "" || schema["nullable"] == true {
			return nil
		}
		return fmt.Errorf("%s is null, schema type %s is not nullable", at, typ)
	}
	if enum, ok := schema["enum"].([]any); ok && !inEnum(enum, v) {
		return fmt.Errorf("%s value %v is not in enum %v", at, v, enum)
	}
	switch typ {
	case "":
		return nil
	case "object":
		obj, ok := v.(map[string]any)
		if !ok {
			return fmt.Errorf("%s is %T, want object", at, v)
		}
		props, _ := schema["properties"].(map[string]any)
		for _, name := range stringList(schema["required"]) {
			if _, ok := obj[name]; !ok {
				return fmt.Errorf("%s is missing required %q", at, name)
			}
		}
		keys := make([]string, 0, len(obj))
		for k := range obj {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		for _, k := range keys {
			if prop, ok := props[k].(map[string]any); ok {
				if err := o.validate(prop, obj[k], at+"."+k); err != nil {
					return err
				}
				continue
			}
			switch extra := schema["additionalProperties"].(type) {
			case bool:
				if !extra {
					return fmt.Errorf("%s has undocumented property %q", at, k)
				}
			case map[string]any:
				if err := o.validate(extra, obj[k], at+"."+k); err != nil {
					return err
				}
			}
		}
		return nil
	case "array":
		list, ok := v.([]any)
		if !ok {
			return fmt.Errorf("%s is %T, want array", at, v)
		}
		if n, ok := number(schema["maxItems"]); ok && float64(len(list)) > n {
			return fmt.Errorf("%s has %d items, maxItems %v", at, len(list), n)
		}
		if n, ok := number(schema["minItems"]); ok && float64(len(list)) < n {
			return fmt.Errorf("%s has %d items, minItems %v", at, len(list), n)
		}
		if items, ok := schema["items"].(map[string]any); ok {
			for i, item := range list {
				if err := o.validate(items, item, fmt.Sprintf("%s[%d]", at, i)); err != nil {
					return err
				}
			}
		}
		return nil
	case "string":
		if _, ok := v.(string); !ok {
			return fmt.Errorf("%s is %T, want string", at, v)
		}
		return nil
	case "boolean":
		if _, ok := v.(bool); !ok {
			return fmt.Errorf("%s is %T, want boolean", at, v)
		}
		return nil
	case "integer", "number":
		n, ok := v.(json.Number)
		if !ok {
			return fmt.Errorf("%s is %T, want %s", at, v, typ)
		}
		if typ == "integer" {
			if _, err := strconv.ParseInt(n.String(), 10, 64); err != nil {
				return fmt.Errorf("%s value %s is not an integer", at, n)
			}
		}
		f, err := n.Float64()
		if err != nil {
			return fmt.Errorf("%s value %s: %w", at, n, err)
		}
		if lim, ok := number(schema["minimum"]); ok && f < lim {
			return fmt.Errorf("%s value %s is below minimum %v", at, n, lim)
		}
		if lim, ok := number(schema["maximum"]); ok && f > lim {
			return fmt.Errorf("%s value %s is above maximum %v", at, n, lim)
		}
		return nil
	default:
		return fmt.Errorf("%s schema type %q is not supported", at, typ)
	}
}

func (o *OpenAPI) matches(subs []map[string]any, v any, at string) int {
	n := 0
	for _, sub := range subs {
		if o.validate(sub, v, at) == nil {
			n++
		}
	}
	return n
}

func (o *OpenAPI) deref(node map[string]any) (map[string]any, error) {
	for range 16 {
		ref, ok := node["$ref"].(string)
		if !ok {
			return node, nil
		}
		next, err := o.lookup(ref)
		if err != nil {
			return nil, err
		}
		node = next
	}
	return nil, fmt.Errorf("$ref chain is too deep")
}

func (o *OpenAPI) lookup(ref string) (map[string]any, error) {
	rest, ok := strings.CutPrefix(ref, "#/")
	if !ok {
		return nil, fmt.Errorf("$ref %s is not local", ref)
	}
	var node any = o.doc
	for _, part := range strings.Split(rest, "/") {
		m, ok := node.(map[string]any)
		if !ok {
			return nil, fmt.Errorf("$ref %s does not resolve", ref)
		}
		part = strings.ReplaceAll(strings.ReplaceAll(part, "~1", "/"), "~0", "~")
		if node, ok = m[part]; !ok {
			return nil, fmt.Errorf("$ref %s does not resolve", ref)
		}
	}
	m, ok := node.(map[string]any)
	if !ok {
		return nil, fmt.Errorf("$ref %s is not a mapping", ref)
	}
	return m, nil
}

// stringKeys turns YAML mappings with non-string keys, such as unquoted
// status codes, into map[string]any.
func stringKeys(v any) any {
	switch t := v.(type) {
	case map[string]any:
		for k, child := range t {
			t[k] = stringKeys(child)
		}
		return t
	case map[any]any:
		out := make(map[string]any, len(t))
		for k, child := range t {
			out[fmt.Sprint(k)] = stringKeys(child)
		}
		return out
	case []any:
		for i, child := range t {
			t[i] = stringKeys(child)
		}
		return t
	default:
		return v
	}
}

func schemaList(v any) []map[string]any {
	list, _ := v.([]any)
	out := make([]map[string]any, 0, len(list))
	for _, item := range list {
		if m, ok := item.(map[string]any); ok {
			out = append(out, m)
		}
	}
	return out
}

func stringList(v any) []string {
	list, _ := v.([]any)
	out := make([]string, 0, len(list))
	for _, item := range list {
		if s, ok := item.(string); ok {
			out = append(out, s)
		}
	}
	return out
}

func number(v any) (float64, bool) {
	switch t := v.(type) {
	case int:
		return float64(t), true
	case int64:
		return float64(t), true
	case uint64:
		return float64(t), true
	case float64:
		return t, true
	}
	return 0, false
}

func inEnum(enum []any, v any) bool {
	for _, want := range enum {
		switch w := want.(type) {
		case string:
			if s, ok := v.(string); ok && s == w {
				return true
			}
		case bool:
			if b, ok := v.(bool); ok && b == w {
				return true
			}
		default:
			if n, ok := v.(json.Number); ok {
				if f, err := n.Float64(); err == nil {
					if g, ok := number(want); ok && f == g {
						return true
					}
				}
			}
		}
	}
	return false
}
