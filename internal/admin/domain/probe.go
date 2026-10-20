package domain

import (
	"encoding/json"
	"net"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"unicode/utf8"
)

// ModelOption is one catalogue entry.
type ModelOption struct {
	ID      string
	OwnedBy string
}

// ModelsEndpoint is the catalogue URL for one wire format.
func ModelsEndpoint(base, format string) (string, bool) {
	base = strings.TrimRight(strings.TrimSpace(base), "/")
	if base == "" {
		return "", false
	}
	if format == "anthropic_messages" {
		base = strings.TrimSuffix(base, "/v1")
		return base + "/v1/models", true
	}
	return base + "/models", true
}

// ParseModels reads a catalogue body. A JSON object without data is an empty
// list. Invalid JSON is refused.
func ParseModels(body []byte) ([]ModelOption, bool) {
	var raw map[string]json.RawMessage
	if err := json.Unmarshal(body, &raw); err != nil {
		return nil, false
	}
	data, ok := raw["data"]
	if !ok {
		return []ModelOption{}, true
	}
	var rows []map[string]any
	if err := json.Unmarshal(data, &rows); err != nil {
		return []ModelOption{}, true
	}
	var out []ModelOption
	for _, row := range rows {
		id, _ := row["id"].(string)
		id = strings.TrimSpace(id)
		if id == "" {
			continue
		}
		owned, _ := row["owned_by"].(string)
		out = append(out, ModelOption{ID: id, OwnedBy: owned})
	}
	sort.SliceStable(out, func(i, j int) bool { return out[i].ID < out[j].ID })
	dedup := out[:0]
	var prev string
	for i, row := range out {
		if i > 0 && row.ID == prev {
			continue
		}
		prev = row.ID
		dedup = append(dedup, row)
	}
	if dedup == nil {
		dedup = []ModelOption{}
	}
	return dedup, true
}

// ModelPresent compares trimmed catalogue ids to the requested model.
func ModelPresent(models []ModelOption, want string) bool {
	for _, m := range models {
		if m.ID == want {
			return true
		}
	}
	return false
}

// ConfiguredURL accepts an https URL, or loopback http when allowed.
// It does not resolve DNS. The returned base has one trailing slash removed.
func ConfiguredURL(raw string, loopback bool) (string, bool) {
	raw = strings.TrimRight(strings.TrimSpace(raw), "/")
	if raw == "" || len(raw) > 512 {
		return "", false
	}
	u, err := url.Parse(raw)
	if err != nil || u.User != nil || u.RawQuery != "" || u.Fragment != "" || u.Host == "" {
		return "", false
	}
	host := strings.Trim(strings.ToLower(u.Hostname()), ".")
	switch u.Scheme {
	case "https":
		return raw, true
	case "http":
		if loopback && isLoopbackHost(host) {
			return raw, true
		}
	}
	return "", false
}

func isLoopbackHost(host string) bool {
	switch host {
	case "localhost", "127.0.0.1", "::1":
		return true
	default:
		return false
	}
}

// PublicEndpoint reports why a probe URL is refused. Empty means the shape
// is acceptable before DNS. Literal IPs are checked here.
func PublicEndpoint(raw string, loopback bool) string {
	u, err := url.Parse(strings.TrimSpace(raw))
	if err != nil || u.Host == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" {
		return "接口地址不是允许的公网 https 端点"
	}
	host := strings.Trim(strings.ToLower(u.Hostname()), ".")
	if host == "" || blockedName(host) {
		return "接口地址不是允许的公网 https 端点"
	}
	ip := net.ParseIP(host)
	loop := isLoopbackHost(host) || (ip != nil && ip.IsLoopback())
	switch u.Scheme {
	case "https":
	case "http":
		if !(loopback && loop) {
			return "接口地址不是允许的公网 https 端点"
		}
	default:
		return "接口地址不是允许的公网 https 端点"
	}
	if ip != nil && !ipAllowed(ip, loopback && loop) {
		return "接口地址不是允许的公网 https 端点"
	}
	return ""
}

