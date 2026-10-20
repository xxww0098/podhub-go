package testkit

import "testing"

func TestHeadFingerprintFixture(t *testing.T) {
	fp, err := loadHeadFingerprint()
	if err != nil {
		t.Fatal(err)
	}
	if len(fp.Fingerprint.Tables) != 132 {
		t.Fatalf("tables %d", len(fp.Fingerprint.Tables))
	}
	counts := map[string]int64{}
	for _, table := range fp.Fingerprint.Tables {
		if table.RowCount != 0 {
			counts[table.Name] = table.RowCount
		}
	}
	want := map[string]int64{
		"agent_rebate_policy":       1,
		"ai_price_schedules":        1,
		"banned_tags":               6,
		"execution_fairness_cursor": 4,
		"execution_quota":           4,
		"plans":                     5,
		"platform_initialization":   1,
		"sc_sources":                1,
		"seaql_migration_steps":     79,
	}
	if len(counts) != len(want) {
		t.Fatalf("nonzero tables %+v", counts)
	}
	for name, n := range want {
		if counts[name] != n {
			t.Fatalf("%s rows %d want %d", name, counts[name], n)
		}
	}
}
