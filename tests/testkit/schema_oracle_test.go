package testkit

import "testing"

func TestFingerprintJSONLoads(t *testing.T) {
	tables, err := loadFingerprintTables()
	if err != nil {
		t.Fatal(err)
	}
	var banned *fingerprintTable
	for i := range tables {
		if tables[i].Name == "banned_tags" {
			banned = &tables[i]
		}
	}
	if banned == nil {
		t.Fatal("banned_tags missing from head fingerprint")
	}
	if banned.RLS || banned.Rows != 6 || len(banned.Columns) != 7 {
		t.Fatalf("%+v", banned)
	}
	if _, ok := banned.Checks["banned_tags_term_nonempty"]; !ok {
		t.Fatal("term check missing")
	}
}
