// Package parity compares one HTTP exchange and one database snapshot
// between the Rust reference and the Go port. It does not dial a database
// and it does not strip bytes that the Rust encoder would have kept.
package parity

import (
	"bytes"
	"encoding/json"
	"fmt"
	"regexp"
	"sort"
)

// Exchange is one HTTP response. Body is compared as bytes after masking.
type Exchange struct {
	Status int
	Body   []byte
}

// tsNumber matches the health timestamp. Masking replaces only that number;
// a trailing newline or any other byte still fails the comparison.
var tsNumber = regexp.MustCompile(`"ts":-?\d+`)

// MaskTS zeros the top-level "ts" number so two health bodies can be compared
// without treating the clock as a payload difference.
func MaskTS(body []byte) []byte {
	return tsNumber.ReplaceAll(body, []byte(`"ts":0`))
}

// DiffHTTP reports a status or body mismatch. Bodies are masked with MaskTS
// and then compared with bytes.Equal.
func DiffHTTP(got, want Exchange) error {
	if got.Status != want.Status {
		return fmt.Errorf("status %d, want %d", got.Status, want.Status)
	}
	gb, wb := MaskTS(got.Body), MaskTS(want.Body)
	if !bytes.Equal(gb, wb) {
		return fmt.Errorf("body\n got %s\n want %s", gb, wb)
	}
	return nil
}

// DiffCounts reports tables whose row counts changed between two snapshots.
func DiffCounts(before, after map[string]int64) error {
	keys := map[string]struct{}{}
	for name := range before {
		keys[name] = struct{}{}
	}
	for name := range after {
		keys[name] = struct{}{}
	}
	names := make([]string, 0, len(keys))
	for name := range keys {
		names = append(names, name)
	}
	sort.Strings(names)
	var diffs []string
	for _, name := range names {
		if before[name] != after[name] {
			diffs = append(diffs, fmt.Sprintf("%s %d -> %d", name, before[name], after[name]))
		}
	}
	if len(diffs) > 0 {
		return fmt.Errorf("row counts changed: %v", diffs)
	}
	return nil
}

// CanonicalRows re-encodes a JSON array of objects with sorted keys so two
// query results can be compared without depending on column order in the text.
func CanonicalRows(raw []byte) ([]byte, error) {
	var rows []map[string]any
	if err := json.Unmarshal(raw, &rows); err != nil {
		return nil, err
	}
	out, err := json.Marshal(rows)
	if err != nil {
		return nil, err
	}
	return out, nil
}
