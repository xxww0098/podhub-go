package supplierrepo

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/xxww0098/podhub-go/internal/supplier/contract"
)

func TestListThumbnailOnlyUsesFirstPreviewableProductionAsset(t *testing.T) {
	const dispatch = "11111111-1111-4111-8111-111111111111"
	const first = "22222222-2222-4222-8222-222222222222"
	raw := []byte(`[{"name":"帆布袋","offer_id":"x","quantity":2,"assets":[
	 {"asset_id":"11111111-1111-4111-8111-111111111112","object_key":"private/a.svg","mime":"image/svg+xml"},
	 {"asset_id":"not-a-uuid","object_key":"private/b.png","mime":"image/png"},
	 {"asset_id":"11111111-1111-4111-8111-111111111113","mime":"image/webp"},
	 {"asset_id":"11111111-1111-4111-8111-111111111114","object_key":"private/c.png","mime":"image/png","bytes":"bad"},
	 {"asset_id":"22222222-2222-4222-8222-222222222222","object_key":"private/production.png","mime":"image/png","bytes":10},
	 {"asset_id":"33333333-3333-4333-8333-333333333333","object_key":"private/other.jpg","mime":"image/jpeg","bytes":10}
	]}]`)
	lines, thumbnail := parseListLines(dispatch, raw)
	want := "/api/supplier/dispatches/" + dispatch + "/assets/" + first
	if thumbnail == nil || *thumbnail != want || len(lines) != 1 || lines[0].Quantity != 2 {
		t.Fatalf("lines=%+v thumbnail=%v", lines, thumbnail)
	}
	encoded, err := json.Marshal(contract.DispatchRow{Lines: lines, ThumbnailURL: thumbnail})
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(encoded), "object_key") || strings.Contains(string(encoded), "private/") {
		t.Fatalf("private asset data leaked: %s", encoded)
	}
}

func TestListThumbnailAbsentWithoutPreviewableAsset(t *testing.T) {
	for _, raw := range []string{
		`null`, `[]`, `[{"assets":[{"asset_id":"22222222-2222-4222-8222-222222222222","object_key":"private/a.psd","mime":"application/octet-stream"}]}]`,
	} {
		_, thumbnail := parseListLines("11111111-1111-4111-8111-111111111111", []byte(raw))
		if thumbnail != nil {
			t.Fatalf("unexpected thumbnail for %s: %s", raw, *thumbnail)
		}
	}
}
