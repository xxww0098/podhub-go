package domain

import "testing"

func TestErrorQueryAndLabels(t *testing.T) {
	q, err := ValidateErrorQuery(map[string]string{})
	if err != nil || q.Page != 1 || q.PageSize != 25 {
		t.Fatal(q, err)
	}
	if _, err := ValidateErrorQuery(map[string]string{"page": "0"}); err == nil || err.Message != "page 必须是正整数" {
		t.Fatal(err)
	}
	if _, err := ValidateErrorQuery(map[string]string{"page_size": "101"}); err == nil {
		t.Fatal("size")
	}
	if _, err := ValidateErrorQuery(map[string]string{"source": "nope"}); err == nil || err.Message != "错误来源无效" {
		t.Fatal(err)
	}
	if _, err := ValidateErrorQuery(map[string]string{"since": "yesterday"}); err == nil {
		t.Fatal("since")
	}
	if _, err := ValidateErrorQuery(map[string]string{"platform": "has space"}); err == nil || err.Message != "诊断筛选值无效" {
		t.Fatal(err)
	}
	if _, err := ValidateErrorQuery(map[string]string{"group_by": "code"}); err == nil || err.Message != "日志分组方式无效" {
		t.Fatal(err)
	}
	grouped, err := ValidateErrorQuery(map[string]string{"group_by": "platform_stage_code", "source": "workbench", "code": "publish:OZON"})
	if err != nil || grouped.GroupBy == "" || grouped.Code != "publish:OZON" {
		t.Fatal(grouped, err)
	}
	if SeverityLabel("", "publish:OZON_IMPORT") != "blocking" || SeverityLabel("", "ai:RELAY_FAILED") != "degraded" || SeverityLabel("degraded", "publish:X") != "degraded" || SeverityLabel("", "host:uncaught") != "" {
		t.Fatal("severity")
	}
	if OSLabel(`{"name":"macos","version":"15.3","arch":"aarch64"}`) != "macos 15.3 aarch64" {
		t.Fatal(OSLabel(`{"name":"macos","version":"15.3","arch":"aarch64"}`))
	}
	if OSLabel("macos aarch64") != "macos aarch64" || OccurredAtLabel("1787554800000") != "2026-08-24T07:00:00.000Z" || OccurredAtLabel("2026-08-24T07:00:00Z") != "2026-08-24T07:00:00Z" {
		t.Fatal("labels")
	}
	pages, _ := TotalPages(0, 25)
	if pages != 1 {
		t.Fatal(pages)
	}
	if ClampPage(9, 3) != 3 {
		t.Fatal("clamp")
	}
	if DeleteKeys(nil) == nil {
		t.Fatal("empty delete")
	}
	if DeleteKeys([][2]string{{"id", "dev"}}) != nil {
		t.Fatal("ok delete")
	}
	if DeleteKeys([][2]string{{" ", "dev"}}) == nil {
		t.Fatal("blank")
	}
}
