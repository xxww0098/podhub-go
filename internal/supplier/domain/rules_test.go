package domain

import (
	"testing"
)

func TestFilterAndCursor(t *testing.T) {
	if view, err := FilterView("  "); err != nil || view != "pending" {
		t.Fatal(view, err)
	}
	id := "11111111-1111-4111-8111-111111111111"
	c, err := DecodeCursor("0|2026-01-02T12:00:00Z|" + id)
	if err != nil || c.NoDeadline || c.Deadline != "2026-01-02T12:00:00Z" || c.ID != id {
		t.Fatal(c, err)
	}
	if _, err := DecodeCursor("0|not-a-date|" + id); err == nil {
		t.Fatal("invalid cursor deadline")
	}
	if _, err := DecodeCursor("1|x|" + id); err == nil {
		t.Fatal("deadline on flag 1")
	}
	if _, err := DecodeCursor("2||" + id); err == nil {
		t.Fatal("flag")
	}
	deadline := "2026-01-02T12:00:00Z"
	if EncodeCursor(&deadline, id) != "0|2026-01-02T12:00:00Z|"+id {
		t.Fatal(EncodeCursor(&deadline, id))
	}
	if EncodeCursor(nil, id) != "1||"+id {
		t.Fatal("empty deadline")
	}
}

func TestOrderViewAndSearchValidation(t *testing.T) {
	for _, view := range []string{"pending", "producing", "urgent", "shipped"} {
		if got, err := FilterView(" " + view + " "); err != nil || got != view {
			t.Fatalf("view %q = %q, %v", view, got, err)
		}
	}
	if _, err := FilterView("rejected"); err == nil {
		t.Fatal("invalid view accepted")
	}
	if _, err := FilterSearch(stringsRepeat('a', 201)); err == nil {
		t.Fatal("overlong search accepted")
	}
}

func TestRejectShipText(t *testing.T) {
	if _, err := RejectReason("  "); err == nil {
		t.Fatal("blank")
	}
	if _, err := RejectReason(string(make([]rune, 501))); err == nil {
		t.Fatal("long")
	}
	if reason, err := RejectReason(" 没货 "); err != nil || reason != "没货" {
		t.Fatal(reason, err)
	}
	if _, _, err := ShipFields(string(make([]rune, 129)), ""); err == nil {
		t.Fatal("tracking")
	}
	if _, _, err := ShipFields("", string(make([]rune, 501))); err == nil {
		t.Fatal("note")
	}
}

func TestCatalogImageAndListability(t *testing.T) {
	if _, err := ParseSourceID(""); err == nil {
		t.Fatal("empty source")
	}
	id, ext, err := ParseImageFile("AAAA" + stringsRepeat('a', 60) + ".JPG")
	if err != nil || ext != "jpg" || id != "aaaa"+stringsRepeat('a', 60) {
		t.Fatal(id, ext, err)
	}
	if _, _, err := ParseImageFile("abcd.png"); err == nil {
		t.Fatal("short")
	}
	if edge, err := ParseEdge("", false); err != nil || edge != 640 {
		t.Fatal(edge, err)
	}
	if _, err := ParseEdge("100", true); err == nil {
		t.Fatal("edge")
	}
	facts := ListabilityFacts{SourceListed: true, SKUPublished: true, PromptValid: true, ConfigState: "valid", Freshness: "fresh", CurrentDigest: strPtr("d"), ValidatedDigest: strPtr("d")}
	if Denial(facts) != "" {
		t.Fatal(Denial(facts))
	}
	facts.Freshness = "expired"
	if Denial(facts) != "catalog_expired" {
		t.Fatal(Denial(facts))
	}
	facts.Freshness = "stale"
	facts.CurrentDigest = nil
	if Denial(facts) != "catalog_missing" {
		t.Fatal(Denial(facts))
	}
	if !WantsJSON("text/html, application/json;q=0.1") {
		t.Fatal("json")
	}
	if WantsJSON("application/json;q=0") || WantsJSON("*/*") || WantsJSON("") {
		t.Fatal("bytes")
	}
	a, r, s := ActionsView(StateDispatched)
	if !a || !r || s {
		t.Fatal(a, r, s)
	}
	a, r, s = ActionsView(StateAccepted)
	if a || r || !s {
		t.Fatal(a, r, s)
	}
}

func strPtr(s string) *string { return &s }

func stringsRepeat(c byte, n int) string {
	b := make([]byte, n)
	for i := range b {
		b[i] = c
	}
	return string(b)
}
