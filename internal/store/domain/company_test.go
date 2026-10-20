package domain

import (
	"bytes"
	"encoding/json"
	"strings"
	"testing"
)

const sellerInfoFixture = `{
  "company": {
    "name": "LUAN4",
    "legal_name": "Sanming Lu an Fire Equipment Co., Ltd.",
    "ownership_form": "private",
    "inn": "tax-inn-must-not-leak",
    "ogrn": "tax-ogrn-must-not-leak",
    "tax_system": "OSNO",
    "currency": "CNY",
    "country": "CN",
    "tax_system": "tax-system-must-not-leak",
    "ownership_form": "ownership-form-must-not-leak"
  },
  "subscription": {"is_premium": false, "type": "FREE"},
  "ratings": [{"name": "rating", "value": 1}]
}`

func TestParseSellerInfoKeepsNamesOnly(t *testing.T) {
	got, ok := ParseSellerInfo([]byte(sellerInfoFixture))
	if !ok || got.ShortName != "LUAN4" || got.LegalName != "Sanming Lu an Fire Equipment Co., Ltd." || got.Currency != "CNY" || got.Country != "CN" || got.SubType != "FREE" || got.Premium == nil || *got.Premium {
		t.Fatalf("%+v ok %v", got, ok)
	}
	raw, err := json.Marshal(got)
	if err != nil {
		t.Fatal(err)
	}
	for _, leak := range []string{"tax-inn-must-not-leak", "tax-ogrn-must-not-leak", "tax-system-must-not-leak", "ownership-form-must-not-leak", "inn", "ogrn", "tax_system", "ownership_form", "ratings"} {
		if bytes.Contains(raw, []byte(leak)) {
			t.Fatalf("parsed value contains %s: %s", leak, raw)
		}
	}
}

func TestParseSellerInfoToleratesMissingAndOddTypes(t *testing.T) {
	cases := []struct {
		name         string
		body         string
		ok           bool
		short, legal string
	}{
		{name: "no company", body: `{"subscription":{"is_premium":false,"type":"FREE"},"ratings":null}`, ok: true},
		{name: "null company", body: `{"company":null}`, ok: true},
		{name: "company not object", body: `{"company":"LUAN4"}`, ok: true},
		{name: "name number", body: `{"company":{"name":1,"legal_name":"Full"}}`, ok: true, legal: "Full"},
		{name: "legal null", body: `{"company":{"name":" LUAN4 "}}`, ok: true, short: "LUAN4"},
		{name: "ratings missing", body: `{"company":{"name":"A","legal_name":"B"}}`, ok: true, short: "A", legal: "B"},
		{name: "invalid", body: `{`, ok: false},
		{name: "array", body: `[]`, ok: false},
		{name: "null", body: `null`, ok: false},
		{name: "empty", body: ``, ok: false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, ok := ParseSellerInfo([]byte(tc.body))
			if ok != tc.ok || got.ShortName != tc.short || got.LegalName != tc.legal {
				t.Fatalf("got %+v ok %v", got, ok)
			}
		})
	}
}

func TestFillName(t *testing.T) {
	cases := []struct {
		name, current, source, short, want string
		filled                             bool
	}{
		{name: "auto replaces", current: "old", source: SourceAuto, short: "LUAN4", want: "LUAN4", filled: true},
		{name: "manual blank stays", current: "  ", source: SourceManual, short: "LUAN4", want: "  ", filled: false},
		{name: "manual stays", current: "handmade", source: SourceManual, short: "LUAN4", want: "handmade", filled: false},
		{name: "blank short", current: "old", source: SourceAuto, short: "  ", want: "old", filled: false},
		{name: "missing short", current: "old", source: SourceAuto, short: "", want: "old", filled: false},
		{name: "overlong short", current: "old", source: SourceAuto, short: strings.Repeat("名", 256), want: "old", filled: false},
		{name: "blank source fills", current: "", source: "", short: "LUAN4", want: "LUAN4", filled: true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, filled := FillName(tc.current, tc.source, tc.short)
			if got != tc.want || filled != tc.filled {
				t.Fatalf("got %q filled %v", got, filled)
			}
		})
	}
}

func TestGroupByLegalName(t *testing.T) {
	rows := []Store{
		{UUID: "00000000-0000-4000-8000-000000000003", Name: "c", LegalName: "", CreateOrder: 3},
		{UUID: "00000000-0000-4000-8000-000000000002", Name: "b", LegalName: "Sanming Lu an Fire Equipment Co., Ltd.", CreateOrder: 2},
		{UUID: "00000000-0000-4000-8000-000000000001", Name: "a", LegalName: "  Sanming Lu an Fire Equipment Co., Ltd.  ", CreateOrder: 1},
		{UUID: "00000000-0000-4000-8000-000000000004", Name: "d", LegalName: "Other Co", CreateOrder: 4},
		{UUID: "00000000-0000-4000-8000-000000000005", Name: "e", LegalName: "   ", CreateOrder: 1},
	}
	got := GroupByLegalName(rows)
	if len(got) != 3 {
		t.Fatalf("groups %d", len(got))
	}
	if got[0].Name != "Other Co" || len(got[0].Stores) != 1 {
		t.Fatalf("first %+v", got[0])
	}
	if got[1].Name != "Sanming Lu an Fire Equipment Co., Ltd." || len(got[1].Stores) != 2 {
		t.Fatalf("second %+v", got[1])
	}
	if got[1].Stores[0].UUID != "00000000-0000-4000-8000-000000000001" || got[1].Stores[1].CreateOrder != 2 {
		t.Fatalf("order %+v", got[1].Stores)
	}
	if got[2].Name != Unclassified || len(got[2].Stores) != 2 || got[2].Stores[0].CreateOrder != 1 {
		t.Fatalf("unclassified %+v", got[2])
	}
}

func TestValidName(t *testing.T) {
	if _, err := ValidName("  "); !NameEmpty(err) {
		t.Fatal(err)
	}
	if _, err := ValidName(strings.Repeat("名", 256)); !NameTooLong(err) {
		t.Fatal(err)
	}
	got, err := ValidName("  shop  ")
	if err != nil || got != "shop" {
		t.Fatalf("%q %v", got, err)
	}
}
