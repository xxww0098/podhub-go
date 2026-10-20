package domain

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"regexp"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"
)

const (
	summaryLimit = 80
	routeLimit   = 160
)

var (
	rePEM     = regexp.MustCompile(`(?is)-----BEGIN [A-Z0-9 ]+-----.*?-----END [A-Z0-9 ]+-----`)
	reURL     = regexp.MustCompile(`(?i)\bhttps?://\S+`)
	reBearer  = regexp.MustCompile(`(?i)bearer\s+\S+`)
	reSK      = regexp.MustCompile(`sk-[A-Za-z0-9]+`)
	reAssign  = regexp.MustCompile(`(?i)\b(?:api[_-]?key|authorization|cookie|signature|x-amz-[a-z0-9-]+)\s*[=:]\s*\S+`)
	reJSONVal = regexp.MustCompile(`(?i)"(?:offer_id|price|amount|recipient|address|phone|mobile|email|card|name|message|stack|userId|workspaceId|media|api_key|apiKey|authorization|token|password|secret|rawPayload|diagnostic)"\s*:\s*"(?:\\.|[^"\\])*"`)
	reEmail   = regexp.MustCompile(`[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}`)
	reUUID    = regexp.MustCompile(`(?i)\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b`)
	reCard    = regexp.MustCompile(`\b(?:\d[ -]*?){13,19}\b`)
	rePhone   = regexp.MustCompile(`(?:\+\d{1,3}[\s-]?)?(?:\(?\d{2,4}\)?[\s-]?)?\d{3,4}[\s-]?\d{4}`)
	reHex     = regexp.MustCompile(`\b[0-9a-fA-F]{21,}\b`)
	reDigits  = regexp.MustCompile(`\b\d{6,}\b`)
	rePoison  = regexp.MustCompile(`(?i)(sk-|bearer|api[_-]?key|signature=|x-amz-|-----begin|cookie|authorization)`)
	reLongDig = regexp.MustCompile(`\d{13,}`)
)

// Redact replaces secret, contact, and payment fragments with placeholders.
// It does not keep a copy of the input.
func Redact(raw string) string {
	s := rePEM.ReplaceAllString(raw, "{x}")
	s = reURL.ReplaceAllString(s, "{u}")
	s = reBearer.ReplaceAllString(s, "{x}")
	s = reSK.ReplaceAllString(s, "{x}")
	s = reAssign.ReplaceAllString(s, "{x}")
	s = reJSONVal.ReplaceAllString(s, `"{x}"`)
	s = reEmail.ReplaceAllString(s, "{e}")
	s = reUUID.ReplaceAllString(s, "{uuid}")
	s = reCard.ReplaceAllString(s, "{c}")
	s = rePhone.ReplaceAllString(s, "{p}")
	s = reHex.ReplaceAllString(s, "{h}")
	s = reDigits.ReplaceAllString(s, "{n}")
	return s
}

func poisoned(s string) bool {
	return strings.Contains(s, "@") || rePoison.MatchString(s) || reLongDig.MatchString(s)
}

// Observation is one inbox error read for aggregation. Payload is not stored.
type Observation struct {
	OrgID   int64
	Kind    string
	Payload string
	At      time.Time
}

// Piece is the redacted projection of one observation.
type Piece struct {
	OrgID         int64
	Fingerprint   string
	RouteTemplate string
	StatusCode    int
	Summary       string
	At            time.Time
	Drop          bool
}

// Project builds the stored fields from kind plus code, route, and status.
// Message, stack, email, phone, and the rest of the payload are not copied.
func Project(obs Observation) Piece {
	if !IsErrorClass(obs.Kind) {
		return Piece{Drop: true}
	}
	code, path, status := extractSafe(obs.Payload)
	route := routeTemplate(obs.Kind, path)
	safeCode := code
	if safeCode == "" || poisoned(safeCode) {
		safeCode = "unclassified"
	}
	summary := clip(obs.Kind+" "+safeCode+" "+route, summaryLimit)
	if poisoned(summary) || poisoned(route) || poisoned(safeCode) {
		return Piece{Drop: true}
	}
	return Piece{
		OrgID:         obs.OrgID,
		Fingerprint:   fingerprint(obs.Kind, safeCode, route, status),
		RouteTemplate: route,
		StatusCode:    status,
		Summary:       summary,
		At:            obs.At,
	}
}

func extractSafe(payload string) (code, path string, status int) {
	dec := json.NewDecoder(strings.NewReader(payload))
	dec.UseNumber()
	var fields map[string]json.RawMessage
	if err := dec.Decode(&fields); err != nil {
		return "", "", 0
	}
	code = redactToken(jsonFieldString(fields["code"]))
	path = jsonFieldString(fields["apiPath"])
	status = statusCode(fields["apiStatus"])
	if status == 0 {
		status = statusCode(fields["status"])
	}
	return code, path, status
}

