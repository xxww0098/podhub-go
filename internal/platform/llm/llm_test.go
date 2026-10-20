package llm

import (
	"bytes"
	"context"
	"log/slog"
	"strings"
	"testing"

	"github.com/QuantumNous/new-api/relaykit/dto"
	"github.com/QuantumNous/new-api/relaykit/relayconvert"
	"github.com/QuantumNous/new-api/relaykit/types"
)

func TestOpenAIChatConvertsToClaude(t *testing.T) {
	service := New(relayconvert.MediaResolver{})
	maxTokens := uint(1024)
	result, err := service.ConvertRequest(context.Background(), Request{
		Target: ProtocolClaude,
		Body: &dto.GeneralOpenAIRequest{
			Model: "claude-sonnet-4-5",
			Messages: []dto.Message{
				{Role: "user", Content: "Hello!"},
			},
			MaxTokens: &maxTokens,
		},
		OriginModel:   "client-model",
		UpstreamModel: "claude-sonnet-4-5",
	})
	if err != nil {
		t.Fatal(err)
	}
	claude, ok := result.Value.(*dto.ClaudeRequest)
	if !ok {
		t.Fatalf("result type %T", result.Value)
	}
	if claude.Model != "claude-sonnet-4-5" {
		t.Fatalf("model %q", claude.Model)
	}
	if len(claude.Messages) != 1 || claude.Messages[0].Role != "user" || claude.Messages[0].GetStringContent() != "Hello!" {
		t.Fatalf("messages %+v", claude.Messages)
	}
	if result.From != string(types.RelayFormatOpenAI) || result.To != string(types.RelayFormatClaude) {
		t.Fatalf("route %s -> %s", result.From, result.To)
	}
	if result.Converter != relayconvert.ConverterOpenAIChatToClaudeMessages {
		t.Fatalf("converter %q", result.Converter)
	}
	if result.Quality != string(relayconvert.RequestConverterQualityFair) {
		t.Fatalf("quality %q", result.Quality)
	}
}

func TestUnknownProtocolIsRefused(t *testing.T) {
	service := New(relayconvert.MediaResolver{})
	_, err := service.ConvertRequest(context.Background(), Request{
		Target: Protocol("responses-raw"),
		Body:   &dto.GeneralOpenAIRequest{Model: "m", Messages: []dto.Message{{Role: "user", Content: "Hi"}}},
	})
	if err == nil || !strings.Contains(err.Error(), "unsupported upstream protocol") {
		t.Fatal(err)
	}
}

func TestDiagnosticLogRedactsSecrets(t *testing.T) {
	var buf bytes.Buffer
	previous := slog.Default()
	slog.SetDefault(slog.New(slog.NewJSONHandler(&buf, nil)))
	t.Cleanup(func() { slog.SetDefault(previous) })

	publishDiagnostics([]types.ConversionDiagnostic{{
		Code:     "hosted_web_search_omitted",
		Path:     "tools.0",
		Message:  "dropped tool api_key=sk-supersecretvalue Bearer sk-supersecretvalue",
		Severity: types.ConversionDiagnosticError,
		From:     types.RelayFormatOpenAI,
		To:       types.RelayFormatClaude,
	}})
	logged := buf.String()
	if strings.Contains(logged, "sk-supersecretvalue") {
		t.Fatalf("secret leaked: %s", logged)
	}
	if !strings.Contains(logged, "hosted_web_search_omitted") || !strings.Contains(logged, "[REDACTED]") {
		t.Fatalf("diagnostic log: %s", logged)
	}
}
