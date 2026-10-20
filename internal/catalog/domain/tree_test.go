package domain

import (
	"bytes"
	"compress/gzip"
	"testing"
	"time"

	"github.com/xxww0098/podhub-go/internal/platform/httpx/jsonwire"
)

func TestDecodeTreeFlattensChildren(t *testing.T) {
	var buf bytes.Buffer
	zw := gzip.NewWriter(&buf)
	if _, err := zw.Write([]byte(`[{"description_category_id":1,"category_name":"a","type_id":2,"type_name":"b","disabled":false,"children":[{"description_category_id":0,"category_name":"","type_id":4,"type_name":"d","disabled":true,"children":[]}]}]`)); err != nil {
		t.Fatal(err)
	}
	if err := zw.Close(); err != nil {
		t.Fatal(err)
	}
	nodes, err := DecodeTree(buf.Bytes())
	if err != nil {
		t.Fatal(err)
	}
	raw, err := jsonwire.Marshal(nodes)
	if err != nil {
		t.Fatal(err)
	}
	want := `[{"description_category_id":1,"category_name":"a","type_id":2,"type_name":"b","disabled":false,"parent_id":null},{"description_category_id":0,"category_name":"","type_id":4,"type_name":"d","disabled":true,"parent_id":2}]`
	if string(raw) != want {
		t.Fatalf("%s", raw)
	}
	if Fresh(time.UnixMilli(1_000_000), 1_000_000-TreeTTL.Milliseconds()-1) {
		t.Fatal("expired")
	}
	if !Fresh(time.UnixMilli(1_000_000), 1_000_000) {
		t.Fatal("fresh")
	}
	if _, ok := LanguageKey("zh_hans"); !ok {
		t.Fatal("language")
	}
	if _, ok := LanguageKey("zh"); ok {
		t.Fatal("zh")
	}
}
