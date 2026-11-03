package cataloghttp

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"

	"github.com/jackc/pgx/v5"
	catalogcontract "github.com/xxww0098/podhub-go/internal/catalog/contract"
	"github.com/xxww0098/podhub-go/internal/catalog/domain"
	"github.com/xxww0098/podhub-go/internal/catalog/service"
	access "github.com/xxww0098/podhub-go/internal/identity/contract"
	"github.com/xxww0098/podhub-go/internal/platform/writer"
)

func (h Host) runFetch(w http.ResponseWriter, r *http.Request) {
	actor, ok := h.account(w, r)
	if !ok {
		return
	}
	if status, message, allowed := access.SuperAdmin(actor); !allowed {
		writeErr(w, status, message, "forbidden")
		return
	}
	if _, err := h.Fetcher.Start(r.Context(), true); err != nil {
		switch {
		case errors.Is(err, service.ErrNoFetchKey):
			writeErr(w, 400, "请先配置可用的类目密钥", "validation")
		case errors.Is(err, service.ErrFetchRunning):
			writeErr(w, 409, "类目抓取正在执行", "conflict")
		case writer.IsDisabled(err):
			writeErr(w, 503, "类目抓取写入未启用", "writes_disabled")
		default:
			writeErr(w, 503, "类目抓取暂不可用", "unavailable")
		}
		return
	}
	h.fetchConfig(w, r)
}

// Refresh downloads and stores the Ozon category tree. Category field schemas
// and dictionary values are not part of the scheduled run: they are loaded
// from the upstream on demand when a category is opened to create a product or
// add fields. This keeps one run to a single upstream request.
func (h Host) Refresh(ctx context.Context, claim service.FetchClaim) (service.FetchResult, error) {
	h.fetchLease = &claim
	result := service.FetchResult{}
	keys, err := h.platformKeys(ctx)
	if err != nil {
		return result, err
	}
	available := keys[:0]
	for _, key := range keys {
		if key.clientID != "" && key.apiKey != "" {
			available = append(available, key)
		}
	}
	keys = available
	if len(keys) == 0 {
		return result, service.ErrNoFetchKey
	}
	seen := map[string]bool{}
	preferred := 0
	try := func(work func(platformKey) error) error {
		var last error
		for i := range keys {
			index := (preferred + i) % len(keys)
			key := keys[index]
			if !seen[key.clientID] {
				seen[key.clientID] = true
				result.KeyAttempts++
			}
			if err := ctx.Err(); err != nil {
				return err
			}
			if err := work(key); err == nil {
				preferred = index
				result.ClientID = key.clientID
				return nil
			} else {
				last = err
			}
		}
		return last
	}
	err = try(func(key platformKey) error {
		input := map[string]string{"language": ozonLanguage(domain.FetchLanguage)}
		body, _ := json.Marshal(input)
		status, raw, err := h.post(ctx, "/v1/description-category/tree", body, key.clientID, key.apiKey)
		if err != nil {
			return err
		}
		if status != 200 {
			return errors.New("catalog tree upstream refused")
		}
		nodes, err := cacheNodes(raw)
		if err != nil || len(nodes) == 0 {
			return errors.New("catalog tree invalid")
		}
		plain, err := json.Marshal(nodes)
		if err != nil {
			return err
		}
		gz, err := gzipBytes(plain)
		if err != nil {
			return err
		}
		_, err = h.exec(ctx, `INSERT INTO ozon_catalog_tree_cache(language,payload,fetched_at_ms,byte_size,updated_at) VALUES($1,$2,$3,$4,clock_timestamp()) ON CONFLICT(language) DO UPDATE SET payload=EXCLUDED.payload,fetched_at_ms=EXCLUDED.fetched_at_ms,byte_size=EXCLUDED.byte_size,updated_at=clock_timestamp()`, domain.FetchLanguage, gz, h.Now().UnixMilli(), len(gz))
		if err == nil {
			result.RootNodes = len(nodes)
		}
		return err
	})
	if err != nil {
		return result, err
	}
	return result, nil
}

func (h Host) snapshotFields(ctx context.Context, category, typeID int64, fields json.RawMessage) ([]byte, string, error) {
	if h.Snapshot == nil {
		return nil, "", service.ErrFetchUnavailable
	}
	input, err := json.Marshal(struct {
		Category int64           `json:"description_category_id"`
		TypeID   int64           `json:"type_id"`
		Fields   json.RawMessage `json:"fields"`
	}{category, typeID, fields})
	if err != nil {
		return nil, "", err
	}
	snapshot, err := h.Snapshot(ctx, input)
	var version struct {
		Revision string `json:"schema_revision"`
	}
	if err != nil {
		return nil, "", err
	}
	if json.Unmarshal(snapshot, &version) != nil || version.Revision == "" {
		return nil, "", errors.New("catalog snapshot invalid")
	}
	return snapshot, version.Revision, nil
}

func putSnapshot(ctx context.Context, tx pgx.Tx, snapshot []byte, revision string) error {
	if _, err := tx.Exec(ctx, `INSERT INTO listing_schema_revisions(schema_revision,snapshot) VALUES($1,$2::jsonb) ON CONFLICT(schema_revision) DO NOTHING`, revision, string(snapshot)); err != nil {
		return err
	}
	var registered []byte
	if err := tx.QueryRow(ctx, `SELECT snapshot FROM listing_schema_revisions WHERE schema_revision=$1`, revision).Scan(&registered); err != nil {
		return err
	}
	if !catalogcontract.SameSnapshot(registered, snapshot) {
		return errors.New("catalog snapshot revision content mismatch")
	}
	return nil
}

func (h Host) persistFetchedFields(ctx context.Context, category, typeID int64, language string, fields json.RawMessage, now int64) (string, error) {
	if _, err := domain.FieldsFromCache(fields); err != nil {
		return "", err
	}
	snapshot, revision, err := h.snapshotFields(ctx, category, typeID, fields)
	if err != nil {
		return "", err
	}
	sum := sha256.Sum256(fields)
	digest := "sha256:" + hex.EncodeToString(sum[:])
	err = h.readIn(ctx, func(tx pgx.Tx) error {
		if _, err := tx.Exec(ctx, `INSERT INTO ozon_category_current(description_category_id,type_id,language,fields,content_digest,fetched_at_ms,schema_revision) VALUES($1,$2,$3,$4::jsonb,$5,$6,$7) ON CONFLICT(description_category_id,type_id,language) DO UPDATE SET fields=EXCLUDED.fields,content_digest=EXCLUDED.content_digest,fetched_at_ms=EXCLUDED.fetched_at_ms,schema_revision=EXCLUDED.schema_revision,updated_at=clock_timestamp()`, category, typeID, language, string(fields), digest, now, revision); err != nil {
			return err
		}
		return putSnapshot(ctx, tx, snapshot, revision)
	})
	if err != nil {
		return "", err
	}
	return revision, nil
}
