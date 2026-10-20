package domain

import "testing"

func TestWBQueryAndIssues(t *testing.T) {
	id, lang, _, ok := AcceptWBQuery("15", "language=ru", "ru", false)
	if !ok || id != 15 || lang != "ru" {
		t.Fatalf("%d %s", id, lang)
	}
	for _, subject := range []string{"", "0", "-1", "１", "12345678901234567890", "12a"} {
		if _, _, _, ok := AcceptWBQuery(subject, "language=ru", "ru", false); ok {
			t.Fatalf("subject %q", subject)
		}
	}
	if _, _, _, ok := AcceptWBQuery("1", "", "ru", false); ok {
		t.Fatal("missing query")
	}
	if _, _, _, ok := AcceptWBQuery("1", "language=ru&extra=1paddingpaddingpadding", "ru", false); ok {
		t.Fatal("long query")
	}
	if _, _, _, ok := AcceptWBQuery("1", "language=de", "de", false); ok {
		t.Fatal("language")
	}
	if _, _, _, ok := AcceptWBQuery("1", "language=ru", "ru", true); ok {
		t.Fatal("unknown field")
	}
	empty := WBIssues(false, false, false, false)
	if len(empty) != 1 || empty[0].Code != "catalog_unavailable" {
		t.Fatal(empty)
	}
	stale := WBIssues(true, false, true, true)
	if len(stale) != 2 || stale[0].Code != "catalog_stale" || stale[1].Code != "defaults_stale" {
		t.Fatal(stale)
	}
	noDefaults := WBIssues(true, true, false, false)
	if len(noDefaults) != 1 || noDefaults[0].Code != "defaults_stale" || noDefaults[0].Field != "defaults" {
		t.Fatal(noDefaults)
	}
	mismatch := WBIssues(true, true, true, false)
	if len(mismatch) != 1 || mismatch[0].Code != "defaults_stale" {
		t.Fatal(mismatch)
	}
	if len(WBIssues(true, true, true, true)) != 0 {
		t.Fatal("clean")
	}
	now := int64(1_000_000)
	if CatalogUsable(now+1, now) || !CatalogUsable(now, now) || CatalogUsable(now-WBMaxAgeMs-1, now) {
		t.Fatal("age")
	}
}

func TestFreshnessBands(t *testing.T) {
	now := int64(10_000_000_000)
	if FreshnessBand(nil, now) != "missing" {
		t.Fatal("missing")
	}
	fresh := now - CatalogStaleAgeMs
	stale := now - CatalogStaleAgeMs - 1
	expired := now - CatalogMaxAgeMs - 1
	if FreshnessBand(&fresh, now) != "fresh" || FreshnessBand(&stale, now) != "stale" || FreshnessBand(&expired, now) != "expired" {
		t.Fatal("bands")
	}
}
