package domain

import (
	"encoding/json"
	"os"
	"strings"
	"testing"
)

func TestPreviewChernovikDigest(t *testing.T) {
	raw, err := os.ReadFile("testdata/x1/hand/preview-chernovik.json")
	if err != nil {
		t.Fatal(err)
	}
	var doc struct {
		Request struct {
			Brief     string   `json:"brief"`
			FixedTags []string `json:"fixedTags"`
		} `json:"request"`
		Response struct {
			Data Preview `json:"data"`
		} `json:"response"`
	}
	if err := json.Unmarshal(raw, &doc); err != nil {
		t.Fatal(err)
	}
	got, err := BuildPreview(doc.Request.Brief, doc.Request.FixedTags)
	if err != nil {
		t.Fatal(err)
	}
	if got.Text != doc.Response.Data.Text {
		n := len(got.Text)
		if len(doc.Response.Data.Text) < n {
			n = len(doc.Response.Data.Text)
		}
		i := 0
		for i < n && got.Text[i] == doc.Response.Data.Text[i] {
			i++
		}
		t.Fatalf("text mismatch at %d\n got %q\nwant %q", i, snippet(got.Text, i), snippet(doc.Response.Data.Text, i))
	}
	if got.SHA256 != doc.Response.Data.SHA256 || got.TemplateSHA256 != doc.Response.Data.TemplateSHA256 {
		t.Fatalf("sha %s template %s\nwant %s %s", got.SHA256, got.TemplateSHA256, doc.Response.Data.SHA256, doc.Response.Data.TemplateSHA256)
	}
	if !strings.Contains(got.Text, "ЧЕРНОВИК") || len(got.SHA256) != 64 {
		t.Fatal("preview markers")
	}
}

func snippet(s string, i int) string {
	a := i - 40
	if a < 0 {
		a = 0
	}
	b := i + 40
	if b > len(s) {
		b = len(s)
	}
	return s[a:b]
}

func TestDiffSixLines(t *testing.T) {
	raw, err := os.ReadFile("testdata/x1/hand/get-prompt-diff-revision-2.json")
	if err != nil {
		t.Fatal(err)
	}
	var doc struct {
		Response struct {
			Data PromptDiff `json:"data"`
		} `json:"response"`
	}
	if err := json.Unmarshal(raw, &doc); err != nil {
		t.Fatal(err)
	}
	brief, err := os.ReadFile("testdata/x1/brief-minimal.txt")
	if err != nil {
		t.Fatal(err)
	}
	draft := strings.Replace(string(brief), "Товар: ", "Товар: ЧЕРНОВИК ", 1)
	draft = strings.TrimSpace(draft)
	pubRev := int32(1)
	got := BuildDiff(2, &pubRev, strings.TrimSpace(string(brief)), []string{"#кружка"}, DefaultAI(), draft, []string{"#новый"}, DefaultAI())
	gb, _ := json.Marshal(got)
	wb, _ := json.Marshal(doc.Response.Data)
	if string(gb) != string(wb) {
		t.Fatalf("diff\n got %s\nwant %s", gb, wb)
	}
}
