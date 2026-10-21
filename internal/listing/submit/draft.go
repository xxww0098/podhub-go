package submit

import (
	"bytes"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/xxww0098/podhub-go/internal/listing/core/contract"
	tenant "github.com/xxww0098/podhub-go/internal/platform/db/tenantx"
	queue "github.com/xxww0098/podhub-go/internal/platform/jobsched"
)

const schemaTTLMS = int64(24 * time.Hour / time.Millisecond)

// Status is an HTTP refusal the three send routes share.
type Status struct {
	Code    int
	Message string
	Kind    string
}

func (s Status) Error() string { return s.Message }

func statusErr(code int, message, kind string) error {
	return Status{Code: code, Message: message, Kind: kind}
}

// DraftData is SubmitListingDraftsData. Field order is the Rust struct.
// AcceptedSchemaRevisions is the server rule for this cache payload: the
// order-independent revision, and the legacy order-sensitive revision when
// it differs. A row matching either is unchanged. The browser only displays
// this list; it does not refuse on its own.
type DraftData struct {
	ServerSchemaRevision    string      `json:"serverSchemaRevision"`
	AcceptedSchemaRevisions []string    `json:"acceptedSchemaRevisions,omitempty"`
	Items                   []DraftItem `json:"items"`
}

// DraftItem is one SubmitListingDraftItemResult. Empty lists and nil
// options are omitted, matching skip_serializing_if.
type DraftItem struct {
	RowID      string          `json:"rowId"`
	Outcome    string          `json:"outcome"`
	SkipReason string          `json:"skipReason,omitempty"`
	Issues     json.RawMessage `json:"issues,omitempty"`
	Blockers   json.RawMessage `json:"blockers,omitempty"`
	Detail     string          `json:"detail,omitempty"`
	Fields     []string        `json:"fields,omitempty"`
	Intent     *IntentView     `json:"intent,omitempty"`
}

// IntentView is the empty-history ListingIntentView a fresh queued intent
// serializes to. Derived facts that are None stay omitted.
type IntentView struct {
	SubmissionIssues        []struct{} `json:"submissionIssues"`
	CurrentIssueStatus      string     `json:"currentIssueStatus"`
	CanResume               bool       `json:"canResume"`
	ID                      string     `json:"id"`
	StoreID                 string     `json:"storeId"`
	ListingRowID            string     `json:"listingRowId"`
	RowRevision             int64      `json:"rowRevision"`
	ClientOperationID       string     `json:"clientOperationId"`
	State                   string     `json:"state"`
	SubmissionReceiptStatus string     `json:"submissionReceiptStatus"`
	UpdatedAtMS             int64      `json:"updatedAtMs"`
}

// BatchData is SubmitListingBatchData.
type BatchData struct {
	Items []BatchItem `json:"items"`
}

// BatchItem is one stored-row send result. The row projection is omitted:
// ListingRowView is not produced here.
type BatchItem struct {
	RowID   string      `json:"rowId"`
	Intent  *IntentView `json:"intent,omitempty"`
	Created bool        `json:"created"`
	Skipped string      `json:"skipped,omitempty"`
	Detail  string      `json:"detail,omitempty"`
	Fields  []string    `json:"fields,omitempty"`
}

