// Package llm is the only RelayKit entry in this process.
//
// RelayKit converts OpenAI Chat, OpenAI Responses, Claude Messages, and
// Gemini generateContent. It does not send HTTP, authenticate, or bill.
// Rust's paid calls stay on OpenAI Chat Completions in xxww0098/podhub
// (src/ai/account_pool.rs, crates/ai-gateway/src/url.rs). This package does
// not dial a provider and does not accept an API key.
//
// # License obligations
//
// RelayKit (github.com/QuantumNous/new-api/relaykit) is GNU AGPL-3.0. No
// commercial RelayKit license is held, so it is used under the AGPL, and the
// processes that link this package are AGPL-3.0-only as a whole (see LICENSE
// and NOTICE at the repository root). Under section 13, anyone who runs a
// modified version as a network service must offer its users the
// Corresponding Source of that version. Conveying a binary or image requires
// the source under section 6. RelayKit's copyright and license notices must
// be kept. Do not route around this package to hide RelayKit from that
// source; it is the only RelayKit entry.
package llm

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"regexp"
	"strings"

	"github.com/QuantumNous/new-api/relaykit/dto"
	"github.com/QuantumNous/new-api/relaykit/relayconvert"
	"github.com/QuantumNous/new-api/relaykit/relayconvert/convmeta"
	"github.com/QuantumNous/new-api/relaykit/relayconvert/kitutil"
	"github.com/QuantumNous/new-api/relaykit/types"
)

// Protocol is the wire the host will speak after conversion.
type Protocol string

const (
	ProtocolOpenAIChat      Protocol = "openai_chat"
	ProtocolOpenAIResponses Protocol = "openai_responses"
	ProtocolClaude          Protocol = "claude"
	ProtocolGemini          Protocol = "gemini"
)

// Request is one protocol conversion. Body is a RelayKit request or response
// DTO. OriginModel is the caller's name; UpstreamModel is the name written
// for the chosen upstream. Neither field is a credential.
type Request struct {
	Target        Protocol
	Body          any
	OriginModel   string
	UpstreamModel string
}

// Step is one hop RelayKit actually took.
type Step struct {
	Converter string
	From      string
	To        string
}

// Diagnostic is a conversion loss report. Messages are redacted before they
// are logged or returned.
type Diagnostic struct {
	Code     string
	Path     string
	Message  string
	Severity string
	From     string
	To       string
}

// Result is the converted DTO plus the route RelayKit selected.
type Result struct {
	Value       any
	From        string
	To          string
	Converter   string
	Quality     string
	Steps       []Step
	Diagnostics []Diagnostic
	Stream      bool
}

// StreamOptions are the fields RelayKit needs to number and close a stream.
// The host still reads and writes SSE.
type StreamOptions struct {
	ID                 string
	Model              string
	Created            int64
	IncludeUsage       bool
	EmitSequenceNumber bool
}

// Service converts protocol DTOs. HTTP, auth, and billing stay outside.
type Service struct{}

func init() {
	kitutil.SetLogging(logKitInfo, logKitError)
	kitutil.SetSystemErrorLogging(logKitError)
}

// New registers the process-wide media resolver. RelayKit calls it when a
// conversion must download a URL or decode a data URL. A zero resolver leaves
// those conversions failing closed. Text-only conversions do not need it.
// The resolver must not log credentials.
func New(resolver relayconvert.MediaResolver) *Service {
	relayconvert.SetMediaResolver(resolver)
	return &Service{}
}

// Default is the text-only RelayKit converter. It does not download media.
func Default() *Service {
	return New(relayconvert.MediaResolver{})
}

// ConvertRequest selects the converter from Body's concrete DTO and Target.
func (s *Service) ConvertRequest(ctx context.Context, request Request) (Result, error) {
	if s == nil {
		return Result{}, fmt.Errorf("llm service is nil")
	}
	target, err := format(request.Target)
	if err != nil {
		return Result{}, err
	}
	converted, err := relayconvert.ConvertRequest(ctx, meta(request), target, request.Body)
	if converted == nil {
		return Result{}, err
	}
	out := Result{
		Value:       converted.Value,
		From:        string(converted.From),
		To:          string(converted.To),
		Converter:   converted.Converter,
		Quality:     string(converted.Quality),
		Steps:       requestSteps(converted.Steps),
		Diagnostics: publishDiagnostics(converted.Diagnostics),
	}
	return out, err
}

