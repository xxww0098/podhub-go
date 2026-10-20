package domain

import (
	"encoding/json"
	"net"
	"strings"
	"sync"
	"time"
	"unicode"
	"unicode/utf8"
)

// ClientLog is one accepted client_listing_logs row. Nil pointers are SQL NULL.
type ClientLog struct {
	ClientID     string
	SessionID    string
	Version      string
	LoggedAt     time.Time
	Level        string
	Module       string
	Event        string
	DurationMS   *int32
	BatchID      *string
	RowID        *string
	OfferID      *string
	IntentID     *string
	JobID        *string
	PsdID        *string
	ErrorCode    *string
	ErrorMessage *string
	Fields       string
}

// AcceptClientRecord drops one record (returns false) or returns the stored row.
// now is the server clock. ipPrefix is appended when non-empty.
func AcceptClientRecord(raw json.RawMessage, now time.Time, ipPrefix string) (ClientLog, bool) {
	dec := json.NewDecoder(strings.NewReader(string(raw)))
	dec.DisallowUnknownFields()
	var rec clientWire
	if err := dec.Decode(&rec); err != nil {
		return ClientLog{}, false
	}
	id, ok := uuid36(rec.ID)
	if !ok {
		return ClientLog{}, false
	}
	session, ok := uuid36(rec.SessionID)
	if !ok {
		return ClientLog{}, false
	}
	version := strings.TrimSpace(rec.Version)
	if !clientToken(version, 1, 32) {
		return ClientLog{}, false
	}
	logged, err := parseTime(strings.TrimSpace(rec.TS))
	if err != nil {
		return ClientLog{}, false
	}
	if logged.After(now.Add(5*time.Minute)) || logged.Add(7*24*time.Hour).Before(now) {
		return ClientLog{}, false
	}
	switch rec.Level {
	case "debug", "info", "warn", "error":
	default:
		return ClientLog{}, false
	}
	if !clientToken(strings.TrimSpace(rec.Module), 1, 64) || !clientToken(strings.TrimSpace(rec.Event), 1, 64) {
		return ClientLog{}, false
	}
	var duration *int32
	if rec.DurationMS != nil {
		if *rec.DurationMS < 0 || *rec.DurationMS > 86400000 {
			return ClientLog{}, false
		}
		v := int32(*rec.DurationMS)
		duration = &v
	}
	fields, ok := filterFields(rec.Fields, ipPrefix)
	if !ok {
		return ClientLog{}, false
	}
	return ClientLog{
		ClientID: id, SessionID: session, Version: version, LoggedAt: logged,
		Level: rec.Level, Module: strings.TrimSpace(rec.Module), Event: strings.TrimSpace(rec.Event),
		DurationMS:   duration,
		BatchID:      optionalUUID(rec.BatchID),
		RowID:        optionalUUID(rec.RowID),
		OfferID:      offerID(rec.OfferID),
		IntentID:     optionalUUID(rec.IntentID),
		JobID:        optionalUUID(rec.JobID),
		PsdID:        psdID(rec.PsdID),
		ErrorCode:    errorCode(rec.ErrorCode),
		ErrorMessage: sanitizeMessage(rec.ErrorMessage),
		Fields:       fields,
	}, true
}

type clientWire struct {
	ID           string          `json:"id"`
	TS           string          `json:"ts"`
	Level        string          `json:"level"`
	Module       string          `json:"module"`
	Event        string          `json:"event"`
	SessionID    string          `json:"sessionId"`
	Version      string          `json:"version"`
	DurationMS   *int64          `json:"durationMs"`
	BatchID      *string         `json:"batchId"`
	RowID        *string         `json:"rowId"`
	OfferID      *string         `json:"offerId"`
	IntentID     *string         `json:"intentId"`
	JobID        *string         `json:"jobId"`
	PsdID        *string         `json:"psdId"`
	ErrorCode    *string         `json:"errorCode"`
	ErrorMessage *string         `json:"errorMessage"`
	Fields       json.RawMessage `json:"fields"`
}

