package domain

import "testing"

func TestCataloguePathsAndParse(t *testing.T) {
	if got, _ := ModelsEndpoint("https://api.anthropic.com/v1", "anthropic_messages"); got != "https://api.anthropic.com/v1/models" {
		t.Fatal(got)
	}
	if got, _ := ModelsEndpoint("https://api.anthropic.com", "anthropic_messages"); got != "https://api.anthropic.com/v1/models" {
		t.Fatal(got)
	}
	if got, _ := ModelsEndpoint("https://example.com/v1/", "chat_completions"); got != "https://example.com/v1/models" {
		t.Fatal(got)
	}
	if got, _ := ModelsEndpoint("https://example.com", "responses"); got != "https://example.com/models" {
		t.Fatal(got)
	}
	models, ok := ParseModels([]byte(`{"data":[{"id":" b ","owned_by":"x"},{"id":"a","owned_by":1},{"id":"b","owned_by":"y"},{"id":"  "}]}`))
	if !ok || len(models) != 2 || models[0].ID != "a" || models[0].OwnedBy != "" || models[1].ID != "b" || models[1].OwnedBy != "x" {
		t.Fatalf("%+v", models)
	}
	empty, ok := ParseModels([]byte(`{"object":"list"}`))
	if !ok || len(empty) != 0 {
		t.Fatal(empty, ok)
	}
	if _, ok := ParseModels([]byte(`not-json`)); ok {
		t.Fatal("json")
	}
	if PublicEndpoint("http://127.0.0.1:9/v1", false) == "" || PublicEndpoint("http://127.0.0.1:9/v1", true) != "" {
		t.Fatal("loop")
	}
	if PublicEndpoint("https://192.168.0.1/v1", true) == "" || PublicEndpoint("https://user:pw@example.com/v1", true) == "" {
		t.Fatal("private")
	}
	base, ok := ConfiguredURL("http://127.0.0.1:9/v1/", true)
	if !ok || base != "http://127.0.0.1:9/v1" {
		t.Fatal(base, ok)
	}
	summary := ClientErrorSummary(401, `{"error":{"code":"bad","message":"key SECRET"}}`, "SECRET")
	if summary != "AI 上游返回 HTTP 401：code=bad；message=key [REDACTED]" {
		t.Fatal(summary)
	}
}
