package domain

import "testing"

func TestSSEFrameOrderMatchesAxum(t *testing.T) {
	data, err := RowRemoveData(7, "card", "row", 4)
	if err != nil {
		t.Fatal(err)
	}
	frame := FormatSSE("4", "row.remove", data)
	want := "id: 4\nevent: row.remove\ndata: {\"workspaceId\":\"7\",\"cardId\":\"card\",\"seq\":\"4\",\"rowId\":\"row\",\"row\":null}\n\n"
	if frame != want {
		t.Fatalf("%q", frame)
	}
	inv, err := CardInvalidateData(7, "card", "template_changed", "abc", 5)
	if err != nil {
		t.Fatal(err)
	}
	frame = FormatSSE("5", "card.invalidate", inv)
	want = "id: 5\nevent: card.invalidate\ndata: {\"workspaceId\":\"7\",\"cardId\":\"card\",\"seq\":\"5\",\"reason\":\"template_changed\",\"psdTemplateSha256\":\"abc\"}\n\n"
	if frame != want {
		t.Fatalf("%q", frame)
	}
	reset, err := ResetData(7, "card", "sequence_gap")
	if err != nil {
		t.Fatal(err)
	}
	frame = FormatSSE("", "reset", reset)
	if frame != "event: reset\ndata: {\"workspaceId\":\"7\",\"cardId\":\"card\",\"reason\":\"sequence_gap\"}\n\n" {
		t.Fatalf("%q", frame)
	}
}