func jsonFieldString(raw json.RawMessage) string {
	if len(raw) == 0 {
		return ""
	}
	var s string
	if json.Unmarshal(raw, &s) != nil {
		return ""
	}
	return s
}

func statusCode(raw json.RawMessage) int {
	if len(raw) == 0 {
		return 0
	}
	var n int
	if json.Unmarshal(raw, &n) == nil {
		return clampStatus(n)
	}
	s := strings.TrimSpace(jsonFieldString(raw))
	v, err := strconv.Atoi(s)
	if err != nil {
		return 0
	}
	return clampStatus(v)
}

func clampStatus(n int) int {
	if n >= 100 && n <= 599 {
		return n
	}
	return 0
}

func redactToken(raw string) string {
	s := strings.TrimSpace(Redact(raw))
	if poisoned(s) {
		return ""
	}
	return clip(s, 64)
}

func routeTemplate(kind, apiPath string) string {
	path := strings.TrimSpace(apiPath)
	if i := strings.IndexAny(path, "?#"); i >= 0 {
		path = path[:i]
	}
	if strings.Contains(path, "://") {
		rest := path
		if i := strings.Index(rest, "://"); i >= 0 {
			rest = rest[i+3:]
		}
		if j := strings.IndexByte(rest, '/'); j >= 0 {
			path = rest[j:]
		} else {
			path = ""
		}
	}
	fallback := "inbox/" + kind
	if path == "" || !strings.HasPrefix(path, "/") {
		return fallback
	}
	parts := strings.Split(path, "/")
	for i, part := range parts {
		if part == "" {
			continue
		}
		if idSegment(part) || poisoned(part) {
			parts[i] = "{id}"
		}
	}
	out := strings.Join(parts, "/")
	if poisoned(out) || utf8.RuneCountInString(out) > routeLimit {
		return fallback
	}
	return out
}

func idSegment(part string) bool {
	if part == "" {
		return false
	}
	digits := true
	for i := 0; i < len(part); i++ {
		if part[i] < '0' || part[i] > '9' {
			digits = false
			break
		}
	}
	if digits {
		return true
	}
	if reUUID.MatchString(part) || reHex.MatchString(part) {
		return true
	}
	return false
}

func fingerprint(kind, code, route string, status int) string {
	sum := sha256.Sum256([]byte(kind + "\n" + code + "\n" + route + "\n" + strconv.Itoa(status)))
	return hex.EncodeToString(sum[:])
}

func clip(s string, n int) string {
	if utf8.RuneCountInString(s) <= n {
		return s
	}
	runes := []rune(s)
	return string(runes[:n])
}

// DigestRow is one stored aggregate. Platform rows have Platform set and OrgID 0.
type DigestRow struct {
	OrgID         int64
	Platform      bool
	Fingerprint   string
	RouteTemplate string
	StatusCode    int
	Count         int64
	FirstAt       time.Time
	LastAt        time.Time
	Summary       string
	WindowStart   time.Time
}

// Aggregate groups error-class observations in [start, end).
// Dropped counts projections that still looked sensitive. Billing kinds and
// rows outside the window are ignored. OrgID <= 0 is not attributed.
func Aggregate(obs []Observation, start, end time.Time) (rows []DigestRow, dropped int) {
	type key struct {
		org    int64
		fp     string
		route  string
		status int
	}
	type acc struct {
		row DigestRow
	}
	tenant := map[key]*acc{}
	platform := map[key]*acc{}
	for _, item := range obs {
		if item.At.Before(start) || !item.At.Before(end) {
			continue
		}
		if !IsErrorClass(item.Kind) {
			continue
		}
		piece := Project(item)
		if piece.Drop {
			dropped++
			continue
		}
		if item.OrgID <= 0 {
			dropped++
			continue
		}
		add := func(dst map[key]*acc, org int64, platformRow bool) {
			k := key{org: org, fp: piece.Fingerprint, route: piece.RouteTemplate, status: piece.StatusCode}
			got := dst[k]
			if got == nil {
				got = &acc{row: DigestRow{
					OrgID: org, Platform: platformRow,
					Fingerprint: piece.Fingerprint, RouteTemplate: piece.RouteTemplate,
					StatusCode: piece.StatusCode, Summary: piece.Summary, WindowStart: start,
					FirstAt: piece.At, LastAt: piece.At, Count: 0,
				}}
				dst[k] = got
			}
			got.row.Count++
			if piece.At.Before(got.row.FirstAt) {
				got.row.FirstAt = piece.At
			}
			if piece.At.After(got.row.LastAt) {
				got.row.LastAt = piece.At
			}
		}
		add(tenant, item.OrgID, false)
		add(platform, 0, true)
	}
	for _, item := range tenant {
		rows = append(rows, item.row)
	}
	for _, item := range platform {
		rows = append(rows, item.row)
	}
	return rows, dropped
}
