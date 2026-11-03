package service

import (
	"bytes"
	"context"
	"encoding/json"
	"testing"
	"time"

	"github.com/xxww0098/podhub-go/internal/admin/contract"
	"github.com/xxww0098/podhub-go/internal/admin/domain"
	"github.com/xxww0098/podhub-go/internal/platform/seal"
)

const rewriteKey = "integration-config-test-key-at-least-32-bytes"

func TestReadSnapshotRewritesSnakeAndLeavesCamel(t *testing.T) {
	snake := []byte(`{"schema_version":1,"ai_default_model":"m","ai_accounts":[{"id":"ai","label":"L","base_url":"https://ai.example","api_format":"chat_completions","model":"m","api_key":"secret","active":true,"thinking":"provider_default","thinking_format":"none","priority":2}],"media_accounts":[],"delegate_assets_storage":{"id":"delegate","label":"d","provider":"cloudflare","endpoint":"https://example.r2.cloudflarestorage.com","region":"auto","bucket":"delegate-assets","key_prefix":"","public_base_url":"","force_path_style":true,"access_key_id":"AKIA","secret_access_key":"secret","session_token":"","active":true}}`)
	key := domain.KeySHA256(rewriteKey)
	nonce, cipher, err := domain.Seal(key, []byte(configAAD), snake)
	if err != nil {
		t.Fatal(err)
	}
	db := &rewriteDB{blob: domain.ConfigBlob{Revision: 7, Nonce: nonce, Ciphertext: cipher, Found: true}}
	api := &API{DB: db, IntegrationKey: rewriteKey}
	snap, fault := api.readSnapshot(context.Background(), false)
	if fault != nil {
		t.Fatal(fault.Message)
	}
	if db.calls != 1 || db.revision != 7 {
		t.Fatalf("rewrite calls=%d revision=%d", db.calls, db.revision)
	}
	plain, err := domain.Open(key, []byte(configAAD), db.nonce, db.cipher)
	if err != nil {
		t.Fatal(err)
	}
	_, err = seal.ParseSnapshot(plain)
	if err != nil || bytes.Contains(plain, []byte("storageBuckets")) || bytes.Contains(plain, []byte("AKIA")) {
		t.Fatalf("legacy rewrite retained storage settings: %v", err)
	}
	if snap.AIAccounts[0].APIKey != "secret" || snap.AIAccounts[0].BaseURL != "https://ai.example" {
		t.Fatalf("memory %+v", snap)
	}
	again, legacy, err := domain.ParseStored(plain)
	if err != nil || legacy {
		t.Fatalf("rewritten still legacy=%v %v", legacy, err)
	}
	_ = again

	camel, err := json.Marshal(snap)
	if err != nil {
		t.Fatal(err)
	}
	nonce, cipher, err = domain.Seal(key, []byte(configAAD), camel)
	if err != nil {
		t.Fatal(err)
	}
	db.calls = 0
	db.blob = domain.ConfigBlob{Revision: 8, Nonce: nonce, Ciphertext: cipher, Found: true}
	if _, fault = api.readSnapshot(context.Background(), false); fault != nil {
		t.Fatal(fault.Message)
	}
	if db.calls != 0 {
		t.Fatalf("camel row was rewritten %d times", db.calls)
	}
}

func TestReadSnapshotRemovesRetiredStorageWithoutChangingConfiguration(t *testing.T) {
	want, err := json.Marshal(domain.Snapshot{
		SchemaVersion: 1, AIDefaultModel: "m",
		AIAccounts: []domain.StoredAI{{ID: "a", Model: "m", APIKey: "ai-secret", Purpose: domain.PurposeOCR}},
		AIRuntime:  domain.AIRuntime{MaxConcurrencyGlobal: 8, LeaseTTLSeconds: 120, AllowPublicEgress: true},
		Payment: &seal.StoredPaymentConfig{Providers: []seal.StoredPaymentProvider{{
			Provider: "manual", Enabled: true, Values: map[string]string{"appId": "kept"},
		}}},
	})
	if err != nil {
		t.Fatal(err)
	}
	raw := append(append([]byte(nil), want[:len(want)-1]...), []byte(`,"storageBuckets":[{"secretAccessKey":"retired-secret"}]}`)...)
	key := domain.KeySHA256(rewriteKey)
	nonce, ciphertext, err := domain.Seal(key, []byte(configAAD), raw)
	if err != nil {
		t.Fatal(err)
	}
	db := &rewriteDB{blob: domain.ConfigBlob{Revision: 7, Nonce: nonce, Ciphertext: ciphertext, Found: true}}
	api := &API{DB: db, IntegrationKey: rewriteKey}
	if _, fault := api.readSnapshot(context.Background(), false); fault != nil {
		t.Fatal(fault)
	}
	if db.calls != 1 || db.revision != 7 {
		t.Fatalf("cleanup calls=%d revision=%d", db.calls, db.revision)
	}
	clean, err := domain.Open(key, []byte(configAAD), db.nonce, db.cipher)
	if err != nil || !bytes.Equal(clean, want) {
		t.Fatalf("cleanup changed AI or payment configuration: %s %v", clean, err)
	}
}