func blockedName(host string) bool {
	switch {
	case host == "localhost" || strings.HasSuffix(host, ".localhost"):
		return true
	case strings.HasSuffix(host, ".local") || strings.HasSuffix(host, ".internal") || strings.HasSuffix(host, ".home.arpa"):
		return true
	default:
		return false
	}
}

func ipAllowed(ip net.IP, loopbackOK bool) bool {
	if ip.IsLoopback() {
		return loopbackOK
	}
	if ip.IsPrivate() || ip.IsLinkLocalUnicast() || ip.IsLinkLocalMulticast() || ip.IsMulticast() || ip.IsUnspecified() {
		return false
	}
	if v4 := ip.To4(); v4 != nil {
		if v4[0] == 100 && v4[1]&0xc0 == 64 {
			return false
		}
		if v4[0] == 198 && (v4[1] == 18 || v4[1] == 19) {
			return false
		}
		if v4[0] >= 240 {
			return false
		}
		if v4[0] == 192 && v4[1] == 0 && v4[2] == 2 {
			return false
		}
		if v4[0] == 198 && v4[1] == 51 && v4[2] == 100 {
			return false
		}
		if v4[0] == 203 && v4[1] == 0 && v4[2] == 113 {
			return false
		}
	}
	return true
}

// ClientErrorSummary redacts the key and caps the text at 512 scalars.
func ClientErrorSummary(status int, body, apiKey string) string {
	text := summarizeUpstream(status, body)
	if apiKey != "" {
		text = strings.ReplaceAll(text, apiKey, "[REDACTED]")
	}
	text = strings.Join(strings.Fields(text), " ")
	if utf8.RuneCountInString(text) > 512 {
		r := []rune(text)
		text = string(r[:512]) + "…"
	}
	return text
}

func summarizeUpstream(status int, body string) string {
	var raw any
	if json.Unmarshal([]byte(body), &raw) != nil {
		return "AI 上游返回 HTTP " + itoa(status) + "，但未返回可安全展示的错误说明"
	}
	code, message := upstreamFields(raw)
	if code == "" && message == "" {
		return "AI 上游返回 HTTP " + itoa(status) + "，但未返回可安全展示的错误说明"
	}
	var b strings.Builder
	b.WriteString("AI 上游返回 HTTP ")
	b.WriteString(itoa(status))
	b.WriteString("：")
	if code != "" {
		b.WriteString("code=")
		b.WriteString(code)
	}
	if message != "" {
		if code != "" {
			b.WriteString("；")
		}
		b.WriteString("message=")
		b.WriteString(message)
	}
	return b.String()
}

func upstreamFields(raw any) (code, message string) {
	obj, _ := raw.(map[string]any)
	if obj == nil {
		return "", ""
	}
	code = fieldString(obj, "code", "error_code", "type")
	message = fieldString(obj, "message", "msg", "error_description", "detail")
	if message == "" {
		if s, ok := obj["error"].(string); ok {
			message = s
		}
	}
	if nested, ok := obj["error"].(map[string]any); ok {
		if code == "" {
			code = fieldString(nested, "code", "error_code", "type")
		}
		if message == "" {
			message = fieldString(nested, "message", "msg", "error_description", "detail")
		}
	}
	return code, message
}

func fieldString(obj map[string]any, keys ...string) string {
	for _, key := range keys {
		switch v := obj[key].(type) {
		case string:
			if v != "" {
				return v
			}
		case float64:
			return strconv.FormatFloat(v, 'f', -1, 64)
		case json.Number:
			return v.String()
		}
	}
	return ""
}

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	neg := n < 0
	if neg {
		n = -n
	}
	var buf [20]byte
	i := len(buf)
	for n > 0 {
		i--
		buf[i] = byte('0' + n%10)
		n /= 10
	}
	if neg {
		i--
		buf[i] = '-'
	}
	return string(buf[i:])
}
