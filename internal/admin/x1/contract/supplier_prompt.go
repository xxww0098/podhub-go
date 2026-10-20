package contract

import (
	"bytes"
	"crypto/sha256"
	"embed"
	"encoding/hex"
	"encoding/json"
	"strings"
	"unicode"

	contract "github.com/xxww0098/podhub-go/internal/admin/core/contract/outcome"
)

//go:embed ocr_prompt.ru.txt
var ocrPromptFile embed.FS

// TemplateSHA256 is sha256 of ocr_prompt.ru.txt bytes.
func TemplateSHA256() string {
	raw, _ := ocrPromptFile.ReadFile("ocr_prompt.ru.txt")
	sum := sha256.Sum256(raw)
	return hex.EncodeToString(sum[:])
}

func templateText() string {
	raw, _ := ocrPromptFile.ReadFile("ocr_prompt.ru.txt")
	return string(raw)
}

// BriefValid reports whether the published cell is a canonical six-line card.
func BriefValid(raw string) bool {
	if strings.TrimSpace(raw) == "" {
		return false
	}
	_, err := CanonicalBrief(raw)
	return err == nil
}

// LineValue drops blank lines, takes the index, and strips the label.
func LineValue(brief string, index int) string {
	var lines []string
	for _, line := range strings.Split(brief, "\n") {
		if strings.TrimSpace(line) == "" {
			continue
		}
		lines = append(lines, line)
	}
	if index < 0 || index >= len(lines) {
		return ""
	}
	line := lines[index]
	if index < len(briefLabels) {
		line = strings.TrimPrefix(line, briefLabels[index])
	}
	return strings.TrimSpace(line)
}

// Compose fills {brief} and {fixed_tags} once each.
// Banned terms insert a sentence before the last "Только JSON.".
func Compose(brief string, tags []string, banned []string) string {
	tpl := templateText()
	head, rest, ok := strings.Cut(tpl, "{brief}")
	if !ok {
		return ""
	}
	mid, tail, ok := strings.Cut(rest, "{fixed_tags}")
	if !ok {
		return ""
	}
	text := head + strings.TrimSpace(brief) + mid + strings.Join(tags, " ") + strings.TrimRightFunc(tail, unicode.IsSpace)
	if len(banned) == 0 {
		return text
	}
	const marker = "Только JSON."
	idx := strings.LastIndex(text, marker)
	if idx < 0 {
		return text
	}
	var terms []string
	for _, term := range banned {
		terms = append(terms, "#"+strings.TrimPrefix(strings.TrimSpace(term), "#"))
	}
	insert := "Дополнительно запрещены теги и их словоформы: " + strings.Join(terms, ", ") + ". "
	return text[:idx] + insert + text[idx:]
}

// RecognitionDigest is sha256 of the compact JSON array [text, tags].
func RecognitionDigest(text string, tags []string) string {
	if tags == nil {
		tags = []string{}
	}
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	_ = enc.Encode([]any{text, tags})
	raw := bytes.TrimRight(buf.Bytes(), "\n")
	sum := sha256.Sum256(raw)
	return hex.EncodeToString(sum[:])
}

// NormalizeTags trims tags. Empty is allowed for a row that is not yet ready.
// require forces the 1–30 Russian hashtag rule.
func NormalizeTags(tags []string, require bool) ([]string, error) {
	if tags == nil {
		tags = []string{}
	}
	out := make([]string, len(tags))
	for i, tag := range tags {
		out[i] = strings.TrimSpace(tag)
	}
	if !require && len(out) == 0 {
		return out, nil
	}
	if err := FixedTags(out); err != nil {
		return nil, fail(contract.KindValidation, err.Error())
	}
	return out, nil
}

// TagBanned reports whether any tag hits an enabled banned term.
func TagBanned(tags []string, terms []string) bool {
	for _, tag := range tags {
		body := strings.TrimPrefix(strings.ToLower(strings.TrimSpace(tag)), "#")
		for _, term := range terms {
			term = strings.ToLower(strings.TrimSpace(strings.TrimPrefix(term, "#")))
			if term == "" {
				continue
			}
			if body == term || strings.Contains(body, term) {
				return true
			}
		}
	}
	return false
}

// AiOutput is the three booleans stored as title, description, tags.
type AiOutput struct {
	Title       bool `json:"title"`
	Description bool `json:"description"`
	Tags        bool `json:"tags"`
}

// DefaultAI is title, description and tags all true.
func DefaultAI() AiOutput { return AiOutput{Title: true, Description: true, Tags: true} }

// DiffLine is one of the six card rows.
type DiffLine struct {
	Label     string `json:"label"`
	Published string `json:"published"`
	Draft     string `json:"draft"`
	Changed   bool   `json:"changed"`
}

// PromptDiff is SupplierPromptDiffData.
type PromptDiff struct {
	Revision           int32      `json:"revision"`
	PublishedRevision  *int32     `json:"publishedRevision,omitempty"`
	Lines              []DiffLine `json:"lines"`
	PublishedFixedTags []string   `json:"publishedFixedTags"`
	DraftFixedTags     []string   `json:"draftFixedTags"`
	FixedTagsChanged   bool       `json:"fixedTagsChanged"`
	PublishedAiOutput  AiOutput   `json:"publishedAiOutput"`
	DraftAiOutput      AiOutput   `json:"draftAiOutput"`
	AiOutputChanged    bool       `json:"aiOutputChanged"`
}

// BuildDiff compares a draft snapshot with the published snapshot.
func BuildDiff(revision int32, publishedRevision *int32, publishedBrief string, publishedTags []string, publishedAI AiOutput, draftBrief string, draftTags []string, draftAI AiOutput) PromptDiff {
	if publishedTags == nil {
		publishedTags = []string{}
	}
	if draftTags == nil {
		draftTags = []string{}
	}
	lines := make([]DiffLine, len(briefLabels))
	for i, label := range briefLabels {
		pub := LineValue(publishedBrief, i)
		draft := LineValue(draftBrief, i)
		lines[i] = DiffLine{Label: label, Published: pub, Draft: draft, Changed: pub != draft}
	}
	return PromptDiff{
		Revision: revision, PublishedRevision: publishedRevision, Lines: lines,
		PublishedFixedTags: publishedTags, DraftFixedTags: draftTags,
		FixedTagsChanged:  !sameStrings(publishedTags, draftTags),
		PublishedAiOutput: publishedAI, DraftAiOutput: draftAI,
		AiOutputChanged: publishedAI != draftAI,
	}
}

func sameStrings(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

// Preview is SupplierPromptPreviewData.
type Preview struct {
	Text           string `json:"text"`
	SHA256         string `json:"sha256"`
	TemplateSHA256 string `json:"templateSha256"`
}

// BuildPreview composes the card and both digests. It does not write.
func BuildPreview(brief string, tags []string) (Preview, error) {
	canon, err := CanonicalBrief(brief)
	if err != nil {
		return Preview{}, fail(contract.KindValidation, err.Error())
	}
	norm, err := NormalizeTags(tags, true)
	if err != nil {
		return Preview{}, err
	}
	text := Compose(canon, norm, nil)
	return Preview{Text: text, SHA256: RecognitionDigest(text, norm), TemplateSHA256: TemplateSHA256()}, nil
}
