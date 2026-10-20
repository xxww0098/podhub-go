package contract

import (
	"bytes"
	"encoding/json"
	"strings"

	contract "github.com/xxww0098/podhub-go/internal/admin/core/contract/outcome"
)

// OzonValue kinds stored with an internal tag.
const (
	ozonText    = "text"
	ozonInteger = "integer"
	ozonDecimal = "decimal"
	ozonFlag    = "flag"
	ozonOptions = "options"
)

// Fixed value keys the hand fixture treats as the ready set.
// The spec's "九个" is loose; the fixture and the valid state use these eight.
var ozonFixedKeys = []struct {
	key  string
	kind string
}{
	{"fixed:width", ozonInteger},
	{"fixed:height", ozonInteger},
	{"fixed:depth", ozonInteger},
	{"fixed:dimension_unit", ozonText},
	{"fixed:weight", ozonInteger},
	{"fixed:weight_unit", ozonText},
	{"fixed:vat", ozonDecimal},
	{"fixed:currency_code", ozonText},
}

// OzonPut is a normalized ozon-config body.
type OzonPut struct {
	Category   int64
	TypeID     int64
	Language   string
	Values     map[string]json.RawMessage
	ValuesJSON []byte
	Tags       []string
	Prompt     string
	AI         AiOutput
	Expected   int64
}

// OzonConfig is SupplierOzonConfigData, in declaration order.
type OzonConfig struct {
	ProductID               string                     `json:"productId"`
	DescriptionCategoryID   int64                      `json:"descriptionCategoryId"`
	TypeID                  int64                      `json:"typeId"`
	Language                string                     `json:"language"`
	Values                  map[string]json.RawMessage `json:"values"`
	FixedTags               []string                   `json:"fixedTags"`
	PromptText              string                     `json:"promptText"`
	AI                      AiOutput                   `json:"aiOutput"`
	Revision                int64                      `json:"revision"`
	State                   string                     `json:"state"`
	ValidatedCatalogDigest  *string                    `json:"validatedCatalogDigest,omitempty"`
	Issues                  json.RawMessage            `json:"issues"`
	Usable                  bool                       `json:"usable"`
	Denial                  string                     `json:"denial,omitempty"`
	UpdatedAtMs             int64                      `json:"updatedAtMs"`
	DraftPromptRevision     *int32                     `json:"draftPromptRevision,omitempty"`
	PublishedPromptRevision *int32                     `json:"publishedPromptRevision,omitempty"`
}

// CatalogStamp is one ozon_category_current row the judge reads.
type CatalogStamp struct {
	Digest  string
	Fetched int64
	Present bool
}

// JudgeResult is the state written before a new-coordinate overwrite.
type JudgeResult struct {
	State  string
	Digest *string
	Issues json.RawMessage
	Count  int
}

// LegacyIssues is the needs-review stamp write_row_config writes.
func LegacyIssues() json.RawMessage {
	return json.RawMessage(`[{"issue":"legacy_configuration_requires_review"}]`)
}

// HasLegacyIssue reports the early-return exclusion.
func HasLegacyIssue(raw []byte) bool {
	return bytes.Contains(raw, []byte(`"legacy_configuration_requires_review"`))
}

// Judge decides valid versus needs_reconfiguration from the eight fixed keys
// and the current catalog row. A missing catalog is catalog_missing.
func Judge(values map[string]json.RawMessage, stamp CatalogStamp, now int64) JudgeResult {
	var issues []json.RawMessage
	if !stamp.Present || stamp.Digest == "" {
		issues = append(issues, json.RawMessage(`{"issue":"catalog_missing"}`))
	} else if Freshness(stamp.Fetched, now, true) == "expired" {
		issues = append(issues, json.RawMessage(`{"issue":"catalog_expired"}`))
	}
	for _, key := range ozonFixedKeys {
		if !valueKind(values[key.key], key.kind) {
			issues = append(issues, json.RawMessage(`{"issue":"missing_fixed_field","field":"`+strings.TrimPrefix(key.key, "fixed:")+`"}`))
		}
	}
	if len(issues) == 0 {
		digest := stamp.Digest
		return JudgeResult{State: "valid", Digest: &digest, Issues: json.RawMessage(`[]`), Count: 0}
	}
	body, _ := json.Marshal(issues)
	return JudgeResult{State: "needs_reconfiguration", Issues: body, Count: len(issues)}
}

func valueKind(raw json.RawMessage, kind string) bool {
	if len(bytes.TrimSpace(raw)) == 0 {
		return false
	}
	var rows []map[string]json.RawMessage
	if err := json.Unmarshal(raw, &rows); err != nil || len(rows) == 0 {
		return false
	}
	got := strings.Trim(string(rows[0]["kind"]), `"`)
	return got == kind
}

