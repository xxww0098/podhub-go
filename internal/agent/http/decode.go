package agenthttp

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"mime"
	"net/http"

	"github.com/xxww0098/podhub-go/internal/agent/contract"
	"github.com/xxww0098/podhub-go/internal/agent/domain"
)

func invalidBody() *contract.Failure {
	return contract.Fail(contract.KindValidation, "请求格式无效")
}

func jsonMedia(header string) bool {
	if header == "" {
		return false
	}
	media, _, err := mime.ParseMediaType(header)
	return err == nil && media == "application/json"
}

// decodeObject is the JsonRejection arm: content type, the 2 MiB limit,
// one JSON object, and no unknown or missing keys. Oversize is the same 400
// as a syntax error. JSON null for an Option field stays a present key.
func decodeObject(r *http.Request, keys ...string) (map[string]json.RawMessage, *contract.Failure) {
	if !jsonMedia(r.Header.Get("Content-Type")) {
		return nil, invalidBody()
	}
	body := http.MaxBytesReader(nil, r.Body, domain.BodyLimitBytes)
	defer body.Close()
	dec := json.NewDecoder(body)
	dec.UseNumber()
	var obj map[string]json.RawMessage
	if err := dec.Decode(&obj); err != nil || obj == nil {
		return nil, invalidBody()
	}
	var extra any
	if err := dec.Decode(&extra); !errors.Is(err, io.EOF) {
		return nil, invalidBody()
	}
	allow := make(map[string]struct{}, len(keys))
	for _, key := range keys {
		allow[key] = struct{}{}
		if _, ok := obj[key]; !ok {
			return nil, invalidBody()
		}
	}
	for key := range obj {
		if _, ok := allow[key]; !ok {
			return nil, invalidBody()
		}
	}
	return obj, nil
}

func requiredString(raw json.RawMessage) (string, *contract.Failure) {
	if bytes.Equal(bytes.TrimSpace(raw), []byte("null")) {
		return "", invalidBody()
	}
	var out string
	if err := json.Unmarshal(raw, &out); err != nil {
		return "", invalidBody()
	}
	return out, nil
}

func optionalString(raw json.RawMessage) (*string, *contract.Failure) {
	if bytes.Equal(bytes.TrimSpace(raw), []byte("null")) {
		return nil, nil
	}
	s, fail := requiredString(raw)
	if fail != nil {
		return nil, fail
	}
	return &s, nil
}

func requiredInt64(raw json.RawMessage) (int64, *contract.Failure) {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 || trimmed[0] == '"' || bytes.Equal(trimmed, []byte("null")) {
		return 0, invalidBody()
	}
	var value int64
	if err := json.Unmarshal(trimmed, &value); err != nil {
		return 0, invalidBody()
	}
	return value, nil
}
