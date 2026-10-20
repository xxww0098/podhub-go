package domain

import (
	"math"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"
)

const logRetentionDays = 30

// UsageFilter is the shared ledger filter.
type UsageFilter struct {
	Q         string
	Status    string
	APIFormat string
	Operation string
	Since     *time.Time
	SinceText string
	Retained  time.Time
}

// ParseUsageFilter validates q, status, api format, operation, and since.
// page and page_size are parsed only for the list route.
func ParseUsageFilter(q, status, apiFormat, operation, since string, now time.Time) (UsageFilter, string) {
	q = strings.TrimSpace(q)
	if utf8.RuneCountInString(q) > 200 {
		return UsageFilter{}, "筛选关键词不能超过 200 个字符"
	}
	status = strings.TrimSpace(status)
	switch status {
	case "", "settled", "failed", "unbilled_unknown", "held", "dispatching":
	default:
		return UsageFilter{}, "请求状态无效"
	}
	apiFormat = strings.TrimSpace(apiFormat)
	switch apiFormat {
	case "", "chat_completions", "responses", "anthropic_messages":
	default:
		return UsageFilter{}, "请求端点无效"
	}
	operation = strings.TrimSpace(operation)
	switch operation {
	case "", "ocr", "ai_token":
	default:
		return UsageFilter{}, "请求操作无效"
	}
	var parsed *time.Time
	sinceText := ""
	if s := strings.TrimSpace(since); s != "" {
		ts, err := time.Parse(time.RFC3339, s)
		if err != nil {
			return UsageFilter{}, "筛选时间格式无效"
		}
		parsed = &ts
		sinceText = ts.Format(time.RFC3339Nano)
	}
	return UsageFilter{
		Q: q, Status: status, APIFormat: apiFormat, Operation: operation,
		Since: parsed, SinceText: sinceText, Retained: now.AddDate(0, 0, -logRetentionDays),
	}, ""
}

// ParsePage validates a positive page or page_size. Blank means the default.
func ParsePage(raw string, fallback, max uint32, overflow string, zero string) (uint32, string) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return fallback, ""
	}
	n, err := strconv.ParseUint(raw, 10, 32)
	if err != nil || n == 0 {
		return 0, zero
	}
	if max > 0 && uint32(n) > max {
		return 0, overflow
	}
	return uint32(n), ""
}

// PageWindow clamps the requested page onto the last page.
func PageWindow(page, pageSize uint32, total int64) (resolved uint32, pages int32, limit, offset int64) {
	pages = totalPages(total, pageSize)
	maxPage := uint32(pages)
	if maxPage < 1 {
		maxPage = 1
	}
	if page > maxPage {
		page = maxPage
	}
	if page < 1 {
		page = 1
	}
	limit = int64(pageSize)
	offset = int64(page-1) * limit
	return page, pages, limit, offset
}

func totalPages(total int64, pageSize uint32) int32 {
	if total <= 0 || pageSize == 0 {
		return 1
	}
	size := int64(pageSize)
	pages := (total + size - 1) / size
	if pages > math.MaxInt32 {
		return math.MaxInt32
	}
	return int32(pages)
}

// AsI32 saturates a u32 into i32.
func AsI32(n uint32) int32 {
	if n > math.MaxInt32 {
		return math.MaxInt32
	}
	return int32(n)
}

// CacheHitBps is cached*10000/input, or 0 when input is 0.
func CacheHitBps(cached, input int64) int32 {
	if input <= 0 {
		return 0
	}
	if cached < 0 {
		cached = 0
	}
	v := cached * 10000 / input
	if v > math.MaxInt32 {
		return math.MaxInt32
	}
	return int32(v)
}