// ConvertResponse selects the converter from the response DTO and Target.
func (s *Service) ConvertResponse(ctx context.Context, request Request) (Result, error) {
	if s == nil {
		return Result{}, fmt.Errorf("llm service is nil")
	}
	target, err := format(request.Target)
	if err != nil {
		return Result{}, err
	}
	converted, err := relayconvert.ConvertResponse(ctx, meta(request), target, request.Body)
	if converted == nil {
		return Result{}, err
	}
	out := Result{
		Value:       converted.Value,
		From:        string(converted.From),
		To:          string(converted.To),
		Converter:   converted.Converter,
		Quality:     string(converted.Quality),
		Steps:       responseSteps(converted.Steps),
		Diagnostics: publishDiagnostics(converted.Diagnostics),
		Stream:      converted.Stream,
	}
	return out, err
}

// Stream is one upstream event sequence. Finalize logs the diagnostics
// accumulated across chunks, including chunks that produced no output.
type Stream struct {
	state *relayconvert.ResponseStreamState
	meta  convmeta.Meta
}

// OpenStream starts a stream conversion from one protocol to another.
func (s *Service) OpenStream(from, to Protocol, options StreamOptions) (*Stream, error) {
	if s == nil {
		return nil, fmt.Errorf("llm service is nil")
	}
	source, err := format(from)
	if err != nil {
		return nil, err
	}
	target, err := format(to)
	if err != nil {
		return nil, err
	}
	state, err := relayconvert.NewResponseStreamState(source, target, relayconvert.ResponseStreamOptions{
		ID:                 options.ID,
		Model:              options.Model,
		Created:            options.Created,
		IncludeUsage:       options.IncludeUsage,
		EmitSequenceNumber: options.EmitSequenceNumber,
	})
	if err != nil {
		return nil, err
	}
	return &Stream{state: state, meta: &convmeta.Values{UpstreamModelName: options.Model}}, nil
}

// Chunk converts one upstream event. The host parses SSE before this call.
func (s *Stream) Chunk(ctx context.Context, event any) ([]Result, error) {
	if s == nil || s.state == nil {
		return nil, fmt.Errorf("llm stream is nil")
	}
	converted, err := relayconvert.ConvertStreamResponseChunk(ctx, s.meta, s.state, event)
	return responseResults(converted), err
}

// Finalize closes the stream and logs every diagnostic collected so far.
func (s *Stream) Finalize(ctx context.Context) ([]Result, error) {
	if s == nil || s.state == nil {
		return nil, fmt.Errorf("llm stream is nil")
	}
	converted, err := relayconvert.FinalizeStreamResponse(ctx, s.meta, s.state)
	publishDiagnostics(s.state.Diagnostics())
	return responseResults(converted), err
}

func meta(request Request) *convmeta.Values {
	return &convmeta.Values{
		OriginModelName:     request.OriginModel,
		UpstreamModelName:   request.UpstreamModel,
		ChannelMetaAttached: request.UpstreamModel != "",
	}
}

func format(protocol Protocol) (types.RelayFormat, error) {
	switch protocol {
	case ProtocolOpenAIChat:
		return types.RelayFormatOpenAI, nil
	case ProtocolOpenAIResponses:
		return types.RelayFormatOpenAIResponses, nil
	case ProtocolClaude:
		return types.RelayFormatClaude, nil
	case ProtocolGemini:
		return types.RelayFormatGemini, nil
	default:
		return "", fmt.Errorf("unsupported upstream protocol %q", protocol)
	}
}

func requestSteps(steps []relayconvert.RequestStep) []Step {
	out := make([]Step, 0, len(steps))
	for _, step := range steps {
		out = append(out, Step{Converter: step.Converter, From: string(step.From), To: string(step.To)})
	}
	return out
}

func responseSteps(steps []relayconvert.ResponseStep) []Step {
	out := make([]Step, 0, len(steps))
	for _, step := range steps {
		out = append(out, Step{Converter: step.Converter, From: string(step.From), To: string(step.To)})
	}
	return out
}