func uuid36(s string) (string, bool) {
	s = strings.TrimSpace(s)
	if len(s) != 36 || s[8] != '-' || s[13] != '-' || s[18] != '-' || s[23] != '-' {
		return "", false
	}
	for i := 0; i < len(s); i++ {
		if i == 8 || i == 13 || i == 18 || i == 23 {
			continue
		}
		if !asciiHex(s[i : i+1]) {
			return "", false
		}
	}
	return strings.ToLower(s), true
}

func clientToken(s string, min, max int) bool {
	if len(s) < min || len(s) > max {
		return false
	}
	for i := 0; i < len(s); i++ {
		c := s[i]
		switch {
		case c >= 'A' && c <= 'Z', c >= 'a' && c <= 'z', c >= '0' && c <= '9':
		case c == '_' || c == '.' || c == ':' || c == '+' || c == '-':
		default:
			return false
		}
	}
	return true
}

func optionalUUID(raw *string) *string {
	if raw == nil {
		return nil
	}
	id, ok := uuid36(*raw)
	if !ok {
		return nil
	}
	return &id
}

func offerID(raw *string) *string {
	if raw == nil {
		return nil
	}
	s := strings.TrimSpace(*raw)
	if utf8.RuneCountInString(s) > 128 || s == "" {
		return nil
	}
	if strings.Contains(s, "://") {
		return nil
	}
	for _, r := range s {
		if r < 0x20 || unicode.IsSpace(r) || strings.ContainsRune("?&#\\/", r) {
			return nil
		}
	}
	low := strings.ToLower(s)
	for _, word := range []string{"token", "secret", "password"} {
		if strings.Contains(low, word) {
			return nil
		}
	}
	return &s
}

func psdID(raw *string) *string {
	if raw == nil {
		return nil
	}
	s := strings.TrimSpace(*raw)
	s = strings.TrimPrefix(s, "sha256:")
	if len(s) != 64 || !asciiHex(s) {
		return nil
	}
	out := "sha256:" + strings.ToLower(s)
	return &out
}

func errorCode(raw *string) *string {
	if raw == nil {
		return nil
	}
	s := strings.TrimSpace(*raw)
	if !clientToken(s, 1, 64) {
		return nil
	}
	return &s
}

func sanitizeMessage(raw *string) *string {
	if raw == nil {
		return nil
	}
	s := strings.NewReplacer("\n", " ", "\r", " ", "\t", " ").Replace(*raw)
	s = strings.Join(strings.Fields(s), " ")
	prefixes := []string{
		"https://", "http://", "data:", "blob:", "bearer ",
		"token=", "token:", "password=", "password:", "secret=", "secret:",
		"api_key=", "api-key=", "apikey=", "signature=", "x-amz-",
	}
	var b strings.Builder
	for len(s) > 0 {
		low := strings.ToLower(s)
		if strings.HasPrefix(low, "bearer ") {
			s = s[len("bearer "):]
			i := 0
			for i < len(s) && s[i] != ' ' {
				i++
			}
			s = s[i:]
			b.WriteString("[omitted]")
			continue
		}
		hit := ""
		for _, p := range prefixes {
			if p == "bearer " {
				continue
			}
			if strings.HasPrefix(low, p) && len(p) > len(hit) {
				hit = p
			}
		}
		if hit != "" {
			s = s[len(hit):]
			i := 0
			for i < len(s) && s[i] != ' ' {
				i++
			}
			s = s[i:]
			b.WriteString("[omitted]")
			continue
		}
		r, size := utf8.DecodeRuneInString(s)
		b.WriteRune(r)
		s = s[size:]
	}
	out := b.String()
	runes := []rune(out)
	if len(runes) > 240 {
		out = string(runes[:240])
	}
	if strings.TrimSpace(out) == "" {
		return nil
	}
	return &out
}

