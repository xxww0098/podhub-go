package domain

import (
	"encoding/base64"
	"encoding/json"
	"net/url"
	"strconv"
	"strings"

	"github.com/xxww0098/podhub-go/internal/ozonerr/contract"
)

// Query is a catalog page. Category and TypeID nil means no filter.
// Zero is a real filter: seeded rows use 0.
type Query struct {
	Code      string
	Category  *int64
	TypeID    *int64
	Sort      string
	Limit     int
	Cursor    Cursor
	HasCursor bool
}

// Cursor is the last row of the previous page.
type Cursor struct {
	Occurrences  int64
	LastSeenUnix int64
	Source       string
	Code         string
	AttributeID  int64
	Category     int64
	TypeID       int64
}

type cursorWire struct {
	Kind string `json:"k"`
	Occ  int64  `json:"o,omitempty"`
	Seen int64  `json:"s,omitempty"`
	Src  string `json:"src"`
	Code string `json:"c"`
	Attr int64  `json:"a"`
	Cat  int64  `json:"cat"`
	Typ  int64  `json:"ty"`
}

// ParseQuery reads the list URL. sort is occurrences or last_seen.
func ParseQuery(raw string) (Query, error) {
	values, err := url.ParseQuery(raw)
	if err != nil {
		return Query{}, contract.ErrBadQuery
	}
	q := Query{Sort: "occurrences", Limit: 50}
	q.Code = strings.TrimSpace(values.Get("code"))
	if len([]rune(q.Code)) > MaxCode {
		return Query{}, contract.ErrBadQuery
	}
	if rawCat := strings.TrimSpace(values.Get("descriptionCategoryId")); rawCat != "" {
		n, err := strconv.ParseInt(rawCat, 10, 64)
		if err != nil || n < 0 {
			return Query{}, contract.ErrBadQuery
		}
		q.Category = &n
	}
	if rawType := strings.TrimSpace(values.Get("typeId")); rawType != "" {
		n, err := strconv.ParseInt(rawType, 10, 64)
		if err != nil || n < 0 {
			return Query{}, contract.ErrBadQuery
		}
		q.TypeID = &n
	}
	if sort := strings.TrimSpace(values.Get("sort")); sort != "" {
		if sort != "occurrences" && sort != "last_seen" {
			return Query{}, contract.ErrBadQuery
		}
		q.Sort = sort
	}
	if rawLimit := strings.TrimSpace(values.Get("limit")); rawLimit != "" {
		n, err := strconv.Atoi(rawLimit)
		if err != nil || n < 1 || n > 100 {
			return Query{}, contract.ErrBadQuery
		}
		q.Limit = n
	}
	if rawCursor := strings.TrimSpace(values.Get("cursor")); rawCursor != "" {
		cur, err := decodeCursor(rawCursor)
		if err != nil {
			return Query{}, err
		}
		if q.Sort == "occurrences" && cur.Kind != "o" {
			return Query{}, contract.ErrBadQuery
		}
		if q.Sort == "last_seen" && cur.Kind != "t" {
			return Query{}, contract.ErrBadQuery
		}
		q.Cursor = Cursor{
			Occurrences: cur.Occ, LastSeenUnix: cur.Seen, Source: cur.Src, Code: cur.Code,
			AttributeID: cur.Attr, Category: cur.Cat, TypeID: cur.Typ,
		}
		q.HasCursor = true
	}
	return q, nil
}

// EncodeCursor builds the next page token from the last visible row.
func EncodeCursor(sort string, row Entry) string {
	wire := cursorWire{Src: row.Source, Code: row.Code, Attr: row.AttributeID, Cat: row.DescriptionCategoryID, Typ: row.TypeID}
	if sort == "last_seen" {
		wire.Kind = "t"
		wire.Seen = row.LastSeenUnix
	} else {
		wire.Kind = "o"
		wire.Occ = row.Occurrences
	}
	raw, err := json.Marshal(wire)
	if err != nil {
		return ""
	}
	return base64.RawURLEncoding.EncodeToString(raw)
}

func decodeCursor(raw string) (cursorWire, error) {
	buf, err := base64.RawURLEncoding.DecodeString(raw)
	if err != nil {
		return cursorWire{}, contract.ErrBadQuery
	}
	var wire cursorWire
	if json.Unmarshal(buf, &wire) != nil || (wire.Kind != "o" && wire.Kind != "t") || wire.Code == "" || wire.Src == "" {
		return cursorWire{}, contract.ErrBadQuery
	}
	return wire, nil
}
