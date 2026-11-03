package submit

import (
	"bytes"
	"context"
	"encoding/json"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/xxww0098/podhub-go/internal/platform/db"
)

func TestNoteSchemaRevisionProductionRolePreservesRegisteredSnapshot(t *testing.T) {
	fixture, base := draftParityDB(t)
	ctx, cancel := context.WithTimeout(base, time.Minute)
	defer cancel()
	if _, err := fixture.Exec(ctx, `ALTER ROLE podhub_login_api PASSWORD 'normal-submit-login'`); err != nil {
		t.Fatal(err)
	}
	cfg := fixture.Config().Copy()
	cfg.ConnConfig.User, cfg.ConnConfig.Password = "podhub_login_api", "normal-submit-login"
	cfg.MaxConns = 1
	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	var login string
	var privileged bool
	if err := pool.QueryRow(ctx, `SELECT current_user, rolsuper OR rolbypassrls FROM pg_roles WHERE rolname=current_user`).Scan(&login, &privileged); err != nil || login != "podhub_login_api" || privileged {
		t.Fatalf("unexpected login=%s privileged=%v err=%v", login, privileged, err)
	}
	revision := "workflow:sha256:qa-20261027-" + uuid.NewString()
	t.Cleanup(func() {
		if _, err := fixture.Exec(context.Background(), `DELETE FROM listing_schema_revisions WHERE schema_revision=$1`, revision); err != nil {
			t.Errorf("delete exact schema fixture: %v", err)
		}
	})
	const document = `{"label":"原类目","fields":[{"key":"size","attribute_id":"10","editor":"text","required":true,"label":"原尺码","group":"原规格","description":"原描述","raw_type":"String","constraints":{"collection":false,"max_value_count":1},"options":[]},{"key":"color","attribute_id":"20","editor":"single_select","required":false,"label":"原颜色","options":[{"id":"red","value":"红","info":"原选项描述","picture":"https://example.invalid/old.png"},{"id":"blue","value":"蓝"}]}]}`
	makeSnapshot := func(t *testing.T, edit func(map[string]any)) []byte {
		t.Helper()
		var body map[string]any
		if err := json.Unmarshal([]byte(document), &body); err != nil {
			t.Fatal(err)
		}
		body["schema_revision"] = revision
		if edit != nil {
			edit(body)
		}
		raw, err := json.Marshal(body)
		if err != nil {
			t.Fatal(err)
		}
		return raw
	}
	write := func(raw []byte) error {
		return db.InTx(ctx, pool, db.AppRole(), func(tx pgx.Tx) error {
			return noteSchemaRevision(ctx, tx, revision, raw)
		})
	}
	read := func(t *testing.T) []byte {
		t.Helper()
		var raw []byte
		if err := db.InTx(ctx, pool, db.AppRole(), func(tx pgx.Tx) error {
			return tx.QueryRow(ctx, `SELECT snapshot FROM listing_schema_revisions WHERE schema_revision=$1`, revision).Scan(&raw)
		}); err != nil {
			t.Fatal(err)
		}
		var current string
		if err := pool.QueryRow(ctx, `SELECT current_user`).Scan(&current); err != nil || current != login {
			t.Fatalf("transaction role leaked: role=%s err=%v", current, err)
		}
		return raw
	}
	first := makeSnapshot(t, nil)
	if err := write(first); err != nil {
		t.Fatalf("first schema registration: %v", err)
	}
	original := read(t)
	var equal bool
	if err := db.InTx(ctx, pool, db.AppRole(), func(tx pgx.Tx) error {
		return tx.QueryRow(ctx, `SELECT snapshot=$2::jsonb FROM listing_schema_revisions WHERE schema_revision=$1`, revision, first).Scan(&equal)
	}); err != nil || !equal {
		t.Fatalf("first snapshot was not persisted: equal=%v err=%v", equal, err)
	}
	for _, tc := range []struct {
		name     string
		edit     func(map[string]any)
		accepted bool
	}{
		{"display refresh", func(body map[string]any) {
			body["label"] = "新类目"
			fields := body["fields"].([]any)
			field := fields[0].(map[string]any)
			field["label"], field["group"], field["description"], field["raw_type"] = "新尺码", "新规格", "新描述", "Text"
			option := fields[1].(map[string]any)["options"].([]any)[0].(map[string]any)
			option["value"], option["info"], option["picture"] = "新红色", "新选项描述", "https://example.invalid/new.png"
		}, true},
		{"field and option order refresh", func(body map[string]any) {
			fields := body["fields"].([]any)
			options := fields[1].(map[string]any)["options"].([]any)
			options[0], options[1] = options[1], options[0]
			fields[0], fields[1] = fields[1], fields[0]
		}, true},
		{"required changes", func(body map[string]any) {
			body["fields"].([]any)[0].(map[string]any)["required"] = false
		}, false},
		{"constraint changes", func(body map[string]any) {
			body["fields"].([]any)[0].(map[string]any)["constraints"].(map[string]any)["max_value_count"] = 2
		}, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			candidate := makeSnapshot(t, tc.edit)
			if bytes.Equal(candidate, first) {
				t.Fatal("fixture did not change the submitted snapshot")
			}
			err := write(candidate)
			if tc.accepted && err != nil {
				t.Fatalf("presentation-only refresh rejected: %v", err)
			}
			if !tc.accepted && (err == nil || err.Error() != "schema revision content mismatch") {
				t.Fatalf("semantic revision collision not rejected: %v", err)
			}
			if got := read(t); !bytes.Equal(got, original) {
				t.Fatalf("registered snapshot changed: got=%s original=%s", got, original)
			}
		})
	}
}
