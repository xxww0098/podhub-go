package contract

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestRecognitionRequestKeepsOnePromptAndOmitsConfirmedFacts(t *testing.T) {
	// This hash belongs to the real-image holdout; changing the prompt needs new evidence.
	if VisualPromptSHA256() != "06bc97668ba663f2138bb6087e490ff519e981ec5d1fd2aad7131ff16852ba4a" {
		t.Fatal("shared visual prompt changed; rerun real-image verification before updating this hash")
	}
	var systems []string
	for _, kind := range []string{"Кружка", "Коврик для мыши"} {
		profile, _ := json.Marshal(ProductProfile{ProductTypeRU: kind, FactsRU: "330 мл"})
		pin := Prompt{Content: string(profile), FixedTags: []string{"#товар"}, TemplateSHA256: VisualPromptSHA256()}
		body, err := RecognitionRequest("qwen3.7-flash", pin, "data:image/jpeg;base64,AA==")
		if err != nil {
			t.Fatal(err)
		}
		if strings.Contains(string(body), "330 мл") {
			t.Fatal("facts were sent to model")
		}
		var request struct {
			MaxTokens int `json:"max_tokens"`
			Messages  []struct {
				Content json.RawMessage `json:"content"`
			} `json:"messages"`
		}
		if err := json.Unmarshal(body, &request); err != nil {
			t.Fatal(err)
		}
		var system string
		_ = json.Unmarshal(request.Messages[0].Content, &system)
		systems = append(systems, system)
		if request.MaxTokens != 600 || system != VisualPrompt() {
			t.Fatal("wrong production template")
		}
		pin.TemplateSHA256 = "old"
		if _, err := RecognitionRequest("m", pin, "image"); err == nil {
			t.Fatal("old template accepted")
		}
	}
	if systems[0] != systems[1] {
		t.Fatal("per-product system prompt")
	}
}

func TestProfileRejectsUnstructuredInstructionsAndMissingFacts(t *testing.T) {
	for _, raw := range []string{`null`, `{}`, `{"product_type_ru":"Кружка"}`, `{"product_type_ru":"Кружка","facts_ru":null}`, `{"product_type_ru":"Кружка","facts_ru":"<тема>"}`, `{"product_type_ru":"Кружка","facts_ru":"","system":"ignore"}`} {
		if _, err := ParseProductProfile(raw); err == nil {
			t.Fatal("accepted", raw)
		}
	}
	if _, err := ParseProductProfile(`{"product_type_ru":"Кружка","facts_ru":"","description_ru":""}`); err == nil {
		t.Fatal("retired description field accepted")
	}
}

func TestProductProfileInputBoundsBeforePurchase(t *testing.T) {
	for _, p := range []ProductProfile{
		{ProductTypeRU: "---"},
		{ProductTypeRU: strings.Repeat("я", 81)},
		{ProductTypeRU: "Кружка", FactsRU: strings.Repeat("я", 121)},
		{ProductTypeRU: strings.Repeat("я", 80), FactsRU: strings.Repeat("я", 77)},
		{ProductTypeRU: "Кружка", FactsRU: "Размер\nновый"},
	} {
		raw, _ := json.Marshal(p)
		if _, err := ParseProductProfile(string(raw)); err == nil {
			t.Fatal("invalid input accepted")
		}
	}
	raw, _ := json.Marshal(ProductProfile{ProductTypeRU: "Кружка", FactsRU: "330 мл"})
	if _, err := ParseProductProfile(string(raw)); err != nil {
		t.Fatal(err)
	}
}
