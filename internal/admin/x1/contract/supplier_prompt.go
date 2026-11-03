package contract

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	ai "github.com/xxww0098/podhub-go/internal/ai/contract"
	"strings"

	contract "github.com/xxww0098/podhub-go/internal/admin/core/contract/outcome"
)

// TemplateSHA256 identifies the one shared visual prompt.
func TemplateSHA256() string { return ai.VisualPromptSHA256() }

func BriefValid(raw string) bool { _, err := CanonicalProfile(raw); return err == nil }

var profileFields = []string{"product_type_ru", "facts_ru"}

func LineValue(raw string, index int) string {
	var values map[string]string
	if index < 0 || index >= len(profileFields) || json.Unmarshal([]byte(raw), &values) != nil {
		return ""
	}
	return values[profileFields[index]]
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

// DiffLine is one confirmed fact.
// Preview is SupplierPromptPreviewData.
type Preview struct {
	Text           string `json:"text"`
	SHA256         string `json:"sha256"`
	TemplateSHA256 string `json:"templateSha256"`
}

// BuildPreview composes the card and both digests. It does not write.
func BuildPreview(brief string, tags []string) (Preview, error) {
	canon, err := CanonicalProfile(brief)
	if err != nil {
		return Preview{}, fail(contract.KindValidation, err.Error())
	}
	norm, err := NormalizeTags(tags, true)
	if err != nil {
		return Preview{}, err
	}
	profile, _ := ai.ParseProductProfile(canon)
	text := profile.TitleBase() + ` "<тема>"`
	return Preview{Text: text, SHA256: RecognitionDigest(text, norm), TemplateSHA256: TemplateSHA256()}, nil
}
