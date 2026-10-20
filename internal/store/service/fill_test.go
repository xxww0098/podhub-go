package service

import (
	"bytes"
	"context"
	"log/slog"
	"strings"
	"testing"
	"time"

	"github.com/xxww0098/podhub-go/internal/store/contract"
	"github.com/xxww0098/podhub-go/internal/store/domain"
)

const (
	fixtureKey = "fixture-api-key-store-autofill"
	taxINN     = "tax-inn-must-not-leak"
	taxOGRN    = "tax-ogrn-must-not-leak"
)

func TestAutofillAndManualAndFailure(t *testing.T) {
	body := []byte(`{"company":{"name":"LUAN4","legal_name":"Sanming Lu an Fire Equipment Co., Ltd.","inn":"` + taxINN + `","ogrn":"` + taxOGRN + `","currency":"CNY"},"subscription":{"is_premium":false,"type":"FREE"},"ratings":[]}`)
	dir := &memDir{rows: map[string]domain.Store{
		"auto":   {UUID: "auto", Name: "old", Source: domain.SourceAuto},
		"manual": {UUID: "manual", Name: "handmade", Source: domain.SourceManual, LegalName: "Keep"},
		"blank":  {UUID: "blank", Name: "shop", Source: domain.SourceAuto},
	}}
	var logs bytes.Buffer
	prev := slog.Default()
	slog.SetDefault(slog.New(slog.NewTextHandler(&logs, nil)))
	t.Cleanup(func() { slog.SetDefault(prev) })

	okInfo := infoFunc(func(context.Context, string, string) (int, []byte, error) {
		return 200, append([]byte(nil), body...), nil
	})
	svc := New(dir, okInfo)

	filled, err := svc.OnCredentialSaved(context.Background(), 7, "auto", "client", fixtureKey)
	if err != nil || !filled.Filled || filled.Name != "LUAN4" || filled.Source != domain.SourceAuto {
		t.Fatalf("auto %+v %v", filled, err)
	}
	if dir.rows["auto"].LegalName != "Sanming Lu an Fire Equipment Co., Ltd." || dir.rows["auto"].ShortName != "LUAN4" {
		t.Fatalf("stored %+v", dir.rows["auto"])
	}

	manual, err := svc.OnCredentialVerified(context.Background(), 7, "manual", "client", fixtureKey)
	if err != nil || manual.Filled || manual.Name != "handmade" || manual.Source != domain.SourceManual {
		t.Fatalf("manual %+v %v", manual, err)
	}
	if dir.rows["manual"].LegalName != "Sanming Lu an Fire Equipment Co., Ltd." || dir.rows["manual"].Name != "handmade" {
		t.Fatalf("manual row %+v", dir.rows["manual"])
	}

	failInfo := infoFunc(func(context.Context, string, string) (int, []byte, error) {
		return 500, []byte(`{"message":"` + fixtureKey + taxINN + `"}`), nil
	})
	failed, err := New(dir, failInfo).OnCredentialSaved(context.Background(), 7, "blank", "client", fixtureKey)
	if err != nil || !failed.UpstreamFailed || failed.Name != "shop" || dir.rows["blank"].Name != "shop" {
		t.Fatalf("fail %+v %v row %+v", failed, err, dir.rows["blank"])
	}

	missing := infoFunc(func(context.Context, string, string) (int, []byte, error) {
		return 200, []byte(`{"subscription":{"is_premium":false},"ratings":[]}`), nil
	})
	skipped, err := New(dir, missing).OnCredentialVerified(context.Background(), 7, "blank", "client", fixtureKey)
	if err != nil || skipped.UpstreamFailed || skipped.Filled || dir.rows["blank"].Name != "shop" || dir.rows["blank"].ShortName != "" {
		t.Fatalf("missing %+v %v %+v", skipped, err, dir.rows["blank"])
	}

	text := logs.String() + dir.text()
	for _, leak := range []string{fixtureKey, taxINN, taxOGRN} {
		if strings.Contains(text, leak) {
			t.Fatalf("leak %s in %s", leak, text)
		}
	}
}

func TestGroupsHideOtherAssignee(t *testing.T) {
	member := int64(4)
	other := int64(9)
	dir := &memDir{rows: map[string]domain.Store{
		"mine":   {UUID: "00000000-0000-4000-8000-000000000001", Name: "mine", LegalName: "Co", CreateOrder: 1, Assignee: &member},
		"theirs": {UUID: "00000000-0000-4000-8000-000000000002", Name: "theirs", LegalName: "Co", CreateOrder: 2, Assignee: &other},
		"none":   {UUID: "00000000-0000-4000-8000-000000000003", Name: "none", CreateOrder: 3},
	}, member: member, has: true}
	groups, err := New(dir, nil).Groups(context.Background(), 7, 3, "member")
	if err != nil || len(groups) != 1 || len(groups[0].Stores) != 1 || groups[0].Stores[0].Name != "mine" {
		t.Fatalf("%+v %v", groups, err)
	}
	all, err := New(dir, nil).Groups(context.Background(), 7, 3, "owner")
	if err != nil || len(all) != 2 {
		t.Fatalf("owner %+v %v", all, err)
	}
}

