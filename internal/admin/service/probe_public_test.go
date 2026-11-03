package service

import (
	"context"
	"errors"
	"testing"

	"github.com/xxww0098/podhub-go/internal/admin/domain"
)

type refuseCatalogue struct{}

func (refuseCatalogue) Fetch(context.Context, string, string, string, bool) (int, []byte, bool, error) {
	return 0, nil, true, errors.New("dns refused")
}

func TestPublicProbeRefusalKeepsValidationMessage(t *testing.T) {
	api := &API{Fetch: refuseCatalogue{}}
	_, fault := api.fetchModels(context.Background(), probeTarget{
		Base: "https://example.com", Format: "chat_completions", Key: "k",
	})
	if fault == nil || fault.Status != 400 || fault.Code != "VALIDATION" || fault.Message != "接口地址不是允许的公网 https 端点" {
		t.Fatalf("%+v", fault)
	}
}

type recordCatalogue struct{ public []bool }

func (c *recordCatalogue) Fetch(_ context.Context, _, _, _ string, allowPublic bool) (int, []byte, bool, error) {
	c.public = append(c.public, allowPublic)
	return 200, []byte(`{"data":[{"id":"m"}]}`), false, nil
}

func sealedSnapshot(t *testing.T, public bool) domain.ConfigBlob {
	t.Helper()
	snap := domain.Snapshot{SchemaVersion: 1, AIAccounts: []domain.StoredAI{}, AIRuntime: domain.DefaultAIRuntime()}
	snap.AIRuntime.AllowPublicEgress = public
	raw, err := snap.Marshal()
	if err != nil {
		t.Fatal(err)
	}
	nonce, cipher, err := domain.Seal(domain.KeySHA256(rewriteKey), []byte(configAAD), raw)
	if err != nil {
		t.Fatal(err)
	}
	return domain.ConfigBlob{Revision: 1, Nonce: nonce, Ciphertext: cipher, Found: true}
}

func TestProbePublicDialFollowsStoredSwitch(t *testing.T) {
	in := ProbeIn{BaseURL: "https://api.example.com/v1", APIKey: "k"}
	for _, tc := range []struct {
		name string
		blob domain.ConfigBlob
		want bool
	}{
		{"no row", domain.ConfigBlob{}, false},
		{"stored off", sealedSnapshot(t, false), false},
		{"stored on", sealedSnapshot(t, true), true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			catalogue := &recordCatalogue{}
			api := &API{DB: &rewriteDB{blob: tc.blob}, IntegrationKey: rewriteKey, Fetch: catalogue}
			if _, fault := api.ListModels(context.Background(), in); fault != nil {
				t.Fatal(fault)
			}
			if len(catalogue.public) != 1 || catalogue.public[0] != tc.want {
				t.Fatalf("allowPublic %v, want %v", catalogue.public, tc.want)
			}
		})
	}
	api := &API{DB: &rewriteDB{blob: domain.ConfigBlob{Found: true, Nonce: []byte("short")}}, IntegrationKey: rewriteKey, Fetch: &recordCatalogue{}}
	if _, fault := api.ListModels(context.Background(), in); fault == nil || fault.Status != 503 {
		t.Fatalf("an unreadable stored configuration must fail the probe closed: %+v", fault)
	}
}
