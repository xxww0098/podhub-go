package domain

import (
	"strings"
	"testing"

	"github.com/xxww0098/podhub-go/internal/ozonerr/contract"
)

func TestParseImportDropsUnknownAndStripsSecret(t *testing.T) {
	const fixture = "fixture-api-key-browser-direct"
	raw := []byte(`{
		"taskId": 42,
		"apiKey": "` + fixture + `",
		"items": [{
			"offer_id": "A-1",
			"description_category_id": 7,
			"type_id": 8,
			"errors": [{
				"code": "SPU_already_exists",
				"field": "name",
				"attribute_id": 85,
				"attribute_name": "Brand",
				"description": "已存在 ` + fixture + `",
				"state": "failed",
				"level": "error",
				"optional_description_elements": {"secret": "` + fixture + `"},
				"api_key": "` + fixture + `"
			}]
		}]
	}`)
	rows, err := ParseImportBody(raw)
	if err != nil || len(rows) != 1 {
		t.Fatalf("%v %d", err, len(rows))
	}
	row := rows[0]
	if row.Source != SourceImportInfo || row.Code != "SPU_already_exists" || row.TaskKey != "42" || row.OfferKey != "A-1" {
		t.Fatalf("%+v", row)
	}
	if row.AttributeID != 85 || row.DescriptionCategoryID != 7 || row.TypeID != 8 || row.Field != "name" {
		t.Fatalf("%+v", row)
	}
	if strings.Contains(row.Sample, fixture) || strings.Contains(strings.ToLower(row.Sample), "api-key") {
		t.Fatalf("sample %s", row.Sample)
	}
	if !strings.Contains(row.Sample, "已存在") || !strings.Contains(row.Sample, "[redacted]") {
		t.Fatalf("sample %s", row.Sample)
	}
}

func TestParseImportRefusesTooMany(t *testing.T) {
	var b strings.Builder
	b.WriteString(`{"taskId":1,"errors":[`)
	for i := 0; i < MaxErrors+1; i++ {
		if i > 0 {
			b.WriteByte(',')
		}
		b.WriteString(`{"code":"E"}`)
	}
	b.WriteString(`]}`)
	rows, err := ParseImportBody([]byte(b.String()))
	if err != contract.ErrTooMany || rows != nil {
		t.Fatalf("%v %d", err, len(rows))
	}
}

func TestRequestFromReportMaps4xxOnly(t *testing.T) {
	status := 400
	got, ok := RequestFromReport([]byte(`{"intentId":"x","httpStatus":400,"gateway":{"code":3,"message":"Bearer fixture-api-key-browser-direct","details":["fixture-api-key-browser-direct"]}}`), "intent", &status)
	if !ok || got.GatewayCode == nil || *got.GatewayCode != 3 {
		t.Fatalf("%+v %v", got, ok)
	}
	if strings.Contains(got.Message, "details") {
		t.Fatal(got.Message)
	}
	code, ok := ResolveGRPC(got.HTTPStatus, got.GatewayCode)
	if !ok || code != "3" {
		t.Fatal(code, ok)
	}
	for _, st := range []int{200, 500, 0} {
		s := st
		if _, ok := RequestFromReport([]byte(`{}`), "intent", &s); ok {
			t.Fatalf("status %d recorded", st)
		}
	}
	s404 := 404
	if _, ok := RequestFromReport([]byte(`{}`), "intent", &s404); !ok {
		t.Fatal("404")
	}
	if c, ok := ResolveGRPC(404, nil); !ok || c != "5" {
		t.Fatal(c, ok)
	}
	if c, ok := ResolveGRPC(403, nil); !ok || c != "7" {
		t.Fatal(c)
	}
	if c, ok := ResolveGRPC(401, nil); !ok || c != "16" {
		t.Fatal(c)
	}
	if c, ok := ResolveGRPC(429, nil); !ok || c != "8" {
		t.Fatal(c)
	}
	if c, ok := ResolveGRPC(422, nil); !ok || c != "422" {
		t.Fatal(c, ok)
	}
	weird := int64(9)
	if c, ok := ResolveGRPC(400, &weird); !ok || c != "3" {
		t.Fatalf("400 with code 9 became %s", c)
	}
}

