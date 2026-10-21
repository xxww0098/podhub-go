package submit

import (
	"context"
	"encoding/json"
	"errors"
	"reflect"
	"testing"

	"github.com/jackc/pgx/v5"
)

func TestGateSchemaAcceptedRevisionsAvoidHistoryReads(t *testing.T) {
	loaded := loadedSchema{
		current: "workflow:sha256:current",
		legacy:  "workflow:sha256:legacy",
		after:   []schemaField{{Key: "brand", Required: true}},
	}
	for _, revision := range []string{loaded.current, loaded.legacy} {
		t.Run(revision, func(t *testing.T) {
			tx := &schemaHistoryTx{err: errors.New("unexpected history read")}
			raw := []byte(`{"schemaRevision":"` + revision + `","draft":{"values":{"price":{"kind":"decimal","value":"19.90"}}}}`)
			got, blocked, record, err := gateSchema(context.Background(), tx, raw, loaded)
			if err != nil || blocked != nil || record {
				t.Fatalf("gate result: blocked=%+v record=%v err=%v", blocked, record, err)
			}
			if tx.reads != 0 {
				t.Fatalf("matching schema performed %d history reads", tx.reads)
			}
			if draftRevision(got) != loaded.current {
				t.Fatalf("revision was not canonicalized: %s", got)
			}
			var before, after map[string]json.RawMessage
			if err := json.Unmarshal(raw, &before); err != nil {
				t.Fatal(err)
			}
			if err := json.Unmarshal(got, &after); err != nil {
				t.Fatal(err)
			}
			delete(before, "schemaRevision")
			delete(after, "schemaRevision")
			if !reflect.DeepEqual(before, after) {
				t.Fatalf("non-revision fields changed: before=%s after=%s", raw, got)
			}
		})
	}
}

func TestGateSchemaChangedRevisionStillReadsHistory(t *testing.T) {
	loaded := loadedSchema{
		current: "workflow:sha256:current",
		legacy:  "workflow:sha256:legacy",
		after:   []schemaField{{Key: "brand", Required: true}},
	}
	tx := &schemaHistoryTx{snapshot: []byte(`{"fields":[{"key":"brand","required":false}]}`)}
	raw := []byte(`{"schemaRevision":"workflow:sha256:old","draft":{"values":{}}}`)
	_, blocked, record, err := gateSchema(context.Background(), tx, raw, loaded)
	if err != nil || blocked == nil || !record || tx.reads != 1 {
		t.Fatalf("gate result: blocked=%+v record=%v reads=%d err=%v", blocked, record, tx.reads, err)
	}
	if blocked.SkipReason != "schema_stale" || !reflect.DeepEqual(blocked.Fields, []string{"brand"}) {
		t.Fatalf("missing required field was not blocked: %+v", blocked)
	}
}

// Only QueryRow is implemented: these tests exercise schema history access,
// not PostgreSQL or the WASM validation contract.
type schemaHistoryTx struct {
	pgx.Tx
	reads    int
	snapshot []byte
	err      error
}

func (tx *schemaHistoryTx) QueryRow(context.Context, string, ...any) pgx.Row {
	tx.reads++
	return schemaHistoryRow{snapshot: tx.snapshot, err: tx.err}
}

type schemaHistoryRow struct {
	snapshot []byte
	err      error
}

func (row schemaHistoryRow) Scan(dest ...any) error {
	if row.err != nil {
		return row.err
	}
	*dest[0].(*[]byte) = append([]byte(nil), row.snapshot...)
	return nil
}
