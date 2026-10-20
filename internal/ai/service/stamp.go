package service

import (
	"bytes"
	"encoding/json"
	"errors"
)

var (
	errStreaming = errors.New("streaming")
	errInvalid   = errors.New("invalid")
)

// Stamp rejects an explicit stream:true and writes stream:false plus model.
// The returned bytes are what the host posts. RelayKit does not replace them.
func Stamp(body []byte, model string) ([]byte, error) {
	dec := json.NewDecoder(bytes.NewReader(body))
	dec.UseNumber()
	var object map[string]any
	if err := dec.Decode(&object); err != nil {
		return nil, errInvalid
	}
	if dec.More() {
		return nil, errInvalid
	}
	switch value := object["stream"].(type) {
	case nil:
	case bool:
		if value {
			return nil, errStreaming
		}
	default:
		return nil, errInvalid
	}
	object["stream"] = false
	object["model"] = model
	out, err := json.Marshal(object)
	if err != nil {
		return nil, errInvalid
	}
	return out, nil
}
