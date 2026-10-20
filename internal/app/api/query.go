package api

import (
	"math"
	"math/big"
	"net/url"
	"strconv"
	"strings"
	"time"
)

const maxCursorMicros int64 = 4_102_444_800_000_000

func queryPtr(q url.Values, key string) *string {
	vs, ok := q[key]
	if !ok || len(vs) == 0 {
		return nil
	}
	return &vs[0]
}

func parsePositive(raw *string, fallback uint32, field string) (uint32, error) {
	if raw == nil {
		return fallback, nil
	}
	value := strings.TrimSpace(*raw)
	if value == "" {
		return fallback, nil
	}
	n, err := strconv.ParseUint(value, 10, 32)
	if err != nil || n == 0 {
		return 0, errPositive(field)
	}
	return uint32(n), nil
}

type positiveError string

func (e positiveError) Error() string { return string(e) }

func errPositive(field string) error {
	return positiveError(field + " 必须是正整数")
}

func parsePage(raw *string) (uint32, error) { return parsePositive(raw, 1, "page") }

func parsePageSize(raw *string) (uint32, error) {
	n, err := parsePositive(raw, 25, "page_size")
	if err != nil {
		return 0, err
	}
	if n > 100 {
		return 0, positiveError("page_size 不能超过 100")
	}
	return n, nil
}

func totalPages(total int64, pageSize uint32) int32 {
	if total <= 0 || pageSize == 0 {
		return 1
	}
	pages := (total + int64(pageSize) - 1) / int64(pageSize)
	if pages > math.MaxInt32 {
		return math.MaxInt32
	}
	return int32(pages)
}

func clampPage(page uint32, pages int32) uint32 {
	if pages < 1 {
		pages = 1
	}
	limit := uint32(pages)
	if page < limit {
		return page
	}
	return limit
}

func i32sat(n uint32) int32 {
	if n > math.MaxInt32 {
		return math.MaxInt32
	}
	return int32(n)
}

func usageOffset(page, pageSize uint32) int64 {
	if page == 0 {
		return 0
	}
	left := int64(page - 1)
	right := int64(pageSize)
	if right != 0 && left > math.MaxInt64/right {
		return math.MaxInt64
	}
	return left * right
}

func parseRangeDays(raw *string) (uint32, error) {
	days, err := parsePositive(raw, 30, "days")
	if err != nil {
		return 0, err
	}
	if days != 7 && days != 30 {
		return 0, positiveError("days 必须是 7 或 30")
	}
	return days, nil
}

func rangeDates(days uint32, now time.Time) (string, string) {
	today := now.UTC()
	from := today.AddDate(0, 0, -int(days-1))
	return from.Format("2006-01-02"), today.Format("2006-01-02")
}

func parseExplicitRange(from, to *string) (start, end time.Time, ok bool, err error) {
	if from == nil && to == nil {
		return time.Time{}, time.Time{}, false, nil
	}
	if from == nil || to == nil {
		return time.Time{}, time.Time{}, false, positiveError("from 与 to 必须同时提供")
	}
	start, err = time.Parse("2006-01-02", *from)
	if err != nil {
		return time.Time{}, time.Time{}, false, positiveError("from 必须是 YYYY-MM-DD")
	}
	end, err = time.Parse("2006-01-02", *to)
	if err != nil {
		return time.Time{}, time.Time{}, false, positiveError("to 必须是 YYYY-MM-DD")
	}
	if start.After(end) {
		return time.Time{}, time.Time{}, false, positiveError("from 不能晚于 to")
	}
	if int(end.Sub(start).Hours()/24) >= 92 {
		return time.Time{}, time.Time{}, false, positiveError("查询区间最长 92 天")
	}
	return start, end, true, nil
}

func parseSummary(raw *string) (bool, error) {
	if raw == nil {
		return false, nil
	}
	switch *raw {
	case "1", "true":
		return true, nil
	default:
		return false, positiveError("summary 必须是 1 或 true")
	}
}

func cacheHitRateBps(cached, input int64) int32 {
	if cached <= 0 || input <= 0 {
		return 0
	}
	if cached > input {
		cached = input
	}
	c := new(big.Int).SetInt64(cached)
	in := new(big.Int).SetInt64(input)
	num := new(big.Int).Mul(c, big.NewInt(10_000))
	num.Add(num, new(big.Int).Quo(in, big.NewInt(2)))
	num.Quo(num, in)
	if !num.IsInt64() || num.Int64() > math.MaxInt32 {
		return math.MaxInt32
	}
	return int32(num.Int64())
}

func satAdd(a, b int64) int64 {
	if b > 0 && a > math.MaxInt64-b {
		return math.MaxInt64
	}
	if b < 0 && a < math.MinInt64-b {
		return math.MinInt64
	}
	return a + b
}

// runPageBounds copies list_jobs' second clamp. A requested page of 100 asks
// the query for 101 rows, and that argument is clamped back to 100, so a full
// page never carries nextCursor.
func runPageBounds(limit int64) (page, fetch int64) {
	if limit < 1 {
		limit = 1
	}
	if limit > 100 {
		limit = 100
	}
	fetch = limit + 1
	if fetch > 100 {
		fetch = 100
	}
	return limit, fetch
}

func parseLimit(raw *string) (int64, error) {
	if raw == nil {
		return 50, nil
	}
	n, err := strconv.ParseInt(*raw, 10, 64)
	if err != nil {
		return 0, positiveError("limit 无效")
	}
	page, _ := runPageBounds(n)
	return page, nil
}

func canonicalUUID(raw string) (string, bool) {
	s := strings.TrimSpace(raw)
	lower := strings.ToLower(s)
	lower = strings.TrimPrefix(lower, "urn:uuid:")
	lower = strings.TrimPrefix(lower, "{")
	lower = strings.TrimSuffix(lower, "}")
	hex := strings.ReplaceAll(lower, "-", "")
	if len(hex) != 32 {
		return "", false
	}
	for _, c := range hex {
		if (c < '0' || c > '9') && (c < 'a' || c > 'f') {
			return "", false
		}
	}
	if strings.Contains(lower, "-") {
		if len(lower) != 36 || lower[8] != '-' || lower[13] != '-' || lower[18] != '-' || lower[23] != '-' {
			return "", false
		}
	}
	return hex[0:8] + "-" + hex[8:12] + "-" + hex[12:16] + "-" + hex[16:20] + "-" + hex[20:], true
}

func parseCursor(raw *string) (int64, string) {
	if raw == nil {
		return 0, ""
	}
	text := *raw
	if text == "" {
		return 0, ""
	}
	microsText, idText, ok := strings.Cut(text, ":")
	if !ok {
		return 0, ""
	}
	id, ok := canonicalUUID(idText)
	if !ok {
		return 0, ""
	}
	micros, err := strconv.ParseInt(microsText, 10, 64)
	if err != nil || micros < 0 || micros > maxCursorMicros {
		return 0, ""
	}
	return micros, id
}

func rfc3339Millis(t time.Time) string {
	return t.UTC().Truncate(time.Millisecond).Format("2006-01-02T15:04:05.000Z")
}
