package contract

import (
	"encoding/json"
	"errors"
)

// RecognitionRequest asks for visual copy; confirmed product facts stay outside the model.
func RecognitionRequest(model string, prompt Prompt, imageURL string) ([]byte, error) {
	if prompt.TemplateSHA256 != VisualPromptSHA256() {
		return nil, errors.New("识图规则已变化，请重新准备")
	}
	profile, err := ParseProductProfile(prompt.Content)
	if err != nil {
		return nil, err
	}
	context, err := json.Marshal(map[string]any{"product_type_ru": profile.ProductTypeRU, "image_role": "artwork", "theme_max_chars": 40, "fixed_tags": prompt.FixedTags})
	if err != nil {
		return nil, err
	}
	text := "Опиши рисунок: короткий сюжет, описание и ровно пять хештегов. Данные: " + string(context)
	return json.Marshal(map[string]any{"model": model, "temperature": 0.1, "max_tokens": 600, "enable_thinking": false, "response_format": map[string]string{"type": "json_object"}, "messages": []any{
		map[string]any{"role": "system", "content": VisualPrompt()},
		map[string]any{"role": "user", "content": []any{
			map[string]any{"type": "text", "text": text},
			map[string]any{"type": "image_url", "image_url": map[string]any{"url": imageURL}},
		}},
	}})
}
