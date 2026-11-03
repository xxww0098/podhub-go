package app

import (
	"context"
	"encoding/json"
	"reflect"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	configdoc "github.com/xxww0098/podhub-go/internal/admin/core/contract"
	"github.com/xxww0098/podhub-go/internal/ai"
	aicontract "github.com/xxww0098/podhub-go/internal/ai/contract"
	"github.com/xxww0098/podhub-go/internal/listing/rules"
	"github.com/xxww0098/podhub-go/internal/platform/config"
	"github.com/xxww0098/podhub-go/internal/platform/db"
	"github.com/xxww0098/podhub-go/internal/platform/seal"
	"github.com/xxww0098/podhub-go/tests/testkit"
)

const snapshotTestKey = "app-ai-snapshot-test-key-at-least-32-bytes"

func snapshotPool(t *testing.T) (context.Context, *pgxpool.Pool) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	t.Cleanup(cancel)
	dsn, cleanup, err := testkit.StartPostgres(ctx)
	if err != nil {
		t.Skipf("postgres unavailable: %v", err)
	}
	t.Cleanup(cleanup)
	pool, err := pgxpool.New(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	if err := db.Migrate(ctx, pool); err != nil {
		t.Fatal(err)
	}
	return ctx, pool
}

func storeSnapshot(t *testing.T, ctx context.Context, pool *pgxpool.Pool, plain []byte) {
	t.Helper()
	kek, err := seal.IntegrationKEK(snapshotTestKey)
	if err != nil {
		t.Fatal(err)
	}
	nonce, ciphertext, err := seal.SealBlob(kek, seal.SnapshotAAD, plain)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `DELETE FROM platform_integration_config`); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO platform_integration_config(singleton,revision,nonce,ciphertext,updated_at_ms,updated_by_account_uuid) VALUES(true,1,$1,$2,1,'test')`, nonce, ciphertext); err != nil {
		t.Fatal(err)
	}
}

func TestAILimitsComeFromTheStoredSnapshot(t *testing.T) {
	ctx, pool := snapshotPool(t)
	cfg := config.Config{IntegrationConfigKey: snapshotTestKey}
	limits := aiLimits(pool, cfg)

	got, err := limits(ctx)
	if err != nil || got != (ai.Limits{LeaseTTL: 90 * time.Second}) {
		t.Fatalf("no row must mean every ceiling off with the default lease: %+v %v", got, err)
	}

	runtime := configdoc.AIRuntime{MaxConcurrencyGlobal: 8, MaxConcurrencyUser: 2, MaxConcurrencyAccount: 4, UserRatePerMinute: 30, LeaseTTLSeconds: 120}
	raw, err := configdoc.Snapshot{SchemaVersion: 1, AIAccounts: []configdoc.StoredAI{}, AIRuntime: runtime}.Marshal()
	if err != nil {
		t.Fatal(err)
	}
	storeSnapshot(t, ctx, pool, raw)
	got, err = limits(ctx)
	if want := (ai.Limits{Global: 8, User: 2, Account: 4, PerMinute: 30, LeaseTTL: 120 * time.Second}); err != nil || got != want {
		t.Fatalf("stored runtime: %+v %v", got, err)
	}

	// A document written before aiRuntime existed reads as the defaults.
	storeSnapshot(t, ctx, pool, []byte(`{"schemaVersion":1,"aiAccounts":[],"aiDefaultModel":"","storageBuckets":[]}`))
	got, err = limits(ctx)
	if err != nil || got != (ai.Limits{LeaseTTL: 90 * time.Second}) {
		t.Fatalf("legacy document: %+v %v", got, err)
	}

	// A present row that cannot be opened fails closed.
	if _, err := pool.Exec(ctx, `UPDATE platform_integration_config SET ciphertext='\x00112233445566778899aabbccddeeff'::bytea`); err != nil {
		t.Fatal(err)
	}
	if _, err := limits(ctx); err == nil {
		t.Fatal("an undecryptable row must fail closed, not fall back to defaults")
	}
	if _, err := aiLimits(pool, config.Config{IntegrationConfigKey: "short"})(ctx); err == nil {
		t.Fatal("a missing integration key must fail closed")
	}
}

func TestOCRRuntimeSelectsAccountsByPurpose(t *testing.T) {
	ctx, pool := snapshotPool(t)
	cfg := config.Config{IntegrationConfigKey: snapshotTestKey}
	account := func(id, model, purpose string) configdoc.StoredAI {
		return configdoc.StoredAI{ID: id, Label: id, BaseURL: "https://ai.example/v1", APIFormat: "chat_completions", Model: model, APIKey: "k", Active: true, Purpose: purpose}
	}
	raw, err := configdoc.Snapshot{
		SchemaVersion: 1, AIDefaultModel: "ocr-model", AIRuntime: configdoc.DefaultAIRuntime(),
		AIAccounts: []configdoc.StoredAI{
			account("ocr", "ocr-model", configdoc.PurposeOCR),
			// An image-purpose account never serves recognition, whatever its model.
			account("img-chat", "image-chat-model", configdoc.PurposeImage),
			// A model named like the image model but marked OCR is a recognition account.
			account("odd", imageModel, configdoc.PurposeOCR),
		},
	}.Marshal()
	if err != nil {
		t.Fatal(err)
	}
	storeSnapshot(t, ctx, pool, raw)
	runtime := newOCRRuntime(pool, cfg)
	models, preferred, err := runtime.Models(ctx)
	if err != nil || len(models) != 2 || models[0] != "ocr-model" || models[1] != imageModel || preferred != "ocr-model" {
		t.Fatalf("ocr models %v preferred %q err %v", models, preferred, err)
	}
	if _, err := runtime.Resolve(ctx, aicontract.Routing{Primary: "image-chat-model"}); err == nil {
		t.Fatal("recognition resolved an image-purpose account")
	}
	provider, err := runtime.Resolve(ctx, aicontract.Routing{Primary: "ocr-model"})
	if err != nil || provider.AccountID != "ocr" {
		t.Fatalf("resolve %+v %v", provider, err)
	}

}

func TestOCRRuntimeFiltersCurrentGlobalTags(t *testing.T) {
	ctx, pool := snapshotPool(t)
	bindListingCore()
	rules.InvalidateBannedTags()
	t.Cleanup(rules.InvalidateBannedTags)
	runtime := newOCRRuntime(pool, config.Config{})
	pin := aicontract.Pin{Prompt: aicontract.Prompt{Content: `{"product_type_ru":"Кружка","facts_ru":"330 мл"}`, FixedTags: []string{"#кружка", "#табачный"}}}
	content, _ := json.Marshal(map[string]any{"state": "clear", "theme_ru": "Кот с вейпом", "description_ru": "На рисунке кот сидит рядом с вейпом на столе. На заднем плане видны листья и цветы в тёплых тонах.", "tags": []string{"#кот_с_вейпом", "#вейп", "#вейпинг", "#дым_вейпа", "#табачный_дым"}})
	completion, _ := json.Marshal(map[string]any{"choices": []any{map[string]any{"message": map[string]string{"content": string(content)}}}})
	for _, want := range [][]string{{"#кружка"}, {}} {
		raw, err := runtime.Validate(ctx, pin, completion)
		if err != nil {
			t.Fatal(err)
		}
		var answer aicontract.Answer
		if json.Unmarshal(raw, &answer) != nil || !reflect.DeepEqual(answer.Tags, want) {
			t.Fatalf("runtime did not filter global tags: %s; want %v", raw, want)
		}
		if len(want) > 0 {
			if _, err := pool.Exec(ctx, `INSERT INTO banned_tags(term,match_mode,note,created_by) VALUES('кружка','exact','','test')`); err != nil {
				t.Fatal(err)
			}
			rules.InvalidateBannedTags()
		}
	}
}

func TestImageAccountSelectionUsesPurposeAndModel(t *testing.T) {
	account := func(id, model, purpose string) configdoc.StoredAI {
		return configdoc.StoredAI{ID: id, Model: model, APIKey: "k", Active: true, Purpose: purpose}
	}
	image := account("img", imageModel, configdoc.PurposeImage)
	inactive := image
	inactive.Active = false
	for _, tc := range []struct {
		name string
		rows []configdoc.StoredAI
		want string
		id   string
	}{
		{"image account beside an ocr one", []configdoc.StoredAI{account("ocr", "ocr-model", configdoc.PurposeOCR), image}, "", "img"},
		{"ocr purpose with the image model name", []configdoc.StoredAI{account("odd", imageModel, configdoc.PurposeOCR)}, "image model not configured", ""},
		{"image purpose with another model", []configdoc.StoredAI{account("other", "other-image", configdoc.PurposeImage)}, "image model not configured", ""},
		{"inactive", []configdoc.StoredAI{inactive}, "image model not configured", ""},
		{"ambiguous", []configdoc.StoredAI{image, account("img2", imageModel, configdoc.PurposeImage)}, "ambiguous image account", ""},
	} {
		got, err := selectImageAccount(configdoc.Snapshot{AIAccounts: tc.rows})
		if tc.want == "" {
			if err != nil || got.ID != tc.id {
				t.Fatalf("%s: %+v %v", tc.name, got, err)
			}
			continue
		}
		if err == nil || err.Error() != tc.want {
			t.Fatalf("%s: %v", tc.name, err)
		}
	}
}