func TestRenameSetsManual(t *testing.T) {
	dir := &memDir{rows: map[string]domain.Store{
		"s": {UUID: "s", Name: "old", Source: domain.SourceAuto, LegalName: "Co"},
	}}
	svc := New(dir, nil)
	if _, err := svc.Rename(context.Background(), 7, 1, "member", "s", "new"); err != contract.ErrForbidden {
		t.Fatal(err)
	}
	if dir.rows["s"].Source != domain.SourceAuto {
		t.Fatal(dir.rows["s"])
	}
	same, err := svc.Rename(context.Background(), 7, 1, "owner", "s", " old ")
	if err != nil || same.Source != domain.SourceAuto || same.Name != "old" {
		t.Fatalf("same %+v %v", same, err)
	}
	renamed, err := svc.Rename(context.Background(), 7, 1, "manager", "s", " handmade ")
	if err != nil || renamed.Name != "handmade" || renamed.Source != domain.SourceManual || renamed.LegalName != "Co" {
		t.Fatalf("%+v %v", renamed, err)
	}
	if _, err := svc.Rename(context.Background(), 7, 1, "owner", "s", "  "); err != contract.ErrName {
		t.Fatal(err)
	}
}

func TestHealthCurrencyAndRefresh(t *testing.T) {
	const taxSystem = "tax-system-must-not-leak"
	const ownership = "ownership-form-must-not-leak"
	body := []byte(`{"company":{"name":"LUAN4","legal_name":"Co","currency":"cny","country":"CN","inn":"` + taxINN + `","ogrn":"` + taxOGRN + `","tax_system":"` + taxSystem + `","ownership_form":"` + ownership + `"},"subscription":{"is_premium":false,"type":"FREE"},"ratings":[{"value":1}]}`)
	dir := &memDir{rows: map[string]domain.Store{
		"priced": {UUID: "priced", Name: "old", Source: domain.SourceAuto, PricingCurrency: "USD"},
		"denied": {UUID: "denied", Name: "kept", Source: domain.SourceManual},
		"down":   {UUID: "down", Name: "down", Source: domain.SourceAuto},
	}}
	var logs bytes.Buffer
	prev := slog.Default()
	slog.SetDefault(slog.New(slog.NewTextHandler(&logs, nil)))
	t.Cleanup(func() { slog.SetDefault(prev) })

	okInfo := infoFunc(func(context.Context, string, string) (int, []byte, error) {
		return 200, append([]byte(nil), body...), nil
	})
	verified, err := New(dir, okInfo).OnCredentialVerified(context.Background(), 7, "priced", "client", fixtureKey)
	if err != nil || !verified.CurrencyMismatch || verified.CurrencyWarning != "公司币种 CNY 与店铺定价币种 USD 不一致" {
		t.Fatalf("%+v %v", verified, err)
	}
	if dir.rows["priced"].Currency != "cny" || dir.rows["priced"].Country != "CN" || dir.rows["priced"].SubType != "FREE" || dir.rows["priced"].Premium == nil || *dir.rows["priced"].Premium {
		t.Fatalf("stored %+v", dir.rows["priced"])
	}
	if dir.rows["priced"].KeyStatus != domain.KeyValid || dir.rows["priced"].KeyReason != "" || dir.rows["priced"].SyncedAt == nil {
		t.Fatalf("health %+v", dir.rows["priced"])
	}

	denied := infoFunc(func(context.Context, string, string) (int, []byte, error) {
		return 401, []byte(`{"message":"` + fixtureKey + taxINN + `"}`), nil
	})
	invalid, err := New(dir, denied).OnCredentialSaved(context.Background(), 7, "denied", "client", fixtureKey)
	if err != nil || !invalid.UpstreamFailed || invalid.Name != "kept" || dir.rows["denied"].KeyStatus != domain.KeyInvalid || dir.rows["denied"].KeyReason != domain.Reason401 || dir.rows["denied"].Name != "kept" {
		t.Fatalf("401 %+v %v row %+v", invalid, err, dir.rows["denied"])
	}

	offline := infoFunc(func(context.Context, string, string) (int, []byte, error) {
		return 0, nil, context.DeadlineExceeded
	})
	unknown, err := New(dir, offline).OnCredentialSaved(context.Background(), 7, "down", "client", fixtureKey)
	if err != nil || !unknown.UpstreamFailed || dir.rows["down"].KeyStatus != domain.KeyUnknown || dir.rows["down"].KeyReason != domain.ReasonNetwork || dir.rows["down"].Name != "down" {
		t.Fatalf("network %+v %v row %+v", unknown, err, dir.rows["down"])
	}

	refreshed, warning, err := New(dir, okInfo).WithCredential(credFunc(func(string) (string, string, error) {
		return "client", fixtureKey, nil
	})).Refresh(context.Background(), 7, 1, "owner", "priced")
	if err != nil || refreshed.Currency != "cny" || warning == "" {
		t.Fatalf("refresh %+v %s %v", refreshed, warning, err)
	}
	if _, _, err := New(dir, okInfo).WithCredential(credFunc(func(string) (string, string, error) {
		return "client", fixtureKey, nil
	})).Refresh(context.Background(), 7, 1, "member", "priced"); err != contract.ErrForbidden {
		t.Fatal(err)
	}

	text := logs.String() + dir.text()
	for _, leak := range []string{fixtureKey, taxINN, taxOGRN, taxSystem, ownership, "inn", "ogrn", "tax_system", "ownership_form", "ratings"} {
		if strings.Contains(text, leak) {
			t.Fatalf("leak %s", leak)
		}
	}
}