func filterFields(raw json.RawMessage, ipPrefix string) (string, bool) {
	if len(bytesTrim(raw)) == 0 {
		raw = json.RawMessage(`{}`)
	}
	fields, err := parseObject(string(raw))
	if err != nil {
		return "", false
	}
	allow := map[string]bool{
		"slices": true, "bytes": true, "waitedMs": true, "completeMs": true,
		"concurrency": true, "effectiveType": true, "encodeMs": true, "status": true,
		"verb": true, "outcome": true, "presignMs": true, "putMs": true, "applied": true,
		"revision": true, "rows": true, "attempt": true, "worker": true, "stage": true,
		"refusal": true,
	}
	if key := firstUnknown(fields, allow); key != "" {
		return "", false
	}
	m := fieldMap(fields)
	o := ordered{vals: map[string]json.RawMessage{}}
	putInt := func(key string, pred func(int64) bool) {
		raw, ok := m[key]
		if !ok {
			return
		}
		n, ok := jsonInt(raw)
		if !ok || !pred(n) {
			return
		}
		o.keys = append(o.keys, key)
		o.vals[key] = rawInt(n)
	}
	putInt("slices", func(n int64) bool { return n >= 0 })
	putInt("bytes", func(n int64) bool { return n <= 2_000_000_000 })
	putInt("waitedMs", func(n int64) bool { return n >= 0 })
	putInt("presignMs", func(n int64) bool { return n >= 0 })
	putInt("putMs", func(n int64) bool { return n >= 0 })
	putInt("completeMs", func(n int64) bool { return n >= 0 })
	putInt("concurrency", func(n int64) bool { return n >= 1 && n <= 64 })
	putInt("encodeMs", func(n int64) bool { return n >= 0 })
	putInt("status", func(n int64) bool { return n >= 100 && n <= 599 })
	if raw, ok := m["verb"]; ok {
		if s, sok := jsonString(raw); sok && clientToken(s, 1, 32) {
			o.keys = append(o.keys, "verb")
			o.vals["verb"] = rawString(s)
		}
	}
	if raw, ok := m["effectiveType"]; ok {
		if s, sok := jsonString(raw); sok && effectiveType(s) && clientToken(s, 1, 16) {
			o.keys = append(o.keys, "effectiveType")
			o.vals["effectiveType"] = rawString(s)
		}
	}
	if raw, ok := m["outcome"]; ok {
		if s, sok := jsonString(raw); sok && clientToken(s, 1, 32) {
			o.keys = append(o.keys, "outcome")
			o.vals["outcome"] = rawString(s)
		}
	}
	if raw, ok := m["applied"]; ok && string(raw) == "true" {
		o.keys = append(o.keys, "applied")
		o.vals["applied"] = rawBool(true)
	}
	putInt("revision", func(n int64) bool { return n >= 0 && n <= 1_000_000_000 })
	putInt("rows", func(n int64) bool { return n >= 0 })
	putInt("attempt", func(n int64) bool { return n >= 0 && n <= 100 })
	if raw, ok := m["worker"]; ok {
		if s, sok := jsonString(raw); sok && len(s) == 8 && asciiHex(s) {
			o.keys = append(o.keys, "worker")
			o.vals["worker"] = rawString(strings.ToLower(s))
		}
	}
	if raw, ok := m["stage"]; ok {
		if s, sok := jsonString(raw); sok && clientToken(s, 1, 32) {
			o.keys = append(o.keys, "stage")
			o.vals["stage"] = rawString(s)
		}
	}
	if raw, ok := m["refusal"]; ok {
		if s, sok := jsonString(raw); sok && clientToken(s, 1, 64) && s != "operation_failed" && s != "-" {
			o.keys = append(o.keys, "refusal")
			o.vals["refusal"] = rawString(s)
		}
	}
	if ipPrefix != "" {
		o.keys = append(o.keys, "ipPrefix")
		o.vals["ipPrefix"] = rawString(ipPrefix)
	}
	text, err := compactJSON(o)
	if err != nil {
		return "", false
	}
	return text, true
}

func bytesTrim(raw json.RawMessage) string {
	return strings.TrimSpace(string(raw))
}

func effectiveType(s string) bool {
	switch s {
	case "slow-2g", "2g", "3g", "4g":
		return true
	default:
		return false
	}
}

// IPPrefix reads the last usable address from X-Forwarded-For values.
func IPPrefix(values []string) string {
	var last string
	for _, header := range values {
		for _, part := range strings.Split(header, ",") {
			part = strings.TrimSpace(part)
			if part == "" {
				continue
			}
			if prefix, ok := prefixOf(part); ok {
				last = prefix
			}
		}
	}
	return last
}

