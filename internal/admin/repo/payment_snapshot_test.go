package adminrepo

import (
	"encoding/json"
	"testing"

	"github.com/xxww0098/podhub-go/internal/admin/domain"
	platformseal "github.com/xxww0098/podhub-go/internal/platform/seal"
)

func TestPaymentReadsAdminCamelAndRewrittenSnake(t *testing.T) {
	payment := &platformseal.StoredPaymentConfig{Providers: []platformseal.StoredPaymentProvider{{
		Provider: "manual", Enabled: true, Values: map[string]string{"appId": "kept"},
	}}}
	snap := domain.Snapshot{
		SchemaVersion:  1,
		AIAccounts:     []domain.StoredAI{},
		AIDefaultModel: "",
		Buckets: []domain.StoredBucket{{
			ID: "media", Label: "m", Role: "assets", Provider: "generic", Endpoint: "https://s3.example",
			Region: "auto", Bucket: "podhub-assets", KeyPrefix: "p", PublicBase: "https://assets.podhub.si",
			ForcePath: true, AccessKey: "ak", SecretKey: "sk", Active: true,
		}},
		Payment: payment,
	}
	camel, err := json.Marshal(snap)
	if err != nil {
		t.Fatal(err)
	}
	doc, _, err := domain.ParseStored(camel)
	if err != nil || doc.SchemaVersion != 1 || doc.Payment == nil || len(doc.Payment.Providers) != 1 || doc.Payment.Providers[0].Values["appId"] != "kept" || !doc.Payment.Providers[0].Enabled {
		t.Fatalf("camel payment %+v %v", doc.Payment, err)
	}
	snake := []byte(`{"schema_version":1,"ai_default_model":"","ai_accounts":[],"media_accounts":[{"id":"media","label":"m","provider":"generic","endpoint":"https://s3.example","region":"auto","bucket":"b","key_prefix":"p","public_base_url":"https://cdn.example","force_path_style":true,"access_key_id":"ak","secret_access_key":"sk","session_token":"","active":true}],"payment":{"providers":[{"provider":"manual","enabled":true,"values":{"appId":"kept"}}]}}`)
	old, legacy, err := domain.ParseStored(snake)
	if err != nil || !legacy {
		t.Fatalf("snake %v %v", legacy, err)
	}
	rewritten, err := json.Marshal(old)
	if err != nil {
		t.Fatal(err)
	}
	doc, legacy, err = domain.ParseStored(rewritten)
	if err != nil || legacy || doc.Payment == nil || doc.Payment.Providers[0].Values["appId"] != "kept" {
		t.Fatalf("rewritten payment %+v %v", doc.Payment, err)
	}
	slots := slotsOf(doc.Payment)
	if len(slots) != 1 || slots[0].Provider != "manual" || slots[0].Values["appId"] != "kept" {
		t.Fatalf("slots %+v", slots)
	}
	if _, _, err := domain.ParseStored([]byte(`{"schemaVersion":1,"aiAccounts":[],"aiDefaultModel":"","storageBuckets":[],"payment":{}}`)); err == nil {
		t.Fatal("payment without providers")
	}
	bare, legacy, err := domain.ParseStored([]byte(`{"schemaVersion":1,"aiAccounts":[],"aiDefaultModel":"","storageBuckets":[]}`))
	if err != nil || legacy || bare.Payment != nil {
		t.Fatalf("missing payment legacy=%v err=%v %+v", legacy, err, bare.Payment)
	}
	if slots := slotsOf(bare.Payment); len(slots) != 5 || slots[0].Provider != "easypay" {
		t.Fatalf("nil payment view %+v", slots)
	}
}
