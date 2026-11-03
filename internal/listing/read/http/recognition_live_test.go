package readhttp_test

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	ai "github.com/xxww0098/podhub-go/internal/ai/contract"
	core "github.com/xxww0098/podhub-go/internal/listing/core"
	"github.com/xxww0098/podhub-go/internal/listing/core/service/engine"
	readhttp "github.com/xxww0098/podhub-go/internal/listing/read/http"
)

// Opt-in paid verification uses the production request and server WASM validator.
func TestLiveArtworkAcrossProducts(t *testing.T) {
	file := os.Getenv("PODHUB_OCR_LIVE_CREDENTIALS")
	if file == "" {
		t.Skip("real provider credentials not requested")
	}
	var config struct {
		BaseURL string `json:"base_url"`
		Model   string `json:"model"`
		Key     string `json:"api_key"`
	}
	load := func(path string) []byte {
		b, err := os.ReadFile(path)
		if err != nil {
			t.Fatal(err)
		}
		return b
	}
	if err := json.Unmarshal(load(file), &config); err != nil {
		t.Fatal("invalid credentials file")
	}
	if config.Model != "qwen3.7-flash" || !strings.HasPrefix(config.BaseURL, "https://") || config.Key == "" {
		t.Fatal("unexpected live configuration")
	}
	pixels := load(os.Getenv("PODHUB_OCR_LIVE_IMAGE"))
	out := os.Getenv("PODHUB_OCR_LIVE_OUTPUT")
	if out == "" {
		t.Fatal("output directory is required for live evidence")
	}
	ctx := context.Background()
	mod, err := core.OpenEmbedded(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer mod.Close(ctx)
	host := readhttp.Host{Core: mod, Engine: engine.New(mod), LoadRules: func(context.Context) ([]readhttp.Rule, error) { return nil, nil }}
	client := http.Client{Timeout: 75 * time.Second}
	for i, p := range []ai.ProductProfile{
		{ProductTypeRU: "Картина по номерам", FactsRU: "40×50 см на подрамнике"},
		{ProductTypeRU: "Кружка", FactsRU: "керамическая 330 мл"},
		{ProductTypeRU: "Коврик для мыши", FactsRU: "800×300 мм"},
		{ProductTypeRU: "Футболка", FactsRU: "хлопковая"},
		{ProductTypeRU: "Сумка-шоппер", FactsRU: "хлопковая 35×40 см"},
		{ProductTypeRU: "Наволочка декоративная", FactsRU: "45×45 см"},
	} {
		profile, _ := json.Marshal(p)
		pin := ai.Pin{Contract: ai.RecognitionContract, Prompt: ai.Prompt{Content: string(profile), FixedTags: []string{"#товар"}, TemplateSHA256: ai.VisualPromptSHA256()}}
		body, err := ai.RecognitionRequest(config.Model, pin.Prompt, "data:image/jpeg;base64,"+base64.StdEncoding.EncodeToString(pixels))
		if err != nil {
			t.Fatal(err)
		}
		req, err := http.NewRequestWithContext(ctx, http.MethodPost, config.BaseURL+"/chat/completions", bytes.NewReader(body))
		if err != nil {
			t.Fatal(err)
		}
		req.Header.Set("Authorization", "Bearer "+config.Key)
		req.Header.Set("Content-Type", "application/json")
		resp, err := client.Do(req)
		if err != nil {
			t.Fatal("live request failed")
		}
		raw, readErr := io.ReadAll(io.LimitReader(resp.Body, 2<<20))
		resp.Body.Close()
		if readErr != nil || resp.StatusCode != 200 {
			t.Fatalf("live provider status %d", resp.StatusCode)
		}
		answer, err := host.ValidateOCR(ctx, pin, raw)
		if err != nil {
			t.Fatal(err)
		}
		var got ai.Answer
		if json.Unmarshal(answer, &got) != nil || !strings.HasPrefix(got.RU, p.TitleBase()+` "`) {
			t.Fatal("confirmed product facts changed")
		}
		if len(got.Tags) != 6 || got.Tags[0] != "#товар" || !strings.HasPrefix(got.Description, p.TitleBase()+". ") {
			t.Fatal("visual description and five generated tags were not assembled with the confirmed facts")
		}
		evidence, _ := json.MarshalIndent(map[string]any{"profile": p, "completion": json.RawMessage(raw), "answer": json.RawMessage(answer), "template_sha256": pin.Prompt.TemplateSHA256}, "", "  ")
		if err := os.WriteFile(filepath.Join(out, "production-live-"+string(rune('1'+i))+".json"), evidence, 0600); err != nil {
			t.Fatal(err)
		}
		t.Log(got.RU)
	}
}