func prefixOf(raw string) (string, bool) {
	host := raw
	if strings.HasPrefix(host, "[") {
		if i := strings.LastIndex(host, "]"); i > 0 {
			host = host[1:i]
		}
	} else if h, _, err := net.SplitHostPort(host); err == nil {
		host = h
	}
	ip := net.ParseIP(host)
	if ip == nil {
		return "", false
	}
	if ip4 := ip.To4(); ip4 != nil {
		if !usable4(ip4) {
			return "", false
		}
		return fmtIP4(ip4), true
	}
	if !usable6(ip) {
		return "", false
	}
	b := ip.To16()
	return sprintfHex(b[0], b[1]) + ":" + sprintfHex(b[2], b[3]) + ":" + sprintfHex(b[4], b[5]) + "::/48", true
}

func sprintfHex(a, b byte) string {
	const hexdigits = "0123456789abcdef"
	return string([]byte{hexdigits[a>>4], hexdigits[a&0xf], hexdigits[b>>4], hexdigits[b&0xf]})
}

func fmtIP4(ip net.IP) string {
	return itoa(int(ip[0])) + "." + itoa(int(ip[1])) + "." + itoa(int(ip[2])) + ".0/24"
}

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	var b [4]byte
	i := len(b)
	for n > 0 {
		i--
		b[i] = byte('0' + n%10)
		n /= 10
	}
	return string(b[i:])
}

func usable4(ip net.IP) bool {
	if ip.IsLoopback() || ip.IsUnspecified() || ip.IsLinkLocalUnicast() || ip.IsLinkLocalMulticast() || ip.IsMulticast() {
		return false
	}
	if ip[0] == 255 && ip[1] == 255 && ip[2] == 255 && ip[3] == 255 {
		return false
	}
	return true
}

func usable6(ip net.IP) bool {
	return !ip.IsLoopback() && !ip.IsUnspecified() && !ip.IsLinkLocalUnicast() && !ip.IsLinkLocalMulticast() && !ip.IsMulticast()
}

// LogWindow is the per-process, per-user 30 batches / 60 seconds gate.
type LogWindow struct {
	mu sync.Mutex
	m  map[int64]logSlot
}

type logSlot struct {
	start int64
	count int
}

// Allow reports whether this batch consumes a slot. now is unix seconds.
func (w *LogWindow) Allow(userID, now int64) bool {
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.m == nil {
		w.m = map[int64]logSlot{}
	}
	if len(w.m) > 10000 {
		for id, slot := range w.m {
			if slot.start <= now-ClientListingLogWindowSeconds {
				delete(w.m, id)
			}
		}
	}
	slot := w.m[userID]
	if slot.start == 0 || now-slot.start >= ClientListingLogWindowSeconds {
		w.m[userID] = logSlot{start: now, count: 1}
		return true
	}
	if slot.count >= ClientListingLogWindow {
		return false
	}
	slot.count++
	w.m[userID] = slot
	return true
}

// DecodeClientLogs parses the request. The caller maps errors to 请求格式无效.
func DecodeClientLogs(body []byte) ([]json.RawMessage, error) {
	dec := json.NewDecoder(strings.NewReader(string(body)))
	dec.DisallowUnknownFields()
	var raw struct {
		Records []json.RawMessage `json:"records"`
	}
	if err := dec.Decode(&raw); err != nil {
		return nil, err
	}
	if raw.Records == nil {
		return nil, errJSON
	}
	for _, rec := range raw.Records {
		item := json.NewDecoder(strings.NewReader(string(rec)))
		item.DisallowUnknownFields()
		var wire clientWire
		if err := item.Decode(&wire); err != nil {
			return nil, err
		}
		if len(bytesTrim(wire.Fields)) > 0 {
			fields, err := parseObject(string(wire.Fields))
			if err != nil {
				return nil, errJSON
			}
			allow := map[string]bool{
				"slices": true, "bytes": true, "waitedMs": true, "completeMs": true,
				"concurrency": true, "effectiveType": true, "encodeMs": true, "status": true,
				"verb": true, "outcome": true, "presignMs": true, "putMs": true, "applied": true,
				"revision": true, "rows": true, "attempt": true, "worker": true, "stage": true,
				"refusal": true,
			}
			if firstUnknown(fields, allow) != "" {
				return nil, errJSON
			}
		}
	}
	return raw.Records, nil
}
