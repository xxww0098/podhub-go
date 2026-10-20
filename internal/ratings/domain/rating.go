// Package domain is the pure rating snapshot rules. It does not dial, and
// it does not read the environment.
package domain

import (
	"bytes"
	"encoding/json"
	"math/big"
	"strings"
	"time"
	"unicode/utf8"
)

const (
	// DefaultSyncInterval is the per-store gap when the interval is unset.
	DefaultSyncInterval = 6 * time.Hour
	// DefaultRetention is how long a history row is kept when unset.
	DefaultRetention = 90 * 24 * time.Hour
	// DefaultTick is the scheduler slice used to stagger stores.
	DefaultTick = 15 * time.Minute

	// DirNoData is the direction when status is UNKNOWN or the current
	// value is null. Callers must not present that row as zero.
	DirNoData = "no_data"
	// DirFlat is a numeric value with no earlier number, or an equal one.
	DirFlat = "flat"
	// DirUp is a current number greater than the previous history number.
	DirUp = "up"
	// DirDown is a current number smaller than the previous history number.
	DirDown = "down"

	// StatusUnknown is the only status the default rank map names.
	// Official docs for the other status strings were not opened.
	StatusUnknown = "UNKNOWN"
)

// Rating is one parsed Seller rating. Nil currents are SQL NULL.
// Current and Past are canonical numeric text, never a formatted zero
// standing in for null.
type Rating struct {
	Key       string
	Name      string
	ValueType string
	Status    string
	Current   *string
	Past      *string
}

// DefaultRanks names only UNKNOWN, at severity 0. A transition notifies
// only when both statuses are in the map and the new severity is greater.
// With only this entry, no transition notifies.
func DefaultRanks() map[string]int {
	return map[string]int{StatusUnknown: 0}
}

// SecretLike reports whether s contains a credential-shaped fragment.
// Callers drop the field instead of storing or logging it.
func SecretLike(s string) bool {
	l := strings.ToLower(s)
	for _, p := range []string{
		"fixture-api-key", "fixture-client", "api-key", "api_key", "apikey",
		"bearer ", "sk-", "client-id", "client_id", "signature=", "x-amz-",
	} {
		if strings.Contains(l, p) {
			return true
		}
	}
	return false
}

// Parse reads a Seller info body. A missing or null ratings list is an
// empty success. An item without a rating key is skipped. Null, missing,
// and non-numeric values become nil. Unknown status and value_type strings
// are kept. A secret-shaped field drops that item. The last duplicate key
// wins.
func Parse(body []byte) ([]Rating, int, error) {
	body = bytes.TrimSpace(body)
	if len(body) == 0 {
		return nil, 0, nil
	}
	dec := json.NewDecoder(bytes.NewReader(body))
	dec.UseNumber()
	var root any
	if err := dec.Decode(&root); err != nil {
		return nil, 0, err
	}
	var list []any
	switch v := root.(type) {
	case []any:
		list = v
	case map[string]any:
		raw, ok := v["ratings"]
		if !ok || raw == nil {
			return nil, 0, nil
		}
		items, ok := raw.([]any)
		if !ok {
			return nil, 0, errRatings
		}
		list = items
	default:
		return nil, 0, errRatings
	}
	out := make([]Rating, 0, len(list))
	index := map[string]int{}
	dropped := 0
	for _, item := range list {
		obj, ok := item.(map[string]any)
		if !ok {
			dropped++
			continue
		}
		row, ok := one(obj)
		if !ok {
			dropped++
			continue
		}
		if i, seen := index[row.Key]; seen {
			out[i] = row
			continue
		}
		index[row.Key] = len(out)
		out = append(out, row)
	}
	return out, dropped, nil
}

var errRatings = errType("ratings")

type errType string

func (e errType) Error() string { return string(e) }

func one(obj map[string]any) (Rating, bool) {
	key, ok := str(obj["rating"])
	if !ok || key == "" || utf8.RuneCountInString(key) > 128 {
		return Rating{}, false
	}
	name, _ := str(obj["name"])
	valueType, _ := str(obj["value_type"])
	status, _ := str(obj["status"])
	if utf8.RuneCountInString(name) > 400 || utf8.RuneCountInString(valueType) > 64 || utf8.RuneCountInString(status) > 64 {
		return Rating{}, false
	}
	if SecretLike(key) || SecretLike(name) || SecretLike(valueType) || SecretLike(status) {
		return Rating{}, false
	}
	return Rating{
		Key: key, Name: name, ValueType: valueType, Status: status,
		Current: num(obj["current_value"]), Past: num(obj["past_value"]),
	}, true
}