// SendDrafts is POST /api/listing/submit once the body is a draft.
// It freezes each item through listing-core wasm and enqueues
// listing.submit.batch. It does not dial Ozon.
func SendDrafts(ctx context.Context, pool *pgxpool.Pool, orgID, userID int64, body []byte, now time.Time) (DraftData, error) {
	if pool == nil {
		return DraftData{}, statusErr(503, "服务暂不可用", "internal")
	}
	var req struct {
		StoreID string            `json:"storeId"`
		CardID  string            `json:"cardId"`
		Items   []json.RawMessage `json:"items"`
	}
	if err := json.Unmarshal(body, &req); err != nil || len(req.Items) == 0 {
		return DraftData{}, statusErr(400, ErrBadRequest.Error(), "bad_request")
	}
	for _, item := range req.Items {
		if !json.Valid(item) {
			return DraftData{}, statusErr(400, "Draft 格式无效", "bad_request")
		}
	}
	mod, err := module(ctx)
	if err != nil {
		return DraftData{}, statusErr(503, "服务暂不可用", "internal")
	}
	tx, err := pool.Begin(ctx)
	if err != nil {
		return DraftData{}, statusErr(500, "服务暂不可用", "internal")
	}
	defer tx.Rollback(ctx)
	if err := tenant.EnterApp(ctx, tx, orgID); err != nil {
		return DraftData{}, statusErr(500, "服务暂不可用", "internal")
	}
	card, err := loadCard(ctx, tx, orgID, req.CardID)
	if err != nil {
		return DraftData{}, err
	}
	loaded, err := loadSnapshot(ctx, tx, mod, card)
	if err != nil {
		return DraftData{}, err
	}
	snapshot, revision := loaded.snapshot, loaded.current
	workspace, err := workspaceUUID(ctx, tx, orgID)
	if err != nil {
		return DraftData{}, err
	}
	schema, err := json.Marshal(map[string]json.RawMessage{
		"snapshot":        snapshot,
		"searchMaterials": []byte("[]"),
	})
	if err != nil {
		return DraftData{}, statusErr(500, "服务暂不可用", "internal")
	}
	nowMS := now.UnixMilli()
	var items []DraftItem
	var ready []frozen
	recordRevision := false
	for _, raw := range req.Items {
		rowID := draftRowID(raw)
		patched, blocked, record, err := gateSchema(ctx, tx, raw, loaded)
		if err != nil {
			return DraftData{}, err
		}
		if record {
			recordRevision = true
		}
		if blocked != nil {
			blocked.RowID = rowID
			items = append(items, *blocked)
			continue
		}
		if skip, hit := ImageIssue(draftImageURLs(patched), workspace, nowMS); hit {
			items = append(items, DraftItem{RowID: rowID, Outcome: "skipped", SkipReason: string(skip)})
			continue
		}
		frozen, refusal, err := freezeDraft(ctx, mod, schema, card.payload, patched, rowID)
		if err != nil {
			return DraftData{}, err
		}
		if refusal != nil {
			if draftRevision(patched) != draftRevision(raw) {
				if names := requiredFieldNames(refusal.Issues); len(names) > 0 {
					refusal.Fields = names
				}
			}
			items = append(items, *refusal)
			continue
		}
		frozen.cardID = req.CardID
		ready = append(ready, frozen)
	}
	data := DraftData{
		ServerSchemaRevision:    revision,
		AcceptedSchemaRevisions: acceptedRevisions(loaded.current, loaded.legacy),
		Items:                   items,
	}
	if recordRevision {
		if err := noteSchemaRevision(ctx, tx, loaded.current, loaded.snapshot); err != nil {
			return DraftData{}, statusErr(500, "服务暂不可用", "internal")
		}
	}
	if len(ready) == 0 {
		if data.Items == nil {
			data.Items = []DraftItem{}
		}
		if recordRevision {
			if err := tx.Commit(ctx); err != nil {
				return DraftData{}, statusErr(500, "服务暂不可用", "internal")
			}
		}
		return data, nil
	}
	admitted, skipped, err := admitOffers(ctx, tx, orgID, req.StoreID, ready)
	if err != nil {
		return DraftData{}, err
	}
	data.Items = append(data.Items, skipped...)
	if len(admitted) == 0 {
		if recordRevision {
			if err := tx.Commit(ctx); err != nil {
				return DraftData{}, statusErr(500, "服务暂不可用", "internal")
			}
		}
		return data, nil
	}
	enqueued, err := enqueueDrafts(ctx, tx, orgID, userID, req.StoreID, admitted)
	if err != nil {
		return DraftData{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return DraftData{}, statusErr(500, "服务暂不可用", "internal")
	}
	data.Items = append(data.Items, enqueued...)
	return data, nil
}

// SendStored freezes stored rows and enqueues listing.submit.batch.
// expectedRevisions is still not applied.
func SendStored(ctx context.Context, pool *pgxpool.Pool, orgID, userID int64, storeID string, rowIDs []string, now time.Time) (BatchData, error) {
	if pool == nil {
		return BatchData{}, statusErr(503, "服务暂不可用", "internal")
	}
	mod, err := module(ctx)
	if err != nil {
		return BatchData{}, statusErr(503, "服务暂不可用", "internal")
	}
	tx, err := pool.Begin(ctx)
	if err != nil {
		return BatchData{}, statusErr(500, "服务暂不可用", "internal")
	}
	defer tx.Rollback(ctx)
	if err := tenant.EnterApp(ctx, tx, orgID); err != nil {
		return BatchData{}, statusErr(500, "服务暂不可用", "internal")
	}
	var items []BatchItem
	var ready []frozen
	recordRevision := false
	for _, rowID := range rowIDs {
		item, one, recorded, err := freezeStored(ctx, tx, mod, orgID, storeID, rowID, now)
		if err != nil {
			return BatchData{}, err
		}
		if recorded {
			recordRevision = true
		}
		if item != nil {
			items = append(items, *item)
			continue
		}
		ready = append(ready, one)
	}
	if len(ready) == 0 {
		if recordRevision {
			if err := tx.Commit(ctx); err != nil {
				return BatchData{}, statusErr(500, "服务暂不可用", "internal")
			}
		}
		return BatchData{Items: items}, nil
	}
	admitted, skipped, err := admitOffers(ctx, tx, orgID, storeID, ready)
	if err != nil {
		return BatchData{}, err
	}
	for _, skip := range skipped {
		items = append(items, BatchItem{RowID: skip.RowID, Skipped: "blocked", Detail: skip.SkipReason})
	}
	if len(admitted) == 0 {
		if recordRevision {
			if err := tx.Commit(ctx); err != nil {
				return BatchData{}, statusErr(500, "服务暂不可用", "internal")
			}
		}
		return BatchData{Items: items}, nil
	}
	enqueued, err := enqueueDrafts(ctx, tx, orgID, userID, storeID, admitted)
	if err != nil {
		return BatchData{}, err
	}
	for _, item := range enqueued {
		// A replay does not enqueue work or transition the existing intent.
		// Leave its row projection (including updated_at) unchanged as well.
		if item.Outcome != "created" {
			continue
		}
		if _, err := tx.Exec(ctx, `
			UPDATE public.listing_rows
			   SET submission_state = 'queued', updated_at = clock_timestamp()
			 WHERE org_id = $1 AND id = $2::uuid AND revision = $3`,
			orgID, item.Intent.ListingRowID, item.Intent.RowRevision); err != nil {
			return BatchData{}, statusErr(500, "服务暂不可用", "internal")
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return BatchData{}, statusErr(500, "服务暂不可用", "internal")
	}
	for _, item := range enqueued {
		items = append(items, BatchItem{RowID: item.RowID, Intent: item.Intent, Created: item.Outcome == "created"})
	}
	return BatchData{Items: items}, nil
}

type cardRow struct {
	payload  []byte
	category int64
	typeID   int64
	language string
}

func loadCard(ctx context.Context, tx pgx.Tx, orgID int64, cardID string) (cardRow, error) {
	var raw []byte
	err := tx.QueryRow(ctx, `
		SELECT payload FROM public.listing_cards
		 WHERE org_id = $1 AND id = $2::uuid`, orgID, cardID).Scan(&raw)
	if errors.Is(err, pgx.ErrNoRows) {
		return cardRow{}, statusErr(404, "上架方案不存在", "not_found")
	}
	if err != nil {
		return cardRow{}, statusErr(500, "服务暂不可用", "internal")
	}
	var body struct {
		Category int64  `json:"descriptionCategoryId"`
		TypeID   int64  `json:"typeId"`
		Language string `json:"language"`
	}
	if err := json.Unmarshal(raw, &body); err != nil || body.Category <= 0 || body.TypeID <= 0 {
		return cardRow{}, statusErr(500, "服务暂不可用", "internal")
	}
	lang := body.Language
	if lang == "" {
		lang = "default"
	}
	return cardRow{payload: raw, category: body.Category, typeID: body.TypeID, language: lang}, nil
}

type loadedSchema struct {
	snapshot json.RawMessage
	current  string
	legacy   string
	after    []schemaField
}

func loadSnapshot(ctx context.Context, tx pgx.Tx, mod contract.Module, card cardRow) (loadedSchema, error) {
	var payload []byte
	var fetched int64
	err := tx.QueryRow(ctx, `
		SELECT payload, fetched_at_ms FROM public.ozon_catalog_schema_cache
		 WHERE description_category_id = $1 AND type_id = $2 AND language = $3`,
		card.category, card.typeID, card.language).Scan(&payload, &fetched)
	if errors.Is(err, pgx.ErrNoRows) || (err == nil && time.Now().UnixMilli()-fetched > schemaTTLMS) {
		return loadedSchema{}, statusErr(409, "正在更新类目字段，请稍后重试", "schema_sync_required")
	}
	if err != nil {
		return loadedSchema{}, statusErr(500, "服务暂不可用", "internal")
	}
	zr, err := gzip.NewReader(bytes.NewReader(payload))
	if err != nil {
		return loadedSchema{}, statusErr(500, "服务暂不可用", "internal")
	}
	defer zr.Close()
	fields, err := io.ReadAll(io.LimitReader(zr, 4<<20+1))
	if err != nil || len(fields) > 4<<20 {
		return loadedSchema{}, statusErr(500, "服务暂不可用", "internal")
	}
	after, err := parseSchemaFields(fields)
	if err != nil {
		return loadedSchema{}, statusErr(500, "服务暂不可用", "internal")
	}
	input, err := json.Marshal(struct {
		Category int64           `json:"description_category_id"`
		TypeID   int64           `json:"type_id"`
		Fields   json.RawMessage `json:"fields"`
	}{card.category, card.typeID, fields})
	if err != nil {
		return loadedSchema{}, statusErr(500, "服务暂不可用", "internal")
	}
	snapshot, err := mod.Snapshot(ctx, input)
	if err != nil {
		return loadedSchema{}, statusErr(500, "服务暂不可用", "internal")
	}
	legacy, err := mod.LegacyRevision(ctx, input)
	if err != nil {
		return loadedSchema{}, statusErr(500, "服务暂不可用", "internal")
	}
	var rev struct {
		Revision string `json:"schema_revision"`
	}
	if err := json.Unmarshal(snapshot, &rev); err != nil || rev.Revision == "" {
		return loadedSchema{}, statusErr(500, "服务暂不可用", "internal")
	}
	return loadedSchema{snapshot: snapshot, current: rev.Revision, legacy: legacy, after: after}, nil
}

func gateSchema(ctx context.Context, tx pgx.Tx, raw []byte, loaded loadedSchema) ([]byte, *DraftItem, bool, error) {
	stored := draftRevision(raw)
	var before []schemaField
	var err error
	// Matching revisions are already accepted by decideSchema. History is
	// needed only to compare a different revision, not once per current row.
	if stored != loaded.current && stored != loaded.legacy {
		before, err = previousSchemaFields(ctx, tx, stored)
		if err != nil {
			return nil, nil, false, statusErr(500, "服务暂不可用", "internal")
		}
	}
	decision := decideSchema(stored, loaded.current, loaded.legacy, before, loaded.after, filledFieldKeys(raw))
	if len(decision.Block) > 0 {
		return nil, &DraftItem{Outcome: "skipped", SkipReason: "schema_stale", Fields: decision.Block}, decision.Record, nil
	}
	if decision.Rebind != "" && decision.Rebind != stored {
		raw, err = bindSchemaRevision(raw, decision.Rebind)
		if err != nil {
			return nil, nil, false, statusErr(500, "服务暂不可用", "internal")
		}
	}
	return raw, nil, decision.Record, nil
}

func workspaceUUID(ctx context.Context, tx pgx.Tx, orgID int64) (string, error) {
	var id string
	err := tx.QueryRow(ctx, `SELECT uuid::text FROM public.organizations WHERE id = $1`, orgID).Scan(&id)
	if err != nil {
		return "", statusErr(500, "服务暂不可用", "internal")
	}
	return id, nil
}

type frozen struct {
	rowID      string
	revision   int64
	cardID     string
	clientOp   string
	digest     string
	offerID    string
	importBody json.RawMessage
	intentID   string
	updatedMS  int64
	created    bool
}

func freezeDraft(ctx context.Context, mod contract.Module, schema, card, raw []byte, rowID string) (frozen, *DraftItem, error) {
	if _, err := uuid.Parse(rowID); err != nil {
		return frozen{}, nil, statusErr(400, "Draft 格式无效", "bad_request")
	}
	leanBody, err := json.Marshal(struct {
		Draft json.RawMessage `json:"draft"`
		Card  json.RawMessage `json:"card"`
	}{raw, card})
	if err != nil {
		return frozen{}, nil, statusErr(500, "服务暂不可用", "internal")
	}
	lean, err := mod.Call(ctx, contract.OpSubmitDraft, nil, leanBody)
	if err != nil {
		return frozen{}, nil, statusErr(400, "Draft 格式无效："+err.Error(), "bad_request")
	}
	return freezeLean(ctx, mod, schema, card, lean, rowID, 0, "")
}

func freezeLean(ctx context.Context, mod contract.Module, schema, card, lean []byte, rowID string, revision int64, cardID string) (frozen, *DraftItem, error) {
	body, err := json.Marshal(struct {
		Card  json.RawMessage `json:"card"`
		Row   json.RawMessage `json:"row"`
		RowID string          `json:"rowId"`
	}{card, lean, rowID})
	if err != nil {
		return frozen{}, nil, statusErr(500, "服务暂不可用", "internal")
	}
	out, err := mod.Call(ctx, contract.OpFreezeListing, schema, body)
	if err != nil {
		return frozen{}, nil, statusErr(500, "服务暂不可用", "internal")
	}
	var parsed struct {
		Status  string          `json:"status"`
		Import  json.RawMessage `json:"import"`
		Digest  string          `json:"digest"`
		OfferID string          `json:"offerId"`
		Client  string          `json:"clientOperationId"`
		Reason  string          `json:"reason"`
		Issues  json.RawMessage `json:"issues"`
	}
	if err := json.Unmarshal(out, &parsed); err != nil {
		return frozen{}, nil, statusErr(500, "服务暂不可用", "internal")
	}
	if parsed.Status != "frozen" {
		item := &DraftItem{RowID: rowID, Outcome: "skipped", SkipReason: "blocked"}
		if parsed.Reason == "validation_failed" && len(parsed.Issues) > 0 && string(parsed.Issues) != "null" {
			item.Issues = parsed.Issues
		}
		if parsed.Reason == "freeze_failed" {
			item.SkipReason = "compose_failed"
		}
		if parsed.Reason == "schema_stale" {
			item.SkipReason = "schema_stale"
			item.Issues = nil
		}
		return frozen{}, item, nil
	}
	return frozen{
		rowID: rowID, revision: revision, cardID: cardID,
		clientOp: parsed.Client, digest: parsed.Digest, offerID: parsed.OfferID, importBody: parsed.Import,
	}, nil, nil
}

func freezeStored(ctx context.Context, tx pgx.Tx, mod contract.Module, orgID int64, storeID, rowID string, now time.Time) (*BatchItem, frozen, bool, error) {
	var revision int64
	var rowStore *string
	var rowPayload, cardPayload []byte
	var cardID string
	err := tx.QueryRow(ctx, `
		SELECT r.revision, r.store_id::text, r.payload, r.card_id::text, c.payload
		  FROM public.listing_rows r
		  JOIN public.listing_cards c ON c.org_id = r.org_id AND c.id = r.card_id
		 WHERE r.org_id = $1 AND r.id = $2::uuid`, orgID, rowID).Scan(&revision, &rowStore, &rowPayload, &cardID, &cardPayload)
	if errors.Is(err, pgx.ErrNoRows) {
		return &BatchItem{RowID: rowID, Skipped: "not_found"}, frozen{}, false, nil
	}
	if err != nil {
		return nil, frozen{}, false, statusErr(500, "服务暂不可用", "internal")
	}
	if rowStore == nil || strings.TrimSpace(*rowStore) == "" {
		return &BatchItem{RowID: rowID, Skipped: "store_unbound"}, frozen{}, false, nil
	}
	if !strings.EqualFold(*rowStore, storeID) {
		return &BatchItem{RowID: rowID, Skipped: "store_mismatch"}, frozen{}, false, nil
	}
	card, err := loadCard(ctx, tx, orgID, cardID)
	if err != nil {
		return nil, frozen{}, false, err
	}
	loaded, err := loadSnapshot(ctx, tx, mod, card)
	if err != nil {
		return nil, frozen{}, false, err
	}
	patched, blocked, record, err := gateSchema(ctx, tx, rowPayload, loaded)
	if err != nil {
		return nil, frozen{}, false, err
	}
	if record {
		if err := noteSchemaRevision(ctx, tx, loaded.current, loaded.snapshot); err != nil {
			return nil, frozen{}, false, statusErr(500, "服务暂不可用", "internal")
		}
	}
	if blocked != nil {
		return &BatchItem{RowID: rowID, Skipped: "compose_failed", Detail: "schema_stale", Fields: blocked.Fields}, frozen{}, record, nil
	}
	workspace, err := workspaceUUID(ctx, tx, orgID)
	if err != nil {
		return nil, frozen{}, false, err
	}
	if skip, hit := ImageIssue(draftImageURLs(patched), workspace, now.UnixMilli()); hit {
		return &BatchItem{RowID: rowID, Skipped: "compose_failed", Detail: string(skip)}, frozen{}, record, nil
	}
	schema, err := json.Marshal(map[string]json.RawMessage{
		"snapshot": loaded.snapshot, "searchMaterials": []byte("[]"),
	})
	if err != nil {
		return nil, frozen{}, false, statusErr(500, "服务暂不可用", "internal")
	}
	one, refusal, err := freezeLean(ctx, mod, schema, cardPayload, patched, rowID, revision, cardID)
	if err != nil {
		return nil, frozen{}, false, err
	}
	if refusal != nil {
		item := &BatchItem{RowID: rowID, Skipped: "compose_failed", Detail: refusal.SkipReason}
		if draftRevision(patched) != draftRevision(rowPayload) {
			item.Fields = requiredFieldNames(refusal.Issues)
		}
		return item, frozen{}, record, nil
	}
	return nil, one, record, nil
}

func admitOffers(ctx context.Context, tx pgx.Tx, orgID int64, storeID string, ready []frozen) ([]frozen, []DraftItem, error) {
	offers := make([]string, len(ready))
	for i, row := range ready {
		offers[i] = row.offerID
	}
	rows, err := tx.Query(ctx, `
		SELECT offer_id, client_operation_id FROM public.submission_intents
		 WHERE org_id = $1 AND store_id = $2::uuid
		   AND (offer_id = ANY($3::text[]) OR offer_id IS NULL)
		   AND state IN ('queued', 'submitting', 'unknown', 'accepted')`,
		orgID, storeID, offers)
	if err != nil {
		return nil, nil, statusErr(500, "服务暂不可用", "internal")
	}
	defer rows.Close()
	busy := map[string][]string{}
	var unidentified []string
	for rows.Next() {
		var offer *string
		var op string
		if err := rows.Scan(&offer, &op); err != nil {
			return nil, nil, statusErr(500, "服务暂不可用", "internal")
		}
		if offer == nil {
			unidentified = append(unidentified, op)
			continue
		}
		busy[*offer] = append(busy[*offer], op)
	}
	if err := rows.Err(); err != nil {
		return nil, nil, statusErr(500, "服务暂不可用", "internal")
	}
	admitted := map[string]string{}
	var kept []frozen
	var skipped []DraftItem
	for _, row := range ready {
		conflict := false
		for _, op := range busy[row.offerID] {
			if op != row.clientOp {
				conflict = true
			}
		}
		for _, op := range unidentified {
			if op != row.clientOp {
				conflict = true
			}
		}
		if conflict {
			skipped = append(skipped, DraftItem{RowID: row.rowID, Outcome: "skipped", SkipReason: "offer_busy"})
			continue
		}
		if winner, ok := admitted[row.offerID]; ok && winner != row.clientOp {
			skipped = append(skipped, DraftItem{RowID: row.rowID, Outcome: "skipped", SkipReason: "offer_busy"})
			continue
		}
		admitted[row.offerID] = row.clientOp
		kept = append(kept, row)
	}
	return kept, skipped, nil
}

// newID mints intent and batch ids. Tests pin it so a row-by-row oracle
// and the batch path return the same ids.
var newID = uuid.NewString

const insertIntentSQL = `
			INSERT INTO public.submission_intents (
				id, org_id, store_id, listing_row_id, row_revision, client_operation_id,
				request_hash, state, offer_id, card_id
			) VALUES (
				$1::uuid, $2, $3::uuid, $4::uuid, $5, $6, $7, 'queued', $8, NULLIF($9, '')::uuid
			)
			ON CONFLICT (org_id, store_id, client_operation_id) DO NOTHING
			RETURNING (extract(epoch FROM updated_at) * 1000)::bigint`

const readIntentSQL = `
				SELECT id::text, (extract(epoch FROM updated_at) * 1000)::bigint
				  FROM public.submission_intents
				 WHERE org_id = $1 AND store_id = $2::uuid AND client_operation_id = $3`

func enqueueDrafts(ctx context.Context, tx pgx.Tx, orgID, userID int64, storeID string, ready []frozen) ([]DraftItem, error) {
	digests := make([]string, len(ready))
	for i, row := range ready {
		digests[i] = row.digest
	}
	batchOp := batchClientOperationID(storeID, digests)
	intentIDs := make([]string, len(ready))
	views := make([]DraftItem, len(ready))
	queued := make([]frozen, 0, len(ready))
	// Insert, then read back, for every row, in slice order. The read is
	// used only when the insert conflicts. A repeated client_operation_id
	// in this slice still inserts on the first statement and replays on
	// the later one, because those statements run in order.
	batch := &pgx.Batch{}
	minted := make([]string, len(ready))
	for i, row := range ready {
		minted[i] = newID()
		batch.Queue(insertIntentSQL,
			minted[i], orgID, storeID, row.rowID, row.revision, row.clientOp, row.digest, row.offerID, row.cardID)
		batch.Queue(readIntentSQL, orgID, storeID, row.clientOp)
	}
	var replays []int
	if len(ready) > 0 {
		br := tx.SendBatch(ctx, batch)
		for i, row := range ready {
			id := minted[i]
			var updated int64
			err := br.QueryRow().Scan(&updated)
			outcome := "created"
			if errors.Is(err, pgx.ErrNoRows) {
				err = br.QueryRow().Scan(&id, &updated)
				outcome = "replayed"
			} else if err != nil {
				_ = br.Close()
				return nil, statusErr(500, "服务暂不可用", "internal")
			} else if _, scanErr := scanIntentID(br.QueryRow()); scanErr != nil {
				_ = br.Close()
				return nil, statusErr(500, "服务暂不可用", "internal")
			}
			if err != nil {
				_ = br.Close()
				return nil, statusErr(500, "服务暂不可用", "internal")
			}
			intentIDs[i] = id
			view := IntentView{
				SubmissionIssues: []struct{}{}, CurrentIssueStatus: "absent", CanResume: false,
				ID: id, StoreID: storeID, ListingRowID: row.rowID, RowRevision: row.revision,
				ClientOperationID: row.clientOp, State: "queued", SubmissionReceiptStatus: "absent",
				UpdatedAtMS: updated,
			}
			views[i] = DraftItem{RowID: row.rowID, Outcome: outcome, Intent: &view}
			if outcome == "created" {
				row.intentID = id
				queued = append(queued, row)
			} else {
				replays = append(replays, i)
			}
		}
		if err := br.Close(); err != nil {
			return nil, statusErr(500, "服务暂不可用", "internal")
		}
	}
	if len(replays) > 0 {
		stateBatch := &pgx.Batch{}
		for _, i := range replays {
			stateBatch.Queue(`SELECT state FROM public.submission_intents WHERE id = $1::uuid`, intentIDs[i])
		}
		br := tx.SendBatch(ctx, stateBatch)
		for _, i := range replays {
			var state string
			if err := br.QueryRow().Scan(&state); err != nil {
				_ = br.Close()
				return nil, statusErr(500, "服务暂不可用", "internal")
			}
			views[i].Intent.State = state
		}
		if err := br.Close(); err != nil {
			return nil, statusErr(500, "服务暂不可用", "internal")
		}
	}
	if len(queued) == 0 {
		return views, nil
	}
	plans := PlanImportJobs(newID(), newID(), len(queued))
	jobs := make([]queue.NewJob, 0, len(plans))
	for _, plan := range plans {
		chunk := make([]batchIntent, 0, len(plan.Intents))
		for _, index := range plan.Intents {
			row := queued[index]
			chunk = append(chunk, batchIntent{
				IntentID: row.intentID, RowID: row.rowID, RowRevision: row.revision,
				RequestHash: row.digest, Import: row.importBody,
			})
		}
		payload, err := json.Marshal(batchJob{
			BatchID: plan.BatchID, BatchClientOperationID: batchOp, StoreID: storeID,
			Intents: chunk, SkipMediaLeaseRenewal: true,
		})
		if err != nil {
			return nil, statusErr(500, "服务暂不可用", "internal")
		}
		jobUUID, err := uuid.Parse(plan.JobID)
		if err != nil {
			return nil, statusErr(500, "服务暂不可用", "internal")
		}
		agg, err := uuid.Parse(plan.BatchID)
		if err != nil {
			return nil, statusErr(500, "服务暂不可用", "internal")
		}
		jobs = append(jobs, queue.NewJob{
			ID: jobUUID, OrgID: orgID, Kind: "listing.submit.batch",
			AggregateType: "submission_batch", AggregateID: agg, InputRevision: 0,
			IdempotencyKey: plan.IdempotencyKey, Payload: payload,
			SubmitterUserID: userID, MaxAttempts: 8, Priority: 50,
		})
	}
	if err := tenant.EnterWorker(ctx, tx); err != nil {
		return nil, statusErr(500, "服务暂不可用", "internal")
	}
	if _, err := queue.EnqueueOn(ctx, tx, jobs, 0); err != nil {
		return nil, statusErr(500, "服务暂不可用", "internal")
	}
	if err := tenant.EnterApp(ctx, tx, orgID); err != nil {
		return nil, statusErr(500, "服务暂不可用", "internal")
	}
	return views, nil
}

type batchJob struct {
	BatchID                string        `json:"batchId"`
	BatchClientOperationID string        `json:"batchClientOperationId"`
	StoreID                string        `json:"storeId"`
	Intents                []batchIntent `json:"intents"`
	SkipMediaLeaseRenewal  bool          `json:"skipMediaLeaseRenewal"`
}

type batchIntent struct {
	IntentID    string          `json:"intentId"`
	RowID       string          `json:"rowId"`
	RowRevision int64           `json:"rowRevision"`
	RequestHash string          `json:"requestHash"`
	Import      json.RawMessage `json:"import"`
}

func scanIntentID(row pgx.Row) (string, error) {
	var id string
	var updated int64
	err := row.Scan(&id, &updated)
	return id, err
}

func batchClientOperationID(storeID string, digests []string) string {
	sum := sha256.Sum256([]byte(strings.Join(digests, ",")))
	return "workflow-batch:" + storeID + ":" + hex.EncodeToString(sum[:])
}

func draftRowID(raw []byte) string {
	var body struct {
		RowID string `json:"rowId"`
	}
	_ = json.Unmarshal(raw, &body)
	return body.RowID
}

func draftRevision(raw []byte) string {
	var body struct {
		Revision string `json:"schemaRevision"`
	}
	_ = json.Unmarshal(raw, &body)
	return body.Revision
}

func draftImageURLs(raw []byte) []string {
	var body struct {
		Media struct {
			Images []struct {
				URL *string `json:"public_url"`
			} `json:"images"`
		} `json:"media"`
	}
	if err := json.Unmarshal(raw, &body); err != nil {
		return nil
	}
	out := make([]string, 0, len(body.Media.Images))
	for _, image := range body.Media.Images {
		if image.URL == nil {
			out = append(out, "")
			continue
		}
		out = append(out, *image.URL)
	}
	return out
}

func module(context.Context) (contract.Module, error) {
	if boundModule == nil {
		return nil, errors.New("listing-core wasm is not loaded")
	}
	return boundModule, nil
}

// BatchClientOperationID is exported for the hash comparison test.
func BatchClientOperationID(storeID string, digests []string) string {
	return batchClientOperationID(storeID, digests)
}
