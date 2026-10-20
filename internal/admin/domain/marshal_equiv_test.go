package domain

import (
	"bytes"
	"encoding/json"
	"reflect"
	"testing"

	corecontract "github.com/xxww0098/podhub-go/internal/admin/core/contract"
	shipcontract "github.com/xxww0098/podhub-go/internal/admin/shipping/contract"
)

func TestMarshalAndShippingAliasesMatch(t *testing.T) {
	price := int64(3)
	values := []any{
		struct {
			Name string `json:"name"`
		}{"<b>"},
		struct {
			N *int64 `json:"n"`
		}{&price},
		struct {
			N *int64 `json:"n"`
		}{nil},
	}
	for _, v := range values {
		got, err := Marshal(v)
		want, wantErr := legacyAdminMarshal(v)
		core, coreErr := corecontract.Marshal(v)
		if err != nil || wantErr != nil || coreErr != nil || string(got) != string(want) || string(core) != string(want) || bytes.Contains(got, []byte(`\u003c`)) {
			t.Fatalf("got %s %v want %s", got, err, want)
		}
	}
	raw := []byte(`not-json`)
	if !reflect.DeepEqual(DecodeStoredPayload(raw), shipcontract.DecodeStoredPayload(raw)) {
		t.Fatal("stored payload alias")
	}
	row := NewPreset("p", "n", 4, 1, 2, FallbackPayload())
	wantRow := shipcontract.NewPreset("p", "n", 4, 1, 2, shipcontract.FallbackPayload())
	if row.RequiredVersion != 4 || row.CurrentVersion != 4 || !reflect.DeepEqual(row, wantRow) {
		t.Fatalf("%+v", row)
	}
}

func legacyAdminMarshal(v any) ([]byte, error) {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(v); err != nil {
		return nil, err
	}
	return bytes.TrimRight(buf.Bytes(), "\n"), nil
}
