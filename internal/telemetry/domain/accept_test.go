package domain

import (
	"strings"
	"testing"
	"time"
)

func TestLimitsMatchRustConstants(t *testing.T) {
	if EventInboxItemMaxWireBytes != 33216 || EventInboxMaxRequestBytes != 6644224 || EventInboxCommitChunk != 20 {
		t.Fatalf("inbox limits %d %d %d", EventInboxItemMaxWireBytes, EventInboxMaxRequestBytes, EventInboxCommitChunk)
	}
	if ClientListingLogMaxBody != 98304 || ClientListingLogMaxRecords != 40 {
		t.Fatal("client log limits")
	}
	// 29 * 1_073_741_824 / 2. The spec prose writes 15566761488; the integer formula is 15569256448.
	if S3BytesForStores(1) != 15_569_256_448 || S3BytesForStores(0) != 0 {
		t.Fatal(S3BytesForStores(1))
	}
	if BillingPeriodUTC(time.Date(2026, 8, 2, 12, 0, 0, 0, time.UTC).UnixMilli()) != "2026-08" {
		t.Fatal("period")
	}
}

func TestInboxGoldenVectors(t *testing.T) {
	body := []byte(`{"events":[{"id":"evt_fixture_001","kind":"desktop_error_log.v1","payload_json":"{\"schemaVersion\":1,\"source\":\"host_uncaught\",\"code\":\"fixture:replay\",\"fingerprint\":\"0123456789abcdef\",\"message\":\"fixture replay\",\"appVersion\":\"0.9.4\",\"os\":\"darwin\",\"occurredAt\":\"2026-08-02T12:00:00Z\"}","schema_version":1}]}`)
	req, err := DecodeInbox(body)
	if err != nil {
		t.Fatal(err)
	}
	got, rej := AcceptInboxItem(req.Events[0])
	if rej != nil || got.ID != "evt_fixture_001" || got.SchemaVersion != 1 {
		t.Fatalf("%+v %+v", got, rej)
	}
	if !strings.Contains(got.Payload, `"message":"fixture replay"`) {
		t.Fatal(got.Payload)
	}
	again, rej := AcceptInboxItem(req.Events[0])
	if rej != nil {
		t.Fatal(rej)
	}
	replay, reason := CompareInbox(StoredInbox{OrgID: 1, UserID: 2, Kind: got.Kind, Payload: got.Payload, SchemaVersion: 1}, again, 1, 2)
	if !replay || reason != "" {
		t.Fatalf("replay %v %s", replay, reason)
	}
	_, reason = CompareInbox(StoredInbox{OrgID: 9, UserID: 2, Kind: got.Kind, Payload: got.Payload, SchemaVersion: 1}, again, 1, 2)
	if reason != "同 id 异身份冲突" {
		t.Fatal(reason)
	}

	upload := `{"schemaVersion":1,"bytes":12500128,"occurredAt":"2026-08-09T17:15:41Z","objectKey":"ozon-pod/teams/workspace/sha256/video.mp4","contentHash":"sha256:94463be1","outcome":"uploaded"}`
	retry := `{"schemaVersion":1,"bytes":12500128,"occurredAt":"2026-08-09T17:20:00Z","objectKey":"ozon-pod/teams/workspace/sha256/video.mp4","contentHash":"sha256:94463be1","outcome":"deduplicated"}`
	first := mustAccept(t, "u1", "billing.object-upload-usage.v1", upload, 1)
	second := mustAccept(t, "u1", "billing.object-upload-usage.v1", retry, 1)
	if replay, reason = CompareInbox(StoredInbox{OrgID: 1, UserID: 2, Kind: first.Kind, Payload: first.Payload, SchemaVersion: 1}, second, 1, 2); !replay {
		t.Fatal(reason)
	}
	rows, err := BillableInputs("dev", first)
	if err != nil || len(rows) != 1 || rows[0].Metric != "traffic.user_to_s3_bytes" || rows[0].Period != "2026-08" || rows[0].EventID != "dev:u1" {
		t.Fatalf("%+v %v", rows, err)
	}
	ai := mustAccept(t, "a1", "billing.ai-token-usage.v1", `{"schemaVersion":1,"provider":"openai","model":"gpt-fixture","inputTokens":12,"outputTokens":3,"totalTokens":15,"occurredAt":"2026-08-09T17:15:41Z","responseId":"resp-1"}`, 1)
	rows, err = BillableInputs("dev", ai)
	if err != nil || len(rows) != 2 || rows[0].Quantity != 12 || rows[1].Quantity != 3 || rows[0].ResourceID != "resp-1" || rows[0].Details != `{"totalTokens":15}` {
		t.Fatalf("%+v %v", rows, err)
	}
}

