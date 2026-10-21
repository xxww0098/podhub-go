package service

import (
	"bytes"
	"context"
	"encoding/json"
	"log/slog"
	"strings"
	"testing"

	"github.com/xxww0098/podhub-go/internal/mcp/domain"
)

func TestGrantCallerCannotMintCodes(t *testing.T) {
	var buf bytes.Buffer
	prev := slog.Default()
	slog.SetDefault(slog.New(slog.NewTextHandler(&buf, nil)))
	t.Cleanup(func() { slog.SetDefault(prev) })

	codes := &recordCodes{}
	svc := New(grantStore{grant: sampleCodeGrant()}).WithCodes(codes)
	body := `{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"generateActivationCodes","arguments":{"member_seats":1,"quantity":1,"duration_days":30,"tier":"pro"}}}`
	status, raw := svc.Handle(context.Background(), "hash", []byte(body))
	if status != 200 || codes.calls != 0 || !strings.Contains(string(raw), stepUpRequired) || !strings.Contains(string(raw), `"isError":true`) {
		t.Fatalf("status %d calls %d %s", status, codes.calls, raw)
	}
	if strings.Contains(buf.String(), "POD-") || strings.Contains(string(raw), "POD-") {
		t.Fatal("grant refusal leaked a code")
	}

	list := `{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}`
	_, listed := svc.Handle(context.Background(), "hash", []byte(list))
	for _, name := range []string{`"search"`, `"execute"`, `"generateActivationCodes"`, `"generateQuotaCards"`, `"listRedeemCodes"`, "成员席位批次兑换码已停用", "生成额度卡"} {
		if !strings.Contains(string(listed), name) {
			t.Fatalf("missing %s in %s", name, listed)
		}
	}
}

func TestSessionCodeToolDoesNotLogPlaintext(t *testing.T) {
	const plain = "POD-PLAN-PLAINTEXT"
	var buf bytes.Buffer
	prev := slog.Default()
	slog.SetDefault(slog.New(slog.NewTextHandler(&buf, nil)))
	t.Cleanup(func() { slog.SetDefault(prev) })

	codes := &recordCodes{body: []byte(`{"data":{"codes":[{"code":"` + plain + `"}]}}`)}
	svc := New(nil).WithCodes(codes)
	body := `{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"generateQuotaCards","arguments":{"member_seats":0,"quantity":1,"duration_days":1,"wallet_cents":100}}}`
	status, raw := svc.HandleSession(context.Background(), domain.Caller{UserID: 1, PlatformRole: "super_admin"}, []byte(body))
	if status != 200 || codes.calls != 1 || codes.last != toolQuota || !strings.Contains(string(raw), plain) {
		t.Fatalf("status %d calls %d last %s %s", status, codes.calls, codes.last, raw)
	}
	if strings.Contains(buf.String(), plain) || strings.Contains(string(raw), `"text":"`+plain) {
		t.Fatalf("plaintext leaked into the log or the text channel: %s", buf.String())
	}
	if !strings.Contains(string(raw), "已生成，明文仅在本次结果中") {
		t.Fatal(string(raw))
	}
}

func TestSessionWithoutIssuerRefuses(t *testing.T) {
	svc := New(nil)
	body := `{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"listRedeemCodes","arguments":{}}}`
	_, raw := svc.HandleSession(context.Background(), domain.Caller{PlatformRole: "super_admin"}, []byte(body))
	if !strings.Contains(string(raw), msgUnavailable) || !strings.Contains(string(raw), `"isError":true`) {
		t.Fatal(string(raw))
	}
}

func TestUnknownToolStaysUnknown(t *testing.T) {
	svc := New(grantStore{grant: sampleCodeGrant()})
	body := `{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"mint","arguments":{}}}`
	_, raw := svc.Handle(context.Background(), "hash", []byte(body))
	if !strings.Contains(string(raw), "Unknown tool name") {
		t.Fatal(string(raw))
	}
}

type recordCodes struct {
	calls int
	last  string
	body  json.RawMessage
}

func (r *recordCodes) CreateActivation(context.Context, domain.Caller, json.RawMessage) (json.RawMessage, error) {
	r.calls++
	r.last = toolActivation
	return r.body, nil
}
func (r *recordCodes) CreateQuota(context.Context, domain.Caller, json.RawMessage) (json.RawMessage, error) {
	r.calls++
	r.last = toolQuota
	return r.body, nil
}
func (r *recordCodes) ListCodes(context.Context, domain.Caller, json.RawMessage) (json.RawMessage, error) {
	r.calls++
	r.last = toolListCodes
	return r.body, nil
}

func sampleCodeGrant() domain.Grant {
	return domain.Grant{
		ID: "11111111-1111-4111-8111-111111111111", UserID: 7, OrgID: 3,
		ScopeKind: "workspace", Actions: []string{"read"}, WorkspaceRole: "owner", PlatformRole: "super_admin",
	}
}

type grantStore struct{ grant domain.Grant }

func (f grantStore) Resolve(context.Context, string) (*domain.Grant, error) {
	g := f.grant
	return &g, nil
}
func (grantStore) Begin(context.Context, domain.Grant, string, string, string) (domain.Start, error) {
	return domain.Start{}, domain.NewHost("internal", "Service is temporarily unavailable")
}
func (grantStore) Finish(context.Context, domain.Grant, domain.Claim, string, *domain.HostError, int) (domain.Envelope, error) {
	return domain.Envelope{}, domain.NewHost("internal", "Service is temporarily unavailable")
}
func (grantStore) WorkspaceName(context.Context, domain.Grant, domain.Claim) (string, error) {
	return "", domain.NewHost("internal", "Service is temporarily unavailable")
}
func (grantStore) ExecutionView(context.Context, domain.Grant, domain.Claim, string) (domain.Envelope, error) {
	return domain.Envelope{}, domain.NewHost("internal", "Service is temporarily unavailable")
}