// DecodeOzon rejects unknown fields. An empty prompt is stored empty.
// A non-empty prompt must be a canonical six-line card.
func DecodeOzon(body []byte) (OzonPut, error) {
	raw, err := strictObject(body)
	if err != nil || !hasOnly(raw, []string{
		"descriptionCategoryId", "typeId", "language", "values", "fixedTags", "promptText", "aiOutput", "expectedRevision",
	}) || !requireKeys(raw, []string{
		"descriptionCategoryId", "typeId", "language", "values", "fixedTags", "promptText", "aiOutput", "expectedRevision",
	}) {
		return OzonPut{}, invalid()
	}
	var category, typeID, expected int64
	var language, prompt string
	var tags []string
	if !unmarshal(raw["descriptionCategoryId"], &category) || !unmarshal(raw["typeId"], &typeID) ||
		!unmarshal(raw["language"], &language) || !unmarshal(raw["fixedTags"], &tags) ||
		!unmarshal(raw["promptText"], &prompt) || !unmarshal(raw["expectedRevision"], &expected) {
		return OzonPut{}, invalid()
	}
	if expected < 0 {
		return OzonPut{}, fail(contract.KindValidation, "expectedRevision 不能小于 0")
	}
	if category <= 0 || typeID <= 0 {
		return OzonPut{}, fail(contract.KindValidation, "类目坐标必须为正整数")
	}
	language = strings.TrimSpace(language)
	switch language {
	case "default", "ru", "en", "tr", "zh_hans":
	default:
		return OzonPut{}, invalid()
	}
	values, packed, err := canonOzonValues(raw["values"])
	if err != nil {
		return OzonPut{}, err
	}
	norm, err := NormalizeTags(tags, true)
	if err != nil {
		return OzonPut{}, err
	}
	prompt = strings.TrimSpace(prompt)
	if prompt != "" {
		prompt, err = CanonicalBrief(prompt)
		if err != nil {
			return OzonPut{}, fail(contract.KindValidation, err.Error())
		}
	}
	ai, err := decodeAI(raw["aiOutput"])
	if err != nil {
		return OzonPut{}, err
	}
	return OzonPut{
		Category: category, TypeID: typeID, Language: language,
		Values: values, ValuesJSON: packed, Tags: norm, Prompt: prompt, AI: ai, Expected: expected,
	}, nil
}

func decodeAI(raw json.RawMessage) (AiOutput, error) {
	obj, err := strictObject(raw)
	if err != nil || !hasOnly(obj, []string{"title", "description", "tags"}) || !requireKeys(obj, []string{"title", "description", "tags"}) {
		return AiOutput{}, invalid()
	}
	var ai AiOutput
	if !unmarshal(obj["title"], &ai.Title) || !unmarshal(obj["description"], &ai.Description) || !unmarshal(obj["tags"], &ai.Tags) {
		return AiOutput{}, invalid()
	}
	return ai, nil
}

func canonOzonValues(raw json.RawMessage) (map[string]json.RawMessage, []byte, error) {
	if len(bytes.TrimSpace(raw)) == 0 || !json.Valid(raw) || bytes.TrimSpace(raw)[0] != '{' {
		return nil, nil, invalid()
	}
	var incoming map[string]json.RawMessage
	if err := json.Unmarshal(raw, &incoming); err != nil || incoming == nil {
		return nil, nil, invalid()
	}
	out := map[string]json.RawMessage{}
	for key, val := range incoming {
		canon, err := canonOzonList(val)
		if err != nil {
			return nil, nil, err
		}
		out[key] = canon
	}
	packed, err := json.Marshal(out)
	if err != nil {
		return nil, nil, invalid()
	}
	return out, packed, nil
}

func canonOzonList(raw json.RawMessage) (json.RawMessage, error) {
	var rows []map[string]json.RawMessage
	if err := json.Unmarshal(raw, &rows); err != nil {
		return nil, invalid()
	}
	if rows == nil {
		rows = []map[string]json.RawMessage{}
	}
	var out []json.RawMessage
	for _, row := range rows {
		kind := strings.Trim(string(row["kind"]), `"`)
		switch kind {
		case ozonText, ozonInteger, ozonDecimal, ozonFlag:
			if _, ok := row["value"]; !ok {
				return nil, invalid()
			}
			body, err := json.Marshal(struct {
				Kind  string          `json:"kind"`
				Value json.RawMessage `json:"value"`
			}{kind, row["value"]})
			if err != nil {
				return nil, invalid()
			}
			out = append(out, body)
		case ozonOptions:
			body, err := json.Marshal(struct {
				Kind    string          `json:"kind"`
				Options json.RawMessage `json:"options"`
			}{kind, row["options"]})
			if err != nil || len(row["options"]) == 0 {
				return nil, invalid()
			}
			out = append(out, body)
		default:
			return nil, invalid()
		}
	}
	if out == nil {
		out = []json.RawMessage{}
	}
	body, err := json.Marshal(out)
	return body, err
}