func TestInboxRejects(t *testing.T) {
	cases := []struct {
		id, kind, payload string
		schema            int32
		reason            string
	}{
		{"", "desktop_error_log.v1", `{}`, 1, "id 无效"},
		{"ok", "seller_monitor_projection.v1", `{"schemaVersion":1}`, 1, "kind 不受支持"},
		{"ok", "billing.ai-token-usage.v1", `{"schemaVersion":1,"provider":"openai","model":"gpt-fixture","inputTokens":12,"outputTokens":3,"totalTokens":15,"occurredAt":"2026-08-09T17:15:41Z","workspaceUuid":"leaked"}`, 1, "payload 含有未允许字段: workspaceUuid"},
		{"ok", "billing.ai-token-usage.v1", `{"schemaVersion":1,"provider":"openai","model":"m","inputTokens":1,"outputTokens":0,"totalTokens":1,"occurredAt":"2026-08-02T12:00:00Z"}`, 2, "schema_version 必须与 billing.ai-token-usage.v1 一致（=1）"},
		{"ok", "desktop_error_log.v1", `{"schemaVersion":1,"source":"nope","code":"c","fingerprint":"0123456789abcdef","message":"m","appVersion":"v","os":"darwin","occurredAt":"2026-08-02T12:00:00Z"}`, 1, "source 无效"},
	}
	for _, tc := range cases {
		payload := tc.payload
		item := WireItem{ID: tc.id, Kind: tc.kind, PayloadJSON: &payload, SchemaVersion: &tc.schema}
		_, rej := AcceptInboxItem(item)
		if rej == nil || !strings.Contains(rej.Reason, tc.reason) && rej.Reason != tc.reason {
			t.Fatalf("%s: %+v", tc.reason, rej)
		}
	}
	if _, err := DecodeInbox([]byte(`{"events":[],"extra":1}`)); err == nil {
		t.Fatal("unknown field")
	}
	if _, err := DecodeInbox([]byte(`{"events":[{"id":"a","kind":"k","nope":1}]}`)); err == nil {
		t.Fatal("item unknown")
	}
	long := strings.Repeat("a", 129)
	if _, ok := DeviceID(long, true); ok {
		t.Fatal("device")
	}
	if id, ok := DeviceID("  dev  ", true); !ok || id != "dev" {
		t.Fatal(id, ok)
	}
	if BatchLimitMessage() != "单批最多 200 条事件" {
		t.Fatal(BatchLimitMessage())
	}
	if QuotaMessage(3, 10) != "工作空间上行流量已用尽（3/10 字节）" {
		t.Fatal(QuotaMessage(3, 10))
	}
}

func TestV4FixtureAndV2Shape(t *testing.T) {
	payload := `{"schemaVersion":4,"diagnosticId":"00000000-0000-4000-8000-000000000004","platform":"ozon","stage":"submit","field":"name","code":"result_unknown","occurredAt":"2026-10-01T00:00:00Z","traceId":"request-42.edge","payloadSha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","summary":[{"field":"name","fieldId":null,"valueType":"string","length":3,"enumValue":null}]}`
	got := mustAccept(t, "00000000-0000-4000-8000-000000000004", "desktop_error_log.v4", payload, 4)
	if !strings.Contains(got.Payload, `"diagnosticId":"00000000-0000-4000-8000-000000000004"`) {
		t.Fatal(got.Payload)
	}
	bad := strings.Replace(payload, `"summary":[`, `"summary":[{"original":"synthetic_secret"},`, 1)
	_, rej := AcceptInboxItem(WireItem{ID: "00000000-0000-4000-8000-000000000004", Kind: "desktop_error_log.v4", PayloadJSON: &bad, SchemaVersion: int32ptr(4)})
	if rej == nil || rej.Reason != "diagnostic v4 envelope 无效" || strings.Contains(rej.Reason, "synthetic_secret") {
		t.Fatalf("%+v", rej)
	}
	v2 := `{"schemaVersion":2,"source":"workbench","code":"render:Failed","severity":"degraded","fingerprint":"0123456789abcdef0123456789abcdef","appVersion":"0.0.99","os":{"name":"linux","version":"6","arch":"amd64"},"occurredAtMs":1}`
	got = mustAccept(t, "v2", "desktop_error_log.v2", v2, 2)
	if !strings.Contains(got.Payload, `"params":{}`) || !strings.Contains(got.Payload, `"frames":[]`) {
		t.Fatal(got.Payload)
	}
	leak := `{"schemaVersion":2,"source":"workbench","code":"render:Failed","severity":"degraded","fingerprint":"0123456789abcdef0123456789abcdef","appVersion":"0.0.99","os":{"name":"linux","version":"6","arch":"amd64"},"occurredAtMs":1,"message":"标题"}`
	_, rej = AcceptInboxItem(WireItem{ID: "v2", Kind: "desktop_error_log.v2", PayloadJSON: &leak, SchemaVersion: int32ptr(2)})
	if rej == nil || !strings.Contains(rej.Reason, "未允许字段") {
		t.Fatalf("%+v", rej)
	}
}

func mustAccept(t *testing.T, id, kind, payload string, schema int32) AcceptedEvent {
	t.Helper()
	got, rej := AcceptInboxItem(WireItem{ID: id, Kind: kind, PayloadJSON: &payload, SchemaVersion: &schema})
	if rej != nil {
		t.Fatal(rej)
	}
	return got
}

func int32ptr(n int32) *int32 { return &n }
