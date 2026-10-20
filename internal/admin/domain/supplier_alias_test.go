package domain

import (
	"strings"
	"testing"

	corecontract "github.com/xxww0098/podhub-go/internal/admin/core/contract"
	supcontract "github.com/xxww0098/podhub-go/internal/admin/supplier/contract"
)

func TestSupplierAliasesMatchContract(t *testing.T) {
	cases := []struct {
		raw string
		max int
		ok  bool
	}{
		{"  单号-1  ", 64, true},
		{"", 64, false},
		{"一二三", 2, false},
		{"ab", 2, true},
	}
	for _, tc := range cases {
		got, err := Bounded(tc.raw, tc.max, "打款单号须为 1–64 个字符")
		want, wantErr := legacyBounded(tc.raw, tc.max, "打款单号须为 1–64 个字符")
		if (err == nil) != tc.ok || (err == nil) != (wantErr == nil) || got != want {
			t.Fatalf("%q got %q %v want %q %v", tc.raw, got, err, want, wantErr)
		}
		if err != nil && err.Error() != wantErr.Error() {
			t.Fatalf("message %v %v", err, wantErr)
		}
	}
	opts := []PropOption{{Value: "dropship", Label: "一件代发"}}
	if string(OptionsJSON(opts)) != string(supcontract.OptionsJSON(opts)) || string(OptionsJSON(nil)) != `[]` {
		t.Fatalf("%s", OptionsJSON(opts))
	}
	rows := []Member{{MemberID: "1", Source: SourceRef{SourceID: "s"}}, {MemberID: "2", Source: SourceRef{SourceID: "s"}}}
	gotGroups := GroupAccounts(rows)
	wantGroups := supcontract.GroupAccounts(rows)
	if len(gotGroups) != 1 || len(gotGroups[0].Members) != 2 || gotGroups[0].Source.SourceID != wantGroups[0].Source.SourceID {
		t.Fatalf("%+v", gotGroups)
	}
	id, err := NewPublicID()
	if err != nil || !coreUUID(id) {
		t.Fatal(id, err)
	}
}

func legacyBounded(raw string, max int, message string) (string, error) {
	value := strings.TrimSpace(raw)
	n := 0
	for range value {
		n++
	}
	if n < 1 || n > max {
		return "", failMsg(message)
	}
	return value, nil
}

func coreUUID(id string) bool {
	_, ok := corecontract.CanonicalUUID(id)
	return ok && len(id) == 36 && id[14] == '4'
}