// FinishOzon fills usable and denial from the same listability predicate as a row.
func FinishOzon(cfg *OzonConfig, facts RowFacts) {
	if cfg.Values == nil {
		cfg.Values = map[string]json.RawMessage{}
	}
	if cfg.FixedTags == nil {
		cfg.FixedTags = []string{}
	}
	if len(cfg.Issues) == 0 {
		cfg.Issues = json.RawMessage(`[]`)
	}
	cfg.Denial = facts.ProductDenial()
	cfg.Usable = cfg.Denial == ""
}

// SyncCounts is the exact tally. Lists are capped separately.
type SyncCounts struct {
	Updated   int `json:"updated"`
	UpToDate  int `json:"upToDate"`
	Unmatched int `json:"unmatched"`
	Failed    int `json:"failed"`
}

// SyncItem is one updated or up-to-date row.
type SyncItem struct {
	ProductID      string `json:"productId"`
	ProductTitle   string `json:"productTitle"`
	PromptFileName string `json:"promptFileName"`
	Revision       int64  `json:"revision"`
}

// SyncMiss adds a reason of no_match or ambiguous.
type SyncMiss struct {
	ProductID      string `json:"productId"`
	ProductTitle   string `json:"productTitle"`
	PromptFileName string `json:"promptFileName"`
	Revision       int64  `json:"revision"`
	Reason         string `json:"reason"`
}

// SyncFailure carries the savepoint reason.
type SyncFailure struct {
	ProductID      string `json:"productId"`
	ProductTitle   string `json:"productTitle"`
	PromptFileName string `json:"promptFileName"`
	Revision       int64  `json:"revision"`
	Reason         string `json:"reason"`
}

// SyncReport is SupplierPromptSyncData.
type SyncReport struct {
	Counts           SyncCounts    `json:"counts"`
	Updated          []SyncItem    `json:"updated"`
	UpToDate         []SyncItem    `json:"upToDate"`
	Unmatched        []SyncMiss    `json:"unmatched"`
	Failed           []SyncFailure `json:"failed"`
	DetailsTruncated bool          `json:"detailsTruncated"`
}

// EmptySync is the no-candidate report. Counts stay exact; slices are empty arrays.
func EmptySync() SyncReport {
	return SyncReport{
		Updated: []SyncItem{}, UpToDate: []SyncItem{}, Unmatched: []SyncMiss{}, Failed: []SyncFailure{},
	}
}

// PromptPublish is PublishSupplierPromptData.
type PromptPublish struct {
	ProductID         string `json:"productId"`
	Revision          int32  `json:"revision"`
	PublishedRevision int32  `json:"publishedRevision"`
	ProductRevision   int64  `json:"productRevision"`
	ConfigRevision    int64  `json:"configRevision"`
}

// BrowserGrant is the single PUT the browser receives.
type BrowserGrant struct {
	URL         string       `json:"url"`
	Headers     GrantHeaders `json:"headers"`
	ExpiresAtMs int64        `json:"expiresAtMs"`
}

// GrantHeaders is contentType, ifNoneMatch, and an optional checksum.
type GrantHeaders struct {
	ContentType string `json:"contentType"`
	IfNoneMatch string `json:"ifNoneMatch"`
	Checksum    string `json:"checksumSha256,omitempty"`
}

// UploadPart is one presigned part.
type UploadPart struct {
	PartNumber  int    `json:"partNumber"`
	URL         string `json:"url"`
	ByteLength  uint64 `json:"byteLength"`
	ExpiresAtMs int64  `json:"expiresAtMs"`
}

// MultipartPlan is present only for a large PSD.
// Field order follows the names the spec states; the parent declaration order
// is not pasted and is listed for the user to confirm.
type MultipartPlan struct {
	UploadID string       `json:"uploadId"`
	Ticket   string       `json:"ticket"`
	PartSize uint64       `json:"partSize"`
	Parts    []UploadPart `json:"parts"`
}

// UploadBody is the flattened DirectUploadTarget inside data.upload.
type UploadBody struct {
	Upload         *BrowserGrant  `json:"upload,omitempty"`
	UploadTicket   string         `json:"uploadTicket"`
	Multipart      *MultipartPlan `json:"multipart,omitempty"`
	AlreadyPresent bool           `json:"alreadyPresent,omitempty"`
}

// ConfirmedUpload is SupplierDbUploadConfirmedData.
type ConfirmedUpload struct {
	Key       string `json:"key"`
	PublicURL string `json:"publicUrl"`
}

// MovedObject is the move response.
type MovedObject struct {
	SourcePath      string `json:"sourcePath"`
	DestinationPath string `json:"destinationPath"`
}

// DirectoryCreated is the 201 directory body.
type DirectoryCreated struct {
	Path string `json:"path"`
}
