package domain

import (
	"strings"
	"testing"

	x1contract "github.com/xxww0098/podhub-go/internal/admin/x1/contract"
)

const briefMinimal = "Товар: керамическая кружка 330 мл с принтом; это НЕ термокружка и НЕ стакан.\n" +
	"Тема: только принт. Неясно → «Абстрактный принт».\n" +
	"Заголовок: `Кружка керамическая 330 мл с принтом \"<тема>\"`\n" +
	"Не пиши: чашка, стакан, термокружка.\n" +
	"Описание: Керамическая кружка 330 мл с принтом: <видимый принт>. Основные цвета: <цвет1> и <цвет2>.\n" +
	"Не выдумывай: вес, высоту, упаковку.\n"

func TestCanonicalBriefFixture(t *testing.T) {
	got, err := CanonicalBrief(briefMinimal)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(got, "\n\n") || strings.HasPrefix(got, "\uFEFF") {
		t.Fatalf("%q", got)
	}
	if len(strings.Split(got, "\n")) != 6 {
		t.Fatal(got)
	}
}

func TestCanonicalBriefEdges(t *testing.T) {
	ok, err := CanonicalBrief("\uFEFF" + strings.ReplaceAll(briefMinimal, "\n", "\r\n") + "\n\n")
	if err != nil || !strings.Contains(ok, "Товар:") {
		t.Fatal(err, ok)
	}
	cases := []struct {
		name string
		in   string
		want string
	}{
		{"five lines", "Товар: a\nТема: b\nЗаголовок: `\"<тема>\"`\nНе пиши: c\nОписание: d", "现在是 5 行"},
		{"empty label", "Товар: \nТема: b\nЗаголовок: `\"<тема>\"`\nНе пиши: c\nОписание: d\nНе выдумывай: e", "后面没有内容"},
		{"wrong order", "Тема: b\nТовар: a\nЗаголовок: `\"<тема>\"`\nНе пиши: c\nОписание: d\nНе выдумывай: e", "第 1 行应以"},
		{"no formula", "Товар: a\nТема: b\nЗаголовок: title\nНе пиши: c\nОписание: d\nНе выдумывай: e", "<тема>"},
		{"han", "Товар: 杯\nТема: b\nЗаголовок: `\"<тема>\"`\nНе пиши: c\nОписание: d\nНе выдумывай: e", "含汉字"},
	}
	for _, tc := range cases {
		_, err := CanonicalBrief(tc.in)
		if err == nil || !strings.Contains(err.Error(), tc.want) {
			t.Fatalf("%s: %v", tc.name, err)
		}
	}
	big := strings.Repeat("x", maxBriefBytes+1)
	_, err = CanonicalBrief(big)
	if err == nil || !strings.Contains(err.Error(), "4097") {
		t.Fatal(err)
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
