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
	want := `[{"description_category_id":1,"category_name":"a","type_id":2,"type_name":"b","disabled":false,"parent_index":null},{"description_category_id":1,"category_name":"","type_id":4,"type_name":"d","disabled":true,"parent_index":0}]`
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

func TestTreeCategoryBranchesDoNotCollideAtZeroType(t *testing.T) {
	nodes := FlattenTree([]StorageNode{
		{DescriptionCategoryID: 10, Children: []StorageNode{
			{DescriptionCategoryID: 11, Children: []StorageNode{{TypeID: 7}}},
		}},
		{DescriptionCategoryID: 20, Children: []StorageNode{
			{DescriptionCategoryID: 21, Children: []StorageNode{{TypeID: 8}}},
		}},
	})
	for index, parent := range map[int]int64{1: 0, 2: 1, 4: 3, 5: 4} {
		if nodes[index].ParentIndex == nil || *nodes[index].ParentIndex != parent {
			t.Fatalf("node %d points to wrong parent: %+v", index, nodes[index])
		}
	}
	if nodes[2].DescriptionCategoryID != 11 || nodes[5].DescriptionCategoryID != 21 {
		t.Fatalf("type leaves lost their category: %+v", nodes)
	}
}
