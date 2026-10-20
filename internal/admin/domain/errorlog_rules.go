package domain

import (
	"encoding/json"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"
)

var errorSources = map[string]bool{
	"error_feedback": true, "workbench": true, "host_uncaught": true, "host_panic": true,
	"host_command": true, "renderer_uncaught": true, "renderer_rejection": true, "child_process_gone": true,
}

// ErrorQuery is the admin error-log filter after validation.
type ErrorQuery struct {
	GroupBy  string
	Page     int32
	PageSize int32
	Q        string
	Source   string
	Since    string
	Platform string
	Stage    string
	Code     string
}

// ValidateErrorQuery applies the handler checks. Blank optional filters stay blank.
func ValidateErrorQuery(raw map[string]string) (ErrorQuery, *Fault) {
	out := ErrorQuery{Page: 1, PageSize: 25}
	if value := strings.TrimSpace(raw["page"]); value != "" {
		n, err := strconv.ParseInt(value, 10, 32)
		if err != nil || n < 1 {
			return ErrorQuery{}, Validation("VALIDATION", "page 必须是正整数")
		}
		out.Page = int32(n)
	}
	if value := strings.TrimSpace(raw["page_size"]); value != "" {
		n, err := strconv.ParseInt(value, 10, 32)
		if err != nil || n < 1 {
			return ErrorQuery{}, Validation("VALIDATION", "page_size 必须是正整数")
		}
		if n > 100 {
			return ErrorQuery{}, Validation("VALIDATION", "page_size 不能超过 100")
		}
		out.PageSize = int32(n)
	}
	if value := raw["q"]; value != "" {
		if utf8.RuneCountInString(value) > 200 {
			return ErrorQuery{}, Validation("VALIDATION", "筛选关键词不能超过 200 个字符")
		}
		out.Q = value
	}
	if value := strings.TrimSpace(raw["source"]); value != "" {
		if !errorSources[value] {
			return ErrorQuery{}, Validation("VALIDATION", "错误来源无效")
		}
		out.Source = value
	}
	if value := strings.TrimSpace(raw["since"]); value != "" {
		parsed, err := time.Parse(time.RFC3339, value)
		if err != nil {
			return ErrorQuery{}, Validation("VALIDATION", "筛选时间格式无效")
		}
		out.Since = parsed.UTC().Format(time.RFC3339Nano)
	}
	for _, key := range []string{"platform", "stage", "code"} {
		value := raw[key]
		if strings.TrimSpace(value) == "" {
			continue
		}
		if !diagnosticToken(value) {
			return ErrorQuery{}, Validation("VALIDATION", "诊断筛选值无效")
		}
		switch key {
		case "platform":
			out.Platform = value
		case "stage":
			out.Stage = value
		case "code":
			out.Code = value
		}
	}
	if value := strings.TrimSpace(raw["group_by"]); value != "" {
		if value != "platform_stage_code" {
			return ErrorQuery{}, Validation("VALIDATION", "日志分组方式无效")
		}
		out.GroupBy = value
	}
	return out, nil
}

func diagnosticToken(value string) bool {
	if value == "" || len(value) > 128 {
		return false
	}
	for i := 0; i < len(value); i++ {
		c := value[i]
		switch {
		case c >= 'a' && c <= 'z', c >= 'A' && c <= 'Z', c >= '0' && c <= '9', c == '_', c == '-', c == '.', c == ':':
		default:
			return false
		}
	}
	return true
}

// TotalPages is at least 1. Page is clamped to the last page.
func TotalPages(total int64, pageSize int32) (pages int32, page int32) {
	if total <= 0 {
		return 1, 1
	}
	size := int64(pageSize)
	pages64 := (total + size - 1) / size
	if pages64 > int64(^uint32(0)>>1) {
		return int32(^uint32(0) >> 1), 1
	}
	return int32(pages64), 0
}

func ClampPage(page, pages int32) int32 {
	if page > pages {
		return pages
	}
	if page < 1 {
		return 1
	}
	return page
}

// SeverityLabel uses the payload severity, else the code prefix.
func SeverityLabel(severity, code string) string {
	if severity != "" {
		return severity
	}
	switch {
	case strings.HasPrefix(code, "publish:"), strings.HasPrefix(code, "validation:"):
		return "blocking"
	case strings.HasPrefix(code, "ai:"), strings.HasPrefix(code, "media:"):
		return "degraded"
	default:
		return ""
	}
}

// OSLabel joins a JSON object name version arch, otherwise returns the string.
func OSLabel(raw string) string {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return ""
	}
	if !strings.HasPrefix(raw, "{") {
		return raw
	}
	var obj struct {
		Name    string `json:"name"`
		Version string `json:"version"`
		Arch    string `json:"arch"`
	}
	if json.Unmarshal([]byte(raw), &obj) != nil {
		return raw
	}
	parts := []string{}
	for _, part := range []string{obj.Name, obj.Version, obj.Arch} {
		if part != "" {
			parts = append(parts, part)
		}
	}
	return strings.Join(parts, " ")
}

// OccurredAtLabel keeps RFC3339 text and formats an integer millisecond epoch.
func OccurredAtLabel(raw string) string {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return ""
	}
	if n, err := strconv.ParseInt(raw, 10, 64); err == nil {
		return time.UnixMilli(n).UTC().Format("2006-01-02T15:04:05.000Z")
	}
	return raw
}

// DeleteKeys bounds a delete body to 1..100 non-empty ids of at most 128 bytes.
func DeleteKeys(events [][2]string) *Fault {
	if len(events) < 1 || len(events) > 100 {
		return Validation("VALIDATION", "每次须选择 1 至 100 条错误日志")
	}
	for _, pair := range events {
		for _, part := range pair {
			part = strings.TrimSpace(part)
			if part == "" || len(part) > 128 {
				return Validation("VALIDATION", "错误日志标识无效")
			}
		}
	}
	return nil
}
