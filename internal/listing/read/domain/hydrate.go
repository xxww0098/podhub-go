package domain

import (
	"bytes"
	"encoding/json"
	"fmt"
)

// SchemaRevisionToFetch is the revision HydratePayload would look up.
// A payload that already has schemaSnapshot, or that has no non-empty
// string schemaRevision, does not need a registry read.
func SchemaRevisionToFetch(payload []byte) (string, bool) {
	body := objectOrEmpty(payload)
	if _, ok := body["schemaSnapshot"]; ok {
		return "", false
	}
	revRaw, ok := body["schemaRevision"]
	if !ok {
		return "", false
	}
	var revision string
	if err := json.Unmarshal(revRaw, &revision); err != nil || revision == "" {
		return "", false
	}
	return revision, true
}

// HydratePayload inserts schemaSnapshot when the row names a schemaRevision
// and does not already carry the snapshot. lookup reports whether the
// revision is registered. A missing registry row is the DbErr sentence from
// schema_revisions.rs; the HTTP layer maps that to 500.
func HydratePayload(payload []byte, lookup func(revision string) (json.RawMessage, bool, error)) ([]byte, error) {
	revision, ok := SchemaRevisionToFetch(payload)
	if !ok {
		return payload, nil
	}
	snap, found, err := lookup(revision)
	if err != nil {
		return nil, err
	}
	if !found {
		return nil, fmt.Errorf("schema revision %s is not registered; the row payload references a snapshot the registry does not carry", revision)
	}
	body := objectOrEmpty(payload)
	body["schemaSnapshot"] = snap
	out, err := json.Marshal(body)
	if err != nil {
		return nil, err
	}
	if bytes.Equal(bytes.TrimSpace(payload), []byte("null")) {
		return payload, nil
	}
	return out, nil
}