func responseResults(rows []relayconvert.ResponseResult) []Result {
	out := make([]Result, 0, len(rows))
	for _, row := range rows {
		out = append(out, Result{
			Value:       row.Value,
			From:        string(row.From),
			To:          string(row.To),
			Converter:   row.Converter,
			Quality:     string(row.Quality),
			Steps:       responseSteps(row.Steps),
			Diagnostics: publishDiagnostics(row.Diagnostics),
			Stream:      row.Stream,
		})
	}
	return out
}

func publishDiagnostics(items []types.ConversionDiagnostic) []Diagnostic {
	out := make([]Diagnostic, 0, len(items))
	for _, item := range items {
		published := Diagnostic{
			Code:     item.Code,
			Path:     item.Path,
			Message:  redact(item.Message),
			Severity: string(item.Severity),
			From:     string(item.From),
			To:       string(item.To),
		}
		out = append(out, published)
		level := slog.LevelInfo
		if item.Severity == types.ConversionDiagnosticError {
			level = slog.LevelWarn
		}
		slog.Log(context.Background(), level, "relaykit conversion diagnostic",
			"code", published.Code,
			"path", published.Path,
			"severity", published.Severity,
			"from", published.From,
			"to", published.To,
			"message", published.Message,
		)
	}
	return out
}

func logKitInfo(message string) {
	slog.Info("relaykit", "message", redact(message))
}

func logKitError(message string) {
	slog.Error("relaykit", "message", redact(message))
}

var (
	bearerPattern = regexp.MustCompile(`(?i)\bbearer\s+\S+`)
	apiKeyPattern = regexp.MustCompile(`(?i)\b(api[_-]?key|authorization|x-api-key)\s*[=:]\s*\S+`)
	skPattern     = regexp.MustCompile(`\bsk-[A-Za-z0-9_-]{8,}\b`)
)

func redact(message string) string {
	message = bearerPattern.ReplaceAllString(message, "Bearer [REDACTED]")
	message = apiKeyPattern.ReplaceAllStringFunc(message, func(match string) string {
		separator := ":"
		if strings.Contains(match, "=") {
			separator = "="
		}
		head, _, _ := strings.Cut(match, separator)
		return head + separator + "[REDACTED]"
	})
	return skPattern.ReplaceAllString(message, "[REDACTED]")
}

// Converter is the protocol seam. *Service is the RelayKit implementation.
// Hold, settle, and the HTTP client do not import RelayKit; they call this
// interface, so another implementation can replace it.
//
// RelayKit is GNU AGPL-3.0. Whether this process keeps that implementation
// in a distributed build is a user decision. The paid outbound body stays
// the stamped Chat Completions JSON either way.
type Converter interface {
	ConvertRequest(ctx context.Context, request Request) (Result, error)
	ConvertResponse(ctx context.Context, request Request) (Result, error)
	OpenStream(from, to Protocol, options StreamOptions) (*Stream, error)
	AcceptChat(ctx context.Context, stamped []byte, upstreamModel string) error
	AcceptCompletion(ctx context.Context, completion []byte, upstreamModel string) error
}

// AcceptChat runs the stamped Chat Completions object through RelayKit.
// The host still posts stamped. A nil service fails closed.
func (s *Service) AcceptChat(ctx context.Context, stamped []byte, upstreamModel string) error {
	if s == nil {
		return fmt.Errorf("llm service is nil")
	}
	var body dto.GeneralOpenAIRequest
	if err := json.Unmarshal(stamped, &body); err != nil {
		return err
	}
	// Claude conversion needs a max token budget. This copy is not the body
	// the host posts.
	if body.MaxTokens == nil {
		budget := uint(1024)
		body.MaxTokens = &budget
	}
	_, err := s.ConvertRequest(ctx, Request{
		Target:        ProtocolClaude,
		Body:          &body,
		OriginModel:   body.Model,
		UpstreamModel: upstreamModel,
	})
	return err
}

// AcceptCompletion runs one folded Chat Completions object through RelayKit.
// Settlement still reads the folded JSON, not the converted DTO.
func (s *Service) AcceptCompletion(ctx context.Context, completion []byte, upstreamModel string) error {
	if s == nil {
		return fmt.Errorf("llm service is nil")
	}
	var body dto.OpenAITextResponse
	if err := json.Unmarshal(completion, &body); err != nil {
		return err
	}
	_, err := s.ConvertResponse(ctx, Request{
		Target:        ProtocolOpenAIChat,
		Body:          &body,
		OriginModel:   body.Model,
		UpstreamModel: upstreamModel,
	})
	return err
}