func TestOther4xxKeepsExplicitCodeAndDropsBody(t *testing.T) {
	status := 422
	raw := []byte(`{"taskId":7,"offerId":"client","httpStatus":422,"body":{"apiKey":"fixture-api-key-browser-direct"},"gateway":{"message":"密度 fixture-api-key-browser-direct","details":["fixture-api-key-browser-direct"]}}`)
	got, ok := RequestFromReport(raw, "intent", &status)
	if !ok || got.TaskKey != "7" || got.GatewayCode != nil {
		t.Fatalf("%+v %v", got, ok)
	}
	if strings.Contains(got.Message, "details") || strings.Contains(got.Message, "apiKey") || strings.Contains(got.Message, "body") {
		t.Fatal(got.Message)
	}
	if !strings.Contains(got.Message, "密度") || !strings.Contains(got.Message, "fixture-api-key-browser-direct") {
		t.Fatal(got.Message)
	}
	code, ok := ResolveGRPC(got.HTTPStatus, got.GatewayCode)
	if !ok || code != "422" {
		t.Fatal(code, ok)
	}
	explicit := int64(9)
	if c, ok := ResolveGRPC(422, &explicit); !ok || c != "9" {
		t.Fatal(c, ok)
	}
	zero := int64(0)
	if c, ok := ResolveGRPC(409, &zero); !ok || c != "409" {
		t.Fatal(c, ok)
	}
	if c, ok := ResolveGRPC(409, nil); !ok || c != "409" {
		t.Fatal(c, ok)
	}
	row, ok := GatewayRow("7", 422, []byte(`{"message":"no","details":[{"body":"fixture-api-key-browser-direct"}],"apiKey":"fixture-api-key-browser-direct"}`))
	if !ok || row.Code != "422" || row.Source != SourceRequest || row.Sample != "no" || row.OfferKey != "" || row.AttributeID != 0 || row.DescriptionCategoryID != 0 || row.TypeID != 0 {
		t.Fatalf("%+v %v", row, ok)
	}
	if strings.Contains(row.Sample, "fixture") || strings.Contains(row.Sample, "details") {
		t.Fatal(row.Sample)
	}
}

func TestMissingAttributeCategoryTypeStayZero(t *testing.T) {
	raw := []byte(`{"taskId":3,"items":[{"errors":[{"code":"offer_id_not_found","description":"缺省"}]}]}`)
	rows, err := ParseImportBody(raw)
	if err != nil || len(rows) != 1 {
		t.Fatalf("%v %+v", err, rows)
	}
	row := rows[0]
	if row.AttributeID != 0 || row.DescriptionCategoryID != 0 || row.TypeID != 0 || row.Code != "offer_id_not_found" {
		t.Fatalf("%+v", row)
	}
}

func TestSharedTaskKeyCanonical(t *testing.T) {
	if SharedTaskKey("42") != "42" || SharedTaskKey(" 42 ") != "42" {
		t.Fatal(SharedTaskKey("42"))
	}
	for _, raw := range []string{"", "0", "-1", "042", "intent:abc", "1.5"} {
		if SharedTaskKey(raw) != "" {
			t.Fatalf("%q", raw)
		}
	}
}

func TestUpstreamIgnoresRequestBodyExceptTaskID(t *testing.T) {
	req := []byte(`{"task_id":9,"apiKey":"fixture-api-key-browser-direct","items":[{"offer_id":"nope"}]}`)
	if id, ok := TaskID(req); !ok || id != "9" {
		t.Fatalf("%s %v", id, ok)
	}
	resp := []byte(`{"result":{"items":[{"offer_id":"SKU","errors":[{"code":"Invalid_state","description":"bad"}]}]}}`)
	rows := ParseUpstreamItems("9", resp)
	if len(rows) != 1 || rows[0].OfferKey != "SKU" || rows[0].Code != "Invalid_state" || rows[0].TaskKey != "9" {
		t.Fatalf("%+v", rows)
	}
	row, ok := GatewayRow("9", 403, []byte(`{"code":7,"message":"no","details":[{"body":"fixture-api-key-browser-direct"}]}`))
	if !ok || row.Code != "7" || row.Source != SourceRequest || row.Sample != "no" || row.OfferKey != "" {
		t.Fatalf("%+v %v", row, ok)
	}
}
