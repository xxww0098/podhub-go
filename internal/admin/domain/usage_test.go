package domain

import (
	"strings"
	"testing"
	"time"
)

func TestUsageFilterAndPage(t *testing.T) {
	now := time.Date(2026, 10, 17, 0, 0, 0, 0, time.UTC)
	if _, msg := ParseUsageFilter(strings.Repeat("字", 201), "", "", "", "", now); msg != "筛选关键词不能超过 200 个字符" {
		t.Fatal(msg)
	}
	if _, msg := ParseUsageFilter("", "nope", "", "", "", now); msg != "请求状态无效" {
		t.Fatal(msg)
	}
	if _, msg := ParseUsageFilter("", "", "grpc", "", "", now); msg != "请求端点无效" {
		t.Fatal(msg)
	}
	if _, msg := ParseUsageFilter("", "", "", "embed", "", now); msg != "请求操作无效" {
		t.Fatal(msg)
	}
	if _, msg := ParseUsageFilter("", "", "", "", "yesterday", now); msg != "筛选时间格式无效" {
		t.Fatal(msg)
	}
	got, msg := ParseUsageFilter(" q ", "settled", "", "ocr", "2026-10-01T00:00:00Z", now)
	if msg != "" || got.Q != "q" || got.Status != "settled" || got.Operation != "ocr" || got.Since == nil {
		t.Fatalf("%+v %s", got, msg)
	}
	if !got.Retained.Equal(now.AddDate(0, 0, -30)) {
		t.Fatal(got.Retained)
	}
	if _, msg := ParsePage("0", 1, 0, "", "page 必须是正整数"); msg != "page 必须是正整数" {
		t.Fatal(msg)
	}
	if _, msg := ParsePage("101", 25, 100, "page_size 不能超过 100", "page_size 必须是正整数"); msg != "page_size 不能超过 100" {
		t.Fatal(msg)
	}
	n, msg := ParsePage("", 25, 100, "page_size 不能超过 100", "page_size 必须是正整数")
	if n != 25 || msg != "" {
		t.Fatal(n, msg)
	}
	page, pages, limit, offset := PageWindow(40, 25, 0)
	if page != 1 || pages != 1 || limit != 25 || offset != 0 {
		t.Fatalf("empty %d %d %d %d", page, pages, limit, offset)
	}
	page, pages, _, offset = PageWindow(40, 25, 60)
	if page != 3 || pages != 3 || offset != 50 {
		t.Fatalf("clamp %d %d %d", page, pages, offset)
	}
	if CacheHitBps(1, 0) != 0 || CacheHitBps(1, 2) != 5000 {
		t.Fatal("bps")
	}
}
