package integration

import (
	"context"
	"encoding/json"
	"errors"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	configdoc "github.com/xxww0098/podhub-go/internal/admin/core/contract"
	"github.com/xxww0098/podhub-go/internal/platform/seal"
)

const r2FixtureKey = "integration-test-system-storage-key-32-bytes"

func setR2StorageAccount(t *testing.T, pool *pgxpool.Pool, account configdoc.StoredStorage) {
	t.Helper()
	t.Setenv("CLOUD_INTEGRATION_CONFIG_KEY", r2FixtureKey)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	kek, err := seal.IntegrationKEK(r2FixtureKey)
	if err != nil {
		t.Fatal(err)
	}
	snapshot := configdoc.Snapshot{SchemaVersion: 1, AIAccounts: []configdoc.StoredAI{}, AIRuntime: configdoc.DefaultAIRuntime()}
	var nonce, ciphertext []byte
	err = pool.QueryRow(ctx, `SELECT nonce,ciphertext FROM platform_integration_config WHERE singleton`).Scan(&nonce, &ciphertext)
	if err == nil {
		plain, err := seal.OpenIntegration(kek, nonce, ciphertext)
		if err != nil {
			t.Fatal(err)
		}
		snapshot, _, err = configdoc.ParseStored(plain)
		if err != nil {
			t.Fatal(err)
		}
	} else if !errors.Is(err, pgx.ErrNoRows) {
		t.Fatal(err)
	}
	rows := make([]configdoc.StoredStorage, 0, 2)
	for _, row := range snapshot.SystemStorage {
		if row.Role != account.Role {
			rows = append(rows, row)
		}
	}
	if account.Endpoint != "" {
		rows = append(rows, account)
	}
	snapshot.SystemStorage = rows
	plain, err := json.Marshal(snapshot)
	if err != nil {
		t.Fatal(err)
	}
	nonce, ciphertext, err = seal.SealBlob(kek, seal.SnapshotAAD, plain)
	if err != nil {
		t.Fatal(err)
	}
	_, err = pool.Exec(ctx, `INSERT INTO platform_integration_config(singleton,revision,nonce,ciphertext,updated_at_ms,updated_by_account_uuid)
VALUES(true,1,$1,$2,1,'test') ON CONFLICT(singleton) DO UPDATE SET revision=platform_integration_config.revision+1,nonce=$1,ciphertext=$2`, nonce, ciphertext)
	if err != nil {
		t.Fatal(err)
	}
}
