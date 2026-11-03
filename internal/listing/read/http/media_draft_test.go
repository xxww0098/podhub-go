package readhttp

import (
	"strings"
	"testing"
)

func TestCanonicalDraftMediaTypes(t *testing.T) {
	for _, value := range []string{
		`{"kind":"text","value":"https://example.invalid/a.jpg"}`,
		`{"kind":"url","value":"https://example.invalid/a.jpg"}`,
		`{"kind":"url_list","value":["https://example.invalid/a.jpg"]}`,
		`{"kind":"text_list","value":[]}`,
	} {
		if _, _, err := canonicalDraft([]byte(`{"values":{"images":` + value + `},"complex_values":[]}`)); err != nil {
			t.Fatalf("valid media %s: %v", value, err)
		}
	}
	for _, value := range []string{
		`null`, `{}`, `{"kind":"url_list","value":"wrong"}`,
		`{"kind":"url_list","value":[null]}`, `{"kind":"url_list","value":[1]}`,
		`{"kind":"url_list","value":null}`, `{"kind":"text","value":null}`,
		`{"kind":"text","value":[]}`, `{"kind":"integer","value":1}`,
		`{"Kind":"url_list","Value":["https://example.invalid/a.jpg"]}`,
		`{"kind":"url_list","Value":["https://example.invalid/a.jpg"]}`,
	} {
		for _, key := range []string{"images", "images360", "primary_image", "color_image"} {
			if _, _, err := canonicalDraft([]byte(`{"values":{"` + key + `":` + value + `},"complex_values":[]}`)); err == nil {
				t.Fatalf("malformed media allowed: %s = %s", key, value)
			}
		}
	}
}

func TestCanonicalDraftNormalizesMediaTags(t *testing.T) {
	encoded, _, err := canonicalDraft([]byte(`{"values":{"images":{"kind":"text","value":"old","kind":"url_list","value":["https://example.invalid/a.jpg"]}},"complex_values":[]}`))
	if err != nil || strings.Count(encoded, `"kind"`) != 1 || strings.Count(encoded, `"value"`) != 1 || !strings.Contains(encoded, `"kind":"url_list"`) {
		t.Fatalf("ambiguous media tags reached the core: %s, %v", encoded, err)
	}
}
