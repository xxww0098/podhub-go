package delegatehttp

import (
	"bytes"
	"encoding/json"
	"io"
	"mime"
	"net/http"
	"strconv"
	"strings"
	"unicode/utf8"

	"github.com/xxww0098/podhub-go/internal/delegate/contract"
	"github.com/xxww0098/podhub-go/internal/delegate/domain"
)

const (
	businessBodyLimit int64 = 2 * 1024 * 1024
	assetBodyLimit    int64 = 64 * 1024
)

func readJSON(w http.ResponseWriter, r *http.Request, limit int64, asset bool) ([]byte, bool) {
	mediaType, _, err := mime.ParseMediaType(r.Header.Get("Content-Type"))
	if err != nil || mediaType != "application/json" {
		invalidJSON(w, asset)
		return nil, false
	}
	raw, err := io.ReadAll(http.MaxBytesReader(nil, r.Body, limit))
	if err != nil {
		invalidJSON(w, asset)
		return nil, false
	}
	return raw, true
}

func decodeStrict(raw []byte, dest any) bool {
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.DisallowUnknownFields()
	if err := dec.Decode(dest); err != nil {
		return false
	}
	var extra any
	if err := dec.Decode(&extra); err != io.EOF {
		return false
	}
	return true
}

func invalidJSON(w http.ResponseWriter, asset bool) {
	writeAPI(w, contract.Validation(contract.MsgInvalidJSON), asset)
}

func reqString(raw *json.RawMessage) (string, bool) {
	if raw == nil || bytes.Equal(*raw, []byte("null")) {
		return "", false
	}
	var value string
	if err := json.Unmarshal(*raw, &value); err != nil {
		return "", false
	}
	return value, true
}

func defString(raw *json.RawMessage) (string, bool) {
	if raw == nil {
		return "", true
	}
	if bytes.Equal(*raw, []byte("null")) {
		return "", false
	}
	var value string
	if err := json.Unmarshal(*raw, &value); err != nil {
		return "", false
	}
	return value, true
}

func optString(raw *json.RawMessage) (*string, bool) {
	if raw == nil || bytes.Equal(*raw, []byte("null")) {
		return nil, true
	}
	var value string
	if err := json.Unmarshal(*raw, &value); err != nil {
		return nil, false
	}
	return &value, true
}

func optBool(raw *json.RawMessage) (*bool, bool) {
	if raw == nil || bytes.Equal(*raw, []byte("null")) {
		return nil, true
	}
	var value bool
	if err := json.Unmarshal(*raw, &value); err != nil {
		return nil, false
	}
	return &value, true
}

func reqInt64(raw *json.RawMessage) (int64, bool) {
	if raw == nil || bytes.Equal(*raw, []byte("null")) {
		return 0, false
	}
	dec := json.NewDecoder(bytes.NewReader(*raw))
	dec.UseNumber()
	var number json.Number
	if err := dec.Decode(&number); err != nil {
		return 0, false
	}
	value, err := number.Int64()
	if err != nil {
		return 0, false
	}
	return value, true
}

func defInt64(raw *json.RawMessage, fallback int64) (int64, bool) {
	if raw == nil {
		return fallback, true
	}
	return reqInt64(raw)
}

func optOffers(raw *json.RawMessage) ([]string, bool, bool) {
	if raw == nil || bytes.Equal(*raw, []byte("null")) {
		return nil, false, true
	}
	var ids []string
	if err := json.Unmarshal(*raw, &ids); err != nil {
		return nil, false, false
	}
	return ids, true, true
}

func optCursor(raw *json.RawMessage) (string, bool) {
	if raw == nil || bytes.Equal(*raw, []byte("null")) {
		return "", true
	}
	var value string
	if err := json.Unmarshal(*raw, &value); err != nil {
		return "", false
	}
	return strings.TrimSpace(value), true
}

func checksumRequested(r *http.Request, sha string) bool {
	return strings.TrimSpace(r.Header.Get("x-podhub-store-checksum")) == sha
}

func headerUTF8(r *http.Request, name string) bool {
	return utf8.ValidString(r.Header.Get(name))
}

func writeQuery(w http.ResponseWriter, field string) {
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	w.WriteHeader(http.StatusBadRequest)
	_, _ = w.Write([]byte(domain.QueryMissing(field)))
}

func writeQueryType(w http.ResponseWriter) {
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	w.WriteHeader(http.StatusBadRequest)
	_, _ = w.Write([]byte("Failed to deserialize query string: invalid digit found in string"))
}

func parseQueryInt(raw string) (int64, bool) {
	value, err := strconv.ParseInt(raw, 10, 64)
	if err != nil {
		return 0, false
	}
	return value, true
}
