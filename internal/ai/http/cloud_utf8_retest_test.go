package aihttp

import (
	"strings"
	"testing"
	"unicode/utf8"
)

func TestCloudRetestLogWidthPreservesUTF8(t *testing.T) {
	for _, tc := range []struct {
		name, input string
		width       int
		want        string
	}{
		{"empty", "", 128, ""},
		{"ascii_short", "abc", 4, "abc"},
		{"ascii_exact", "abc", 3, "abc"},
		{"ascii_long", "abcd", 3, "abc"},
		{"byte_boundary", strings.Repeat("a", 127) + "中", 128, strings.Repeat("a", 127) + "中"},
		{"character_boundary", strings.Repeat("a", 127) + "中国", 128, strings.Repeat("a", 127) + "中"},
		{"multibyte", "é中文😀z", 4, "é中文😀"},
		{"multibyte_exact", "中文", 2, "中文"},
		{"combining_characters", "e\u0301x", 2, "e\u0301"},
		{"zero", "中", 0, ""},
		{"negative", "中", -1, ""},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got := fitWidth(tc.input, tc.width)
			if got != tc.want || !utf8.ValidString(got) {
				t.Fatalf("fitWidth(%q, %d) = %q, want %q", tc.input, tc.width, got, tc.want)
			}
		})
	}
}