type credFunc func(string) (string, string, error)

func (f credFunc) Open(_ context.Context, _ int64, storeUUID string) (string, string, error) {
	return f(storeUUID)
}

type infoFunc func(context.Context, string, string) (int, []byte, error)

func (f infoFunc) PostSellerInfo(ctx context.Context, clientID, apiKey string) (int, []byte, error) {
	return f(ctx, clientID, apiKey)
}

type memDir struct {
	rows   map[string]domain.Store
	member int64
	has    bool
	seen   string
}

func (m *memDir) text() string { return m.seen }

func (m *memDir) Load(_ context.Context, orgID int64, storeUUID string) (domain.Store, error) {
	if orgID <= 0 {
		return domain.Store{}, contract.ErrNoTenant
	}
	row, ok := m.rows[storeUUID]
	if !ok {
		return domain.Store{}, contract.ErrNotFound
	}
	return row, nil
}

func (m *memDir) List(context.Context, int64, int64) ([]domain.Store, int64, bool, error) {
	out := make([]domain.Store, 0, len(m.rows))
	for _, row := range m.rows {
		out = append(out, row)
	}
	return out, m.member, m.has, nil
}

func (m *memDir) SaveCompany(_ context.Context, orgID int64, storeUUID string, patch domain.Patch) (domain.Store, error) {
	if orgID <= 0 {
		return domain.Store{}, contract.ErrNoTenant
	}
	row, ok := m.rows[storeUUID]
	if !ok {
		return domain.Store{}, contract.ErrNotFound
	}
	if patch.Short != nil {
		row.ShortName = *patch.Short
		m.seen += *patch.Short
	}
	if patch.Legal != nil {
		row.LegalName = *patch.Legal
		m.seen += *patch.Legal
	}
	if patch.Name != nil {
		row.Name = *patch.Name
		m.seen += *patch.Name
	}
	if patch.Currency != nil {
		row.Currency = *patch.Currency
		m.seen += *patch.Currency
	}
	if patch.Country != nil {
		row.Country = *patch.Country
		m.seen += *patch.Country
	}
	if patch.Premium != nil {
		value := *patch.Premium
		row.Premium = &value
	}
	if patch.SubType != nil {
		row.SubType = *patch.SubType
		m.seen += *patch.SubType
	}
	if patch.KeyStatus != nil {
		row.KeyStatus = *patch.KeyStatus
		m.seen += *patch.KeyStatus
	}
	if patch.KeyReason != nil {
		row.KeyReason = *patch.KeyReason
		m.seen += *patch.KeyReason
	}
	if patch.TouchSynced {
		stamp := time.Unix(1, 0).UTC()
		row.SyncedAt = &stamp
	}
	m.rows[storeUUID] = row
	return row, nil
}

func (m *memDir) Rename(_ context.Context, orgID int64, storeUUID, name string) (domain.Store, error) {
	row, err := m.Load(context.Background(), orgID, storeUUID)
	if err != nil {
		return domain.Store{}, err
	}
	if row.Name == name {
		return row, nil
	}
	row.Name = name
	row.Source = domain.SourceManual
	m.rows[storeUUID] = row
	return row, nil
}
