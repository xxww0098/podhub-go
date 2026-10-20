package domain

import (
	"bytes"
	"compress/gzip"
	"encoding/json"
	"io"
)

// SchemaPayloadLimit is the 4 MiB decoded field document cap.
const SchemaPayloadLimit = 4 << 20

// DecodeSchemaFields gunzips a cache payload and returns the JSON array bytes.
// Extra object keys are preserved. A non-array document is corrupt.
func DecodeSchemaFields(payload []byte) (json.RawMessage, error) {
	reader, err := gzip.NewReader(bytes.NewReader(payload))
	if err != nil {
		return nil, err
	}
	defer reader.Close()
	raw, err := io.ReadAll(io.LimitReader(reader, SchemaPayloadLimit+1))
	if err != nil {
		return nil, err
	}
	if len(raw) > SchemaPayloadLimit || !json.Valid(raw) {
		return nil, io.ErrUnexpectedEOF
	}
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 || trimmed[0] != '[' {
		return nil, io.ErrUnexpectedEOF
	}
	return json.RawMessage(trimmed), nil
}
