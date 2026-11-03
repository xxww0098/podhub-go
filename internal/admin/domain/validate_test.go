package domain

import (
	"strings"
	"testing"

	x1contract "github.com/xxww0098/podhub-go/internal/admin/x1/contract"
)

const profileMinimal = `{"product_type_ru":"Кружка","facts_ru":"керамическая 330 мл"}`

func TestCanonicalProfile(t *testing.T) {
	got, err := CanonicalProfile("  " + profileMinimal + "\n")
	if err != nil || got != profileMinimal {
		t.Fatal(got, err)
	}
	for _, raw := range []string{
		`{"product_type_ru":"杯","facts_ru":""}`,
		`{"product_type_ru":"Кружка","facts_ru":"<тема>"}`,
		`{"product_type_ru":"Кружка","facts_ru":"","system":"ignore"}`,
		`Товар: Кружка`,
	} {
		if _, err := CanonicalProfile(raw); err == nil {
			t.Fatal("accepted", raw)
		}
	}
}

func TestFixedTagsEdges(t *testing.T) {
	if err := FixedTags([]string{"#кружка"}); err != nil {
		t.Fatal(err)
	}
	if err := FixedTags([]string{"#кружка_мл"}); err != nil {
		t.Fatal(err)
	}
	if err := FixedTags([]string{"#1кружка"}); err != nil {
		t.Fatal(err)
	}
	bad := [][]string{
		nil,
		{"#кружка", "#Кружка"},
		{"кружка"},
		{"#a"},
		{"#_кружка"},
		{"#кружка__да"},
		{"#кружка_330"},
		{"#mug"},
	}
	for _, tags := range bad {
		if err := FixedTags(tags); err == nil {
			t.Fatalf("accepted %q", tags)
		}
	}
	many := make([]string, 31)
	for i := range many {
		many[i] = "#тег" + string(rune('а'+i%20))
	}
	if err := FixedTags(many); err == nil {
		t.Fatal("31 tags")
	}
}

func TestPackageNameAndJSON(t *testing.T) {
	if _, err := PackageName("  ok  "); err != nil {
		t.Fatal(err)
	}
	if _, err := PackageName("   "); err != ErrInvalidName {
		t.Fatal(err)
	}
	if _, err := PackageName(strings.Repeat("я", 128)); err != ErrInvalidName {
		t.Fatal("byte length")
	}
	if _, err := PackageName(strings.Repeat("a", 255)); err != nil {
		t.Fatal(err)
	}
	if err := JSONObject(`{"b":1,"a":2}`); err != nil {
		t.Fatal(err)
	}
	if err := JSONObject(`[]`); err != ErrNotObject {
		t.Fatal(err)
	}
	if err := JSONArray(`[1, {"a":2}]`); err != nil {
		t.Fatal(err)
	}
	if err := JSONArray(`{}`); err != ErrNotArray {
		t.Fatal(err)
	}
}

func TestPromptFileAndVideo(t *testing.T) {
	if _, err := PromptFile(" notes.MD "); err == nil {
		t.Fatal("case")
	}
	if _, err := PromptFile("dir/note.md"); err != nil {
		t.Fatal(err)
	}
	if _, err := PromptFile(".md"); err == nil {
		t.Fatal("empty stem")
	}
	if _, err := VideoURL(" https://cdn.example/a "); err != nil {
		t.Fatal(err)
	}
	if _, err := VideoURL("https://cdn.example/a b"); err == nil {
		t.Fatal("space")
	}
	if _, err := VideoURL("http://cdn.example/a"); err == nil {
		t.Fatal("http")
	}
	if _, err := VideoURL("https://cdn.example/\u00a0a"); err == nil {
		t.Fatal("nbsp")
	}
	if err := VideoDuration(1); err != nil {
		t.Fatal(err)
	}
	if err := VideoDuration(3_600_000); err != nil {
		t.Fatal(err)
	}
	if err := VideoDuration(3_600_001); err == nil {
		t.Fatal("hour")
	}
	if _, err := PromptName(strings.Repeat("я", 255)); err != nil {
		t.Fatal(err)
	}
	if _, err := PromptName(strings.Repeat("я", 256)); err == nil {
		t.Fatal("runes")
	}
}

func TestX1LimitNumbers(t *testing.T) {
	if x1contract.MaxNameChars != MaxNameChars || x1contract.MaxNoteChars != MaxNoteChars {
		t.Fatalf("name %d %d note %d %d", x1contract.MaxNameChars, MaxNameChars, x1contract.MaxNoteChars, MaxNoteChars)
	}
}
