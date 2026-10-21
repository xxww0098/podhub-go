package domain

import (
	"encoding/json"
	"errors"

	"github.com/google/uuid"
)

// ErrBadRequest is the validation message submit_drafts and submit_batch
// return for a shape the route will not read.
var ErrBadRequest = errors.New("请求格式无效")

// ErrStoreRequired is an empty storeId.
var ErrStoreRequired = errors.New("storeId 必填")

// ErrStoreInvalid is a storeId that is not a UUID.
var ErrStoreInvalid = errors.New("storeId 无效")

// ErrCardRequired is an empty cardId on the draft route.
var ErrCardRequired = errors.New("cardId 必填")

// ErrRowsRequired is an empty batch.
var ErrRowsRequired = errors.New("rowIds 必填")

// ErrBatchTooLarge is check_batch_size's cap. The Chinese wording of the
// Rust error was not opened; the cap 100 is ImportV3MaxItems.
var ErrBatchTooLarge = errors.New("一次最多发送 100 条")

// DraftPeek is enough of a POST /api/listing/submit body to tell it from the
// banned-tag gate. Field names follow SubmitDraft's camelCase.
type DraftPeek struct {
	StoreID      string
	CardID       string
	RulesVersion string
	Text         string
	Tags         []string
	Items        int
	HasItems     bool
}

// IsDraft reports a body that carries storeId or items. The tag gate body
// has neither.
func IsDraft(body []byte) bool {
	var probe map[string]json.RawMessage
	if json.Unmarshal(body, &probe) != nil {
		return false
	}
	_, items := probe["items"]
	_, store := probe["storeId"]
	return items || store
}

// IsBatch reports a body that carries row_ids: the stored-row batch form of
// POST /api/listing/submit. It routes before the Draft check.
func IsBatch(body []byte) bool {
	var probe map[string]json.RawMessage
	if json.Unmarshal(body, &probe) != nil {
		return false
	}
	_, rows := probe["row_ids"]
	return rows
}

// PeekDraft reads the draft envelope. It does not freeze.
func PeekDraft(body []byte) (DraftPeek, error) {
	var raw struct {
		StoreID      string          `json:"storeId"`
		CardID       string          `json:"cardId"`
		RulesVersion string          `json:"rulesVersion"`
		Text         string          `json:"text"`
		Tags         []string        `json:"tags"`
		Items        json.RawMessage `json:"items"`
	}
	if err := json.Unmarshal(body, &raw); err != nil {
		return DraftPeek{}, ErrBadRequest
	}
	peek := DraftPeek{
		StoreID: raw.StoreID, CardID: raw.CardID,
		RulesVersion: raw.RulesVersion, Text: raw.Text, Tags: raw.Tags,
	}
	if raw.Items != nil {
		peek.HasItems = true
		var items []json.RawMessage
		if err := json.Unmarshal(raw.Items, &items); err != nil {
			return DraftPeek{}, ErrBadRequest
		}
		peek.Items = len(items)
	}
	return peek, nil
}

// BatchBody is the stored-row batch form of POST /api/listing/submit.
// ExpectedRevisions pins server content revisions, not browser-local writes.
type BatchBody struct {
	StoreID           string
	RowIDs            []string
	ExpectedRevisions map[string]int64
}

// ParseBatch checks the merged submit body's stored-row batch envelope.
func ParseBatch(body []byte) (BatchBody, error) {
	var raw struct {
		StoreID           string   `json:"storeId"`
		RowIDs            []string `json:"row_ids"`
		ExpectedRevisions []struct {
			RowID    string `json:"rowId"`
			Revision *int64 `json:"revision"`
		} `json:"expectedRevisions"`
	}
	if len(body) == 0 || json.Unmarshal(body, &raw) != nil {
		return BatchBody{}, ErrBadRequest
	}
	req := BatchBody{StoreID: raw.StoreID, RowIDs: raw.RowIDs, ExpectedRevisions: make(map[string]int64, len(raw.ExpectedRevisions))}
	for _, pin := range raw.ExpectedRevisions {
		if pin.Revision == nil {
			return BatchBody{}, ErrBadRequest
		}
		if _, exists := req.ExpectedRevisions[pin.RowID]; exists {
			return BatchBody{}, ErrBadRequest
		}
		req.ExpectedRevisions[pin.RowID] = *pin.Revision
	}
	if err := req.Validate(); err != nil {
		return BatchBody{}, err
	}
	return req, nil
}

// Validate also protects direct service calls from silently omitting pins.
func (b BatchBody) Validate() error {
	if b.StoreID == "" {
		return ErrStoreRequired
	}
	if _, err := uuid.Parse(b.StoreID); err != nil {
		return ErrStoreInvalid
	}
	if len(b.RowIDs) == 0 {
		return ErrRowsRequired
	}
	if len(b.RowIDs) > ImportV3MaxItems {
		return ErrBatchTooLarge
	}
	if len(b.ExpectedRevisions) != len(b.RowIDs) {
		return ErrBadRequest
	}
	seen := make(map[uuid.UUID]struct{}, len(b.RowIDs))
	for _, id := range b.RowIDs {
		parsed, err := uuid.Parse(id)
		if err != nil {
			return ErrBadRequest
		}
		if _, exists := seen[parsed]; exists {
			return ErrBadRequest
		}
		seen[parsed] = struct{}{}
		if revision, ok := b.ExpectedRevisions[id]; !ok || revision < 0 {
			return ErrBadRequest
		}
	}
	return nil
}
