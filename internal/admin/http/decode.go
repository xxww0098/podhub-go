package adminhttp

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"mime"
	"net/http"

	"github.com/xxww0098/podhub-go/internal/admin/contract"
)

const bodyLimit = 2 << 20

func invalidBody() *contract.Fault {
	return contract.Validation("请求格式无效")
}

func jsonMedia(header string) bool {
	if header == "" {
		return false
	}
	media, _, err := mime.ParseMediaType(header)
	return err == nil && media == "application/json"
}

type object map[string]json.RawMessage

// readObject accepts one JSON object. required keys must be present.
// optional keys may be absent. Any other key is rejected.
func readObject(r *http.Request, required, optional []string) (object, *contract.Fault) {
	if !jsonMedia(r.Header.Get("Content-Type")) {
		return nil, invalidBody()
	}
	body := http.MaxBytesReader(nil, r.Body, bodyLimit)
	defer body.Close()
	dec := json.NewDecoder(body)
	dec.UseNumber()
	var obj object
	if err := dec.Decode(&obj); err != nil || obj == nil {
		return nil, invalidBody()
	}
	var extra any
	if err := dec.Decode(&extra); !errors.Is(err, io.EOF) {
		return nil, invalidBody()
	}
	allow := map[string]struct{}{}
	for _, key := range required {
		allow[key] = struct{}{}
		if _, ok := obj[key]; !ok {
			return nil, invalidBody()
		}
	}
	for _, key := range optional {
		allow[key] = struct{}{}
	}
	for key := range obj {
		if _, ok := allow[key]; !ok {
			return nil, invalidBody()
		}
	}
	return obj, nil
}

func (o object) rawString(key string, required bool) (string, bool, *contract.Fault) {
	raw, ok := o[key]
	if !ok {
		if required {
			return "", false, invalidBody()
		}
		return "", false, nil
	}
	if bytes.Equal(bytes.TrimSpace(raw), []byte("null")) {
		if required {
			return "", false, invalidBody()
		}
		return "", false, nil
	}
	var out string
	if err := json.Unmarshal(raw, &out); err != nil {
		return "", false, invalidBody()
	}
	return out, true, nil
}

func (o object) str(key string) (string, *contract.Fault) {
	s, _, fault := o.rawString(key, true)
	return s, fault
}

func (o object) optStr(key string) (*string, *contract.Fault) {
	s, ok, fault := o.rawString(key, false)
	if fault != nil || !ok {
		return nil, fault
	}
	return &s, nil
}

func (o object) i64(key string) (int64, *contract.Fault) {
	n, ok, fault := o.rawI64(key)
	if fault != nil {
		return 0, fault
	}
	if !ok {
		return 0, invalidBody()
	}
	return n, nil
}

func (o object) optI64(key string) (*int64, *contract.Fault) {
	n, ok, fault := o.rawI64(key)
	if fault != nil || !ok {
		return nil, fault
	}
	return &n, nil
}

func (o object) rawI64(key string) (int64, bool, *contract.Fault) {
	raw, ok := o[key]
	if !ok {
		return 0, false, nil
	}
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 || trimmed[0] == '"' || bytes.Equal(trimmed, []byte("null")) {
		return 0, false, invalidBody()
	}
	var value int64
	if err := json.Unmarshal(trimmed, &value); err != nil {
		return 0, false, invalidBody()
	}
	return value, true, nil
}

func (o object) boolean(key string, required bool) (bool, *contract.Fault) {
	raw, ok := o[key]
	if !ok {
		if required {
			return false, invalidBody()
		}
		return false, nil
	}
	switch string(bytes.TrimSpace(raw)) {
	case "true":
		return true, nil
	case "false":
		return false, nil
	default:
		return false, invalidBody()
	}
}

func (o object) objects(key string) ([]object, *contract.Fault) {
	raw, ok := o[key]
	if !ok || bytes.Equal(bytes.TrimSpace(raw), []byte("null")) {
		return nil, invalidBody()
	}
	var rows []json.RawMessage
	if err := json.Unmarshal(raw, &rows); err != nil {
		return nil, invalidBody()
	}
	out := make([]object, 0, len(rows))
	for _, row := range rows {
		var item object
		dec := json.NewDecoder(bytes.NewReader(row))
		dec.UseNumber()
		if err := dec.Decode(&item); err != nil || item == nil {
			return nil, invalidBody()
		}
		out = append(out, item)
	}
	return out, nil
}