func str(v any) (string, bool) {
	if v == nil {
		return "", true
	}
	s, ok := v.(string)
	return s, ok
}

func num(v any) *string {
	if v == nil {
		return nil
	}
	switch n := v.(type) {
	case json.Number:
		if _, ok := new(big.Rat).SetString(n.String()); !ok {
			return nil
		}
		s := n.String()
		return &s
	case string:
		s := strings.TrimSpace(n)
		if s == "" {
			return nil
		}
		if _, ok := new(big.Rat).SetString(s); !ok {
			return nil
		}
		return &s
	default:
		return nil
	}
}

// Changed reports whether status or current_value differs from the stored
// snapshot. A missing previous row is a change. Equal numerics are not a
// change, including null with null. past_value and the labels do not count.
func Changed(existed bool, oldStatus, newStatus string, oldCur, newCur *string) bool {
	if !existed {
		return true
	}
	if oldStatus != newStatus {
		return true
	}
	return !sameNumber(oldCur, newCur)
}

func sameNumber(a, b *string) bool {
	if a == nil || *a == "" {
		return b == nil || *b == ""
	}
	if b == nil || *b == "" {
		return false
	}
	ra, rb := rat(*a), rat(*b)
	if ra == nil || rb == nil {
		return *a == *b
	}
	return ra.Cmp(rb) == 0
}

func rat(s string) *big.Rat {
	r, ok := new(big.Rat).SetString(strings.TrimSpace(s))
	if !ok {
		return nil
	}
	return r
}

// Worsened is true only when a previous row exists, both statuses are in
// ranks, and the new severity is strictly greater. An unmapped status does
// not notify. The default map therefore never notifies.
func Worsened(ranks map[string]int, existed bool, from, to string) bool {
	if !existed || ranks == nil || from == to {
		return false
	}
	a, oka := ranks[from]
	b, okb := ranks[to]
	if !oka || !okb {
		return false
	}
	return b > a
}

// Present decides the read-model marker. UNKNOWN or a null current value
// is no_data, and the numbers must be omitted rather than shown as zero.
func Present(status string, current, past, previous *string) (noData bool, currentOut, pastOut, direction string) {
	if status == StatusUnknown || current == nil || *current == "" {
		return true, "", "", DirNoData
	}
	direction = DirFlat
	if previous != nil && *previous != "" {
		c, p := rat(*current), rat(*previous)
		if c != nil && p != nil {
			switch c.Cmp(p) {
			case 1:
				direction = DirUp
			case -1:
				direction = DirDown
			}
		}
	}
	pastShown := ""
	if past != nil {
		pastShown = *past
	}
	return false, *current, pastShown, direction
}

// Tick is the stagger slice. A short interval uses itself as one slice.
func Tick(interval time.Duration) time.Duration {
	if interval <= 0 {
		interval = DefaultSyncInterval
	}
	if interval < DefaultTick {
		return interval
	}
	return DefaultTick
}

// Slots is how many stagger buckets fit in one sync interval.
func Slots(interval, tick time.Duration) int {
	if interval <= 0 {
		interval = DefaultSyncInterval
	}
	if tick <= 0 {
		tick = Tick(interval)
	}
	n := int(interval / tick)
	if n < 1 {
		return 1
	}
	return n
}

// TimeBucket is the bucket a clock instant belongs to.
func TimeBucket(now time.Time, tick time.Duration, slots int) int {
	if slots <= 1 || tick < time.Second {
		return 0
	}
	return int((now.Unix() / int64(tick/time.Second)) % int64(slots))
}

// StoreBucket spreads stores by organization_stores.id. It matches
// MOD(id, slots) in the claim query.
func StoreBucket(storeRowID int64, slots int) int {
	if slots <= 1 {
		return 0
	}
	m := storeRowID % int64(slots)
	if m < 0 {
		m = -m
	}
	return int(m)
}
