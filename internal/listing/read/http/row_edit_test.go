package readhttp

import (
	"encoding/json"
	"os"
	"testing"
)

// The core writes the states an edit invalidated into the reply. Decoding only
// the row dropped them, so a cleared row kept content_state=ready and
// media_state=ready — the row still looked recognized and its media still
// looked uploaded. This reads the recorded reply for clearGeneratedContent.
func TestClearGeneratedKeepsInvalidation(t *testing.T) {
	raw, err := os.ReadFile("../../../../fixtures/listing/core-ops/edit_row/clear-generated-content-keeps-identity.output.json")
	if err != nil {
		raw, err = os.ReadFile("fixtures/listing/core-ops/edit_row/clear-generated-content-keeps-identity.output.json")
	}
	if err != nil {
		t.Fatal(err)
	}
	var edited rowEdit
	if err := json.Unmarshal(raw, &edited); err != nil {
		t.Fatal(err)
	}
	if len(edited.Row) == 0 {
		t.Fatal("no row")
	}
	if got := factState(edited.Fact); got != "stale" {
		t.Fatalf("fact %q -> %q", edited.Fact, got)
	}
	content, media, submission := textOrEmpty(edited.Invalidation.Content), textOrEmpty(edited.Invalidation.Media), textOrEmpty(edited.Invalidation.Submission)
	if content != "draft" || media != "pending" || submission != "" {
		t.Fatalf("states %q %q %q", content, media, submission)
	}
}

// A reply that parses but carries no row leaves nothing to write, so it is as
// unreadable as a body that does not parse.
func TestDecodeRowEditRefusesAnEmptyRow(t *testing.T) {
	if _, err := decodeRowEdit([]byte(`{"fact":"Stale"}`)); err == nil {
		t.Fatal("empty row accepted")
	}
	if _, err := decodeRowEdit([]byte("not json")); err == nil {
		t.Fatal("garbage accepted")
	}
	edited, err := decodeRowEdit([]byte(`{"row":{"a":1},"fact":"Passed"}`))
	if err != nil {
		t.Fatal(err)
	}
	if string(edited.Row) != `{"a":1}` || factState(edited.Fact) != "passed" {
		t.Fatalf("%s %q", edited.Row, edited.Fact)
	}
}

// textOrEmpty blanks a state the column CHECK would reject. A null means the op
// left the column alone, and the UPDATE keeps the stored value when its argument
// is empty, so an empty result is the right answer for both cases.
func TestTextOrEmptyDropsUnknownStates(t *testing.T) {
	known := "ready"
	if got := textOrEmpty(&known); got != "ready" {
		t.Fatalf("known %q", got)
	}
	unknown := "Rendered"
	if got := textOrEmpty(&unknown); got != "" {
		t.Fatalf("unknown %q", got)
	}
	if got := textOrEmpty(nil); got != "" {
		t.Fatalf("nil %q", got)
	}
}
