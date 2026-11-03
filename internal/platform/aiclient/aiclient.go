// Package aiclient speaks the three provider wire formats the host calls:
// OpenAI Chat Completions, Anthropic Messages, and OpenAI Responses.
//
// It does not convert between formats. The caller sends the body in the
// account's own format, and the response is returned unchanged. It does not
// choose accounts, authenticate users, or bill; the AI domain owns those.
package aiclient

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// Format is one upstream wire format. Values match the stored account format
// and ai_requests.api_format.
type Format string

const (
	ChatCompletions   Format = "chat_completions"
	AnthropicMessages Format = "anthropic_messages"
	Responses         Format = "responses"
)

// Valid reports whether f is one of the three supported formats.
func (f Format) Valid() bool {
	switch f {
	case ChatCompletions, AnthropicMessages, Responses:
		return true
	default:
		return false
	}
}

const (
	// MaxBody is the request and response limit. It matches the host's old
	// relay cap.
	MaxBody = 2 << 20
	// DefaultTimeout bounds one provider call when Client.Timeout is zero.
	DefaultTimeout = 120 * time.Second
)

var (
	// ErrInvalid means the body is not one JSON object or has a bad field.
	ErrInvalid = errors.New("invalid ai request")
	// ErrStreaming means the request asked for a stream. This build is
	// non-streaming for all three formats.
	ErrStreaming = errors.New("streaming is not supported")
	// ErrFormat means the account format is unknown.
	ErrFormat = errors.New("unsupported ai api format")
	// ErrResponse means the response exceeded MaxBody.
	ErrResponse = errors.New("ai response too large")
)

// Account is the provider endpoint and credential for one call.
type Account struct {
	ID      string
	BaseURL string
	APIKey  string
	Model   string
	Format  Format
}

// Client posts one native request. HTTP must be a client whose transport
// already enforces the egress policy. A zero Timeout uses DefaultTimeout.
type Client struct {
	HTTP    *http.Client
	Timeout time.Duration
}

// Complete posts body to the account's native endpoint and returns the status
// and up to MaxBody response bytes. A non-2xx status is not an error.
func (c Client) Complete(ctx context.Context, account Account, body []byte) (int, []byte, error) {
	if !account.Format.Valid() {
		return 0, nil, ErrFormat
	}
	if len(body) > MaxBody {
		return 0, nil, ErrInvalid
	}
	endpoint, err := Endpoint(account.BaseURL, account.Format)
	if err != nil {
		return 0, nil, err
	}
	timeout := c.Timeout
	if timeout <= 0 {
		timeout = DefaultTimeout
	}
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(body))
	if err != nil {
		return 0, nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	SetAuth(req.Header, account.Format, account.APIKey)
	client := c.HTTP
	if client == nil {
		return 0, nil, errors.New("ai client has no http client")
	}
	resp, err := client.Do(req)
	if err != nil {
		return 0, nil, err
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(resp.Body, MaxBody+1))
	if err != nil {
		return resp.StatusCode, nil, err
	}
	if len(raw) > MaxBody {
		return resp.StatusCode, nil, ErrResponse
	}
	return resp.StatusCode, raw, nil
}

// Endpoint joins the configured API root with the native path. The base URL
// is the provider API root: OpenAI roots normally end in /v1 and are used as
// given; an Anthropic root without /v1 gets /v1/messages.
func Endpoint(base string, format Format) (string, error) {
	base = strings.TrimRight(strings.TrimSpace(base), "/")
	if base == "" {
		return "", errors.New("ai endpoint is empty")
	}
	u, err := url.Parse(base)
	if err != nil || u.Host == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" {
		return "", errors.New("ai endpoint is invalid")
	}
	if u.Scheme != "https" && u.Scheme != "http" {
		return "", errors.New("ai endpoint must be http or https")
	}
	path := strings.TrimRight(u.Path, "/")
	switch format {
	case ChatCompletions:
		path += "/chat/completions"
	case Responses:
		path += "/responses"
	case AnthropicMessages:
		if strings.HasSuffix(path, "/v1") {
			path += "/messages"
		} else {
			path += "/v1/messages"
		}
	default:
		return "", ErrFormat
	}
	u.Path = path
	u.RawPath = ""
	return u.String(), nil
}

// SetAuth writes the native authentication headers. Anthropic uses x-api-key
// and a fixed API version; the OpenAI formats use a bearer token.
func SetAuth(header http.Header, format Format, key string) {
	switch format {
	case AnthropicMessages:
		header.Set("x-api-key", key)
		header.Set("anthropic-version", "2023-06-01")
	case ChatCompletions, Responses:
		header.Set("Authorization", "Bearer "+key)
	}
}

// Stamp rejects an explicit stream:true and writes stream:false plus the
// routed model. Other fields are preserved byte-for-value; numbers are kept
// as json.Number so large ids are not rounded.
func Stamp(body []byte, model string, format Format) ([]byte, error) {
	if !format.Valid() {
		return nil, ErrFormat
	}
	dec := json.NewDecoder(bytes.NewReader(body))
	dec.UseNumber()
	var object map[string]any
	if err := dec.Decode(&object); err != nil || object == nil {
		return nil, ErrInvalid
	}
	var trailing any
	if err := dec.Decode(&trailing); !errors.Is(err, io.EOF) {
		return nil, ErrInvalid
	}
	switch value := object["stream"].(type) {
	case nil:
	case bool:
		if value {
			return nil, ErrStreaming
		}
	default:
		return nil, ErrInvalid
	}
	object["stream"] = false
	object["model"] = model
	out, err := json.Marshal(object)
	if err != nil {
		return nil, fmt.Errorf("marshal ai request: %w", err)
	}
	return out, nil
}

// Model reads the top-level model field without decoding the whole body.
func Model(body []byte) (string, error) {
	var object struct {
		Model string `json:"model"`
	}
	if err := json.Unmarshal(body, &object); err != nil || object.Model == "" || len(object.Model) > 128 {
		return "", ErrInvalid
	}
	return object.Model, nil
}
