package domain

import (
	"bytes"
	"testing"

	"github.com/xxww0098/podhub-go/internal/ops/contract"
)

func TestSnapshotJSONOmitsCompanyFields(t *testing.T) {
	raw := SnapshotJSON(contract.RosterMeta{StoreLimit: 1}, []contract.StoreHead{{
		UUID: "00000000-0000-4000-8000-000000000001", Name: "shop", CreateOrder: 1,
	}}, nil, nil, nil)
	for _, key := range []string{"company_legal_name", "company_short_name", "name_source", "未分类"} {
		if bytes.Contains(raw, []byte(key)) {
			t.Fatalf("snapshot contains %s: %s", key, raw)
		}
	}
}