type rewriteDB struct {
	panicDB
	blob     domain.ConfigBlob
	nonce    []byte
	cipher   []byte
	revision int64
	calls    int
}

func (d *rewriteDB) LoadConfig(context.Context) (domain.ConfigBlob, *contract.Fault) {
	return d.blob, nil
}

func (d *rewriteDB) RewriteSnapshot(_ context.Context, revision int64, nonce, cipher []byte) *contract.Fault {
	d.calls++
	d.revision = revision
	d.nonce = append([]byte(nil), nonce...)
	d.cipher = append([]byte(nil), cipher...)
	return nil
}

type panicDB struct{}

func (panicDB) Standing(context.Context, string, int64) (bool, bool, *contract.Fault) {
	panic("Standing")
}
func (panicDB) ListDirectory(context.Context, domain.Actor) (domain.Directory, *contract.Fault) {
	panic("ListDirectory")
}
func (panicDB) ReadAccount(context.Context, string) (domain.Account, *contract.Fault) {
	panic("ReadAccount")
}
func (panicDB) CreateUser(context.Context, domain.Actor, string, string, string, string, string) (domain.Account, int64, *contract.Fault) {
	panic("CreateUser")
}
func (panicDB) SetStatus(context.Context, domain.Actor, string, bool, string) (domain.Account, *contract.Fault) {
	panic("SetStatus")
}
func (panicDB) SetRole(context.Context, domain.Actor, string, string, string) (domain.Account, *contract.Fault) {
	panic("SetRole")
}
func (panicDB) SetPassword(context.Context, domain.Actor, string, string, string, bool) (int64, *contract.Fault) {
	panic("SetPassword")
}
func (panicDB) SetSeats(context.Context, domain.Actor, string, string, *int64) (domain.Account, *contract.Fault) {
	panic("SetSeats")
}
func (panicDB) Dissolve(context.Context, domain.Actor, string, string, string) *contract.Fault {
	panic("Dissolve")
}
func (panicDB) ListGrants(context.Context, domain.Actor, *int64) ([]domain.Grant, *contract.Fault) {
	panic("ListGrants")
}
func (panicDB) IssueGrant(context.Context, domain.Actor, domain.GrantRequest, time.Time) (domain.Grant, *contract.Fault) {
	panic("IssueGrant")
}
func (panicDB) RevokeGrant(context.Context, domain.Actor, int64, string) (bool, *contract.Fault) {
	panic("RevokeGrant")
}
func (panicDB) LeaseStatus(context.Context, domain.Actor) ([]domain.LeaseRow, []bool, *contract.Fault) {
	panic("LeaseStatus")
}
func (panicDB) GrantLease(context.Context, domain.Actor, string, string, string, string, *int64) (domain.LeaseRow, *contract.Fault) {
	panic("GrantLease")
}
func (panicDB) RevokeLease(context.Context, domain.Actor, string, string, *int64) (*domain.LeaseRow, *contract.Fault) {
	panic("RevokeLease")
}
func (panicDB) ListUsage(context.Context, int64, domain.UsageFilter, int64, int64) (int64, []domain.UsageRow, *contract.Fault) {
	panic("ListUsage")
}
func (panicDB) SummarizeUsage(context.Context, int64, domain.UsageFilter) (domain.UsageSummary, *contract.Fault) {
	panic("SummarizeUsage")
}
func (panicDB) PublishPrice(context.Context, domain.Actor, string, domain.Price) ([]domain.PriceRow, *contract.Fault) {
	panic("PublishPrice")
}
func (panicDB) UnpublishPrice(context.Context, domain.Actor, string) (bool, []domain.PriceRow, *contract.Fault) {
	panic("UnpublishPrice")
}
func (panicDB) LoadConfig(context.Context) (domain.ConfigBlob, *contract.Fault) {
	panic("LoadConfig")
}
func (panicDB) SaveConfig(context.Context, domain.Actor, int64, int64, []byte, []byte, int) *contract.Fault {
	panic("SaveConfig")
}
func (panicDB) RewriteSnapshot(context.Context, int64, []byte, []byte) *contract.Fault {
	panic("RewriteSnapshot")
}
func (panicDB) CurrentPrices(context.Context) ([]domain.PriceRow, *contract.Fault) {
	panic("CurrentPrices")
}
