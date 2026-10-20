package domain

import (
	"bytes"
	"encoding/json"
	"strings"
	"testing"

	corecontract "github.com/xxww0098/podhub-go/internal/admin/core/contract"
)

func TestJSONHelpersMatchLegacy(t *testing.T) {
	bodies := [][]byte{nil, []byte(""), []byte("  "), []byte(`{"a":1}`), []byte(`{"a":1} trailing`), []byte(`[]`), []byte(`null`), []byte(`{"n":1.5}`)}
	for _, body := range bodies {
		got, gotErr := strictObject(body)
		want, wantErr := legacyStrictObject(body)
		if (gotErr == nil) != (wantErr == nil) || (gotErr != nil && gotErr.Error() != wantErr.Error()) {
			t.Fatalf("%q err got %v want %v", body, gotErr, wantErr)
		}
		if len(got) != len(want) {
			t.Fatalf("%q map %v %v", body, got, want)
		}
		for k, v := range want {
			if string(got[k]) != string(v) {
				t.Fatalf("%q key %s", body, k)
			}
		}
		raw := map[string]json.RawMessage{"a": []byte(`1`), "b": []byte(`2`)}
		if hasOnly(raw, []string{"a", "b"}) != legacyHasOnly(raw, []string{"a", "b"}) || hasOnly(raw, []string{"a"}) != legacyHasOnly(raw, []string{"a"}) {
			t.Fatal("hasOnly")
		}
		if requireKeys(raw, []string{"a"}) != legacyRequireKeys(raw, []string{"a"}) || requireKeys(raw, []string{"c"}) != legacyRequireKeys(raw, []string{"c"}) {
			t.Fatal("requireKeys")
		}
		var n int
		if unmarshal(raw["a"], &n) != legacyUnmarshal(raw["a"], &n) || n != 1 {
			t.Fatal("unmarshal")
		}
	}
	for _, v := range []any{map[string]string{"<": "&"}, struct {
		A string `json:"a"`
	}{"x"}, nil} {
		if JSONText(v) != legacyJSONText(v) || JSONText(v) != corecontract.JSONText(v) {
			t.Fatalf("json text %v %q", v, JSONText(v))
		}
	}
	// Independent of the legacy copies above. A shared mistake (non-strict
	// object, HTML escaped, trailing newline, or a clobbered dest) fails here.
	if _, err := strictObject([]byte(`{"a":1} trailing`)); err == nil {
		t.Fatal("trailing data accepted")
	}
	if _, err := strictObject([]byte(`null`)); err == nil {
		t.Fatal("null accepted")
	}
	if _, err := strictObject(nil); err == nil {
		t.Fatal("empty accepted")
	}
	got, err := strictObject([]byte(`{"a":1,"b":2}`))
	if err != nil || len(got) != 2 || string(got["a"]) != "1" || string(got["b"]) != "2" {
		t.Fatalf("object %v %v", got, err)
	}
	raw := map[string]json.RawMessage{"a": []byte(`1`), "b": []byte(`2`)}
	if !hasOnly(raw, []string{"a", "b"}) || hasOnly(raw, []string{"a"}) {
		t.Fatal("hasOnly absolute")
	}
	if !requireKeys(raw, []string{"a"}) || requireKeys(raw, []string{"c"}) {
		t.Fatal("requireKeys absolute")
	}
	var first, second int
	if !unmarshal(raw["a"], &first) || first != 1 {
		t.Fatalf("first %d", first)
	}
	if !unmarshal([]byte(`2`), &second) || second != 2 || first != 1 {
		t.Fatalf("clobber first %d second %d", first, second)
	}
	if unmarshal([]byte(`1 trailing`), &first) || first != 1 {
		t.Fatal("trailing unmarshal")
	}
	text := JSONText(map[string]string{"<": "&\n"})
	if text != `{"<":"&\n"}` || strings.Contains(text, `\u003c`) || strings.HasSuffix(text, "\n") {
		t.Fatalf("text %q", text)
	}
}

func legacyStrictObject(body []byte) (map[string]json.RawMessage, error) {
	if len(bytes.TrimSpace(body)) == 0 {
		return nil, errLegacyJSON
	}
	dec := json.NewDecoder(bytes.NewReader(body))
	dec.UseNumber()
	var raw map[string]json.RawMessage
	if err := dec.Decode(&raw); err != nil || raw == nil || dec.More() {
		return nil, errLegacyJSON
	}
	return raw, nil
}

var errLegacyJSON = jsonErr("json")

type jsonErr string

func (e jsonErr) Error() string { return string(e) }

func legacyHasOnly(raw map[string]json.RawMessage, allow []string) bool {
	ok := map[string]bool{}
	for _, k := range allow {
		ok[k] = true
	}
	for k := range raw {
		if !ok[k] {
			return false
		}
	}
	return true
}

func legacyRequireKeys(raw map[string]json.RawMessage, keys []string) bool {
	for _, k := range keys {
		if _, ok := raw[k]; !ok {
			return false
		}
	}
	return true
}

func legacyUnmarshal(raw json.RawMessage, dest any) bool {
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.UseNumber()
	if err := dec.Decode(dest); err != nil {
		return false
	}
	return !dec.More()
}

func legacyJSONText(v any) string {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(v); err != nil {
		return ""
	}
	return strings.TrimRight(buf.String(), "\n")
}
