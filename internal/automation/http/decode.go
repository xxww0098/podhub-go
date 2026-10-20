package automationhttp

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"strings"

	"github.com/xxww0098/podhub-go/internal/automation/contract"
)

func readJSON(r *http.Request, dst any) *contract.Fault {
	media := r.Header.Get("Content-Type")
	if i := strings.IndexByte(media, ';'); i >= 0 {
		media = media[:i]
	}
	if !strings.EqualFold(strings.TrimSpace(media), "application/json") {
		return contract.Validation(contract.MsgBadJSON)
	}
	body, err := io.ReadAll(r.Body)
	if err != nil || len(bytes.TrimSpace(body)) == 0 {
		return contract.Validation(contract.MsgBadJSON)
	}
	dec := json.NewDecoder(bytes.NewReader(body))
	dec.DisallowUnknownFields()
	if err := dec.Decode(dst); err != nil {
		return contract.Validation(contract.MsgBadJSON)
	}
	var extra struct{}
	if err := dec.Decode(&extra); err != io.EOF {
		return contract.Validation(contract.MsgBadJSON)
	}
	return nil
}

func parseSize(raw json.RawMessage) (int64, *contract.Fault) {
	if len(raw) == 0 {
		return 0, nil
	}
	if bytes.Equal(bytes.TrimSpace(raw), []byte("null")) {
		return 0, contract.Validation(contract.MsgBadJSON)
	}
	var n int64
	if err := json.Unmarshal(raw, &n); err != nil {
		return 0, contract.Validation(contract.MsgBadJSON)
	}
	return n, nil
}
