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

// OzonPut is a normalized ozon-config body.
type OzonPut struct {
	Category    int64
	TypeID      int64
	Language    string
	Values      map[string]json.RawMessage
	ValuesJSON  []byte
	ComplexJSON json.RawMessage
	Tags        []string
	Prompt      string
	AI          AiOutput
	Expected    int64
	Validate    bool
}

// OzonConfig is SupplierOzonConfigData, in declaration order.
type OzonConfig struct {
	ProductID              string                     `json:"product_id"`
	DescriptionCategoryID  int64                      `json:"description_category_id"`
	TypeID                 int64                      `json:"type_id"`
	Language               string                     `json:"language"`
	Values                 map[string]json.RawMessage `json:"values"`
	ComplexValues          json.RawMessage            `json:"complex_values"`
	FixedTags              []string                   `json:"fixed_tags"`
	PromptText             string                     `json:"prompt_text"`
	AI                     AiOutput                   `json:"ai_output"`
	Revision               int64                      `json:"revision"`
	State                  string                     `json:"state"`
	ValidatedCatalogDigest *string                    `json:"validatedCatalogDigest,omitempty"`
	Issues                 json.RawMessage            `json:"issues"`
	Usable                 bool                       `json:"usable"`
	Denial                 string                     `json:"denial,omitempty"`
	UpdatedAtMs            int64                      `json:"updated_at_ms"`
}

// CatalogStamp is one ozon_category_current row the judge reads.
type CatalogStamp struct {
	Digest  string
	Fetched int64
	Present bool
	Fields  json.RawMessage
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

// PendingOzon marks saved fields unusable until explicitly validated.
func PendingOzon() JudgeResult {
	return JudgeResult{State: "needs_reconfiguration", Issues: json.RawMessage(`[{"issue":"validation_pending"}]`), Count: 1}
}

// Judge adds catalog freshness to the canonical Rust field issues.
func Judge(fieldIssues json.RawMessage, stamp CatalogStamp, now int64) JudgeResult {
	var issues []json.RawMessage
	if len(fieldIssues) > 0 {
		_ = json.Unmarshal(fieldIssues, &issues)
	}
	if !stamp.Present || stamp.Digest == "" {
		issues = append(issues, json.RawMessage(`{"issue":"catalog_missing"}`))
	} else if Freshness(stamp.Fetched, now, true) == "expired" {
		issues = append(issues, json.RawMessage(`{"issue":"catalog_expired"}`))
	}
	if len(issues) == 0 {
		digest := stamp.Digest
		return JudgeResult{State: "valid", Digest: &digest, Issues: json.RawMessage(`[]`), Count: 0}
	}
	body, _ := json.Marshal(issues)
	return JudgeResult{State: "needs_reconfiguration", Issues: body, Count: len(issues)}
}

// DecodeOzon rejects unknown fields. An empty prompt is stored empty.
// A non-empty profile must contain confirmed product facts.
func DecodeOzon(body []byte) (OzonPut, error) {
	raw, err := strictObject(body)
	if err != nil || !hasOnly(raw, []string{
		"description_category_id", "type_id", "language", "values", "complex_values", "fixed_tags", "prompt_text", "ai_output", "expected_revision", "validate",
	}) || !requireKeys(raw, []string{
		"description_category_id", "type_id", "language", "values", "complex_values", "fixed_tags", "prompt_text", "ai_output", "expected_revision", "validate",
	}) {
		return OzonPut{}, invalid()
	}
	var category, typeID, expected int64
	var validate *bool
	var language, prompt string
	var tags []string
	if !unmarshal(raw["description_category_id"], &category) || !unmarshal(raw["type_id"], &typeID) ||
		!unmarshal(raw["language"], &language) || !unmarshal(raw["fixed_tags"], &tags) ||
		!unmarshal(raw["prompt_text"], &prompt) || !unmarshal(raw["expected_revision"], &expected) || !unmarshal(raw["validate"], &validate) || validate == nil {
		return OzonPut{}, invalid()
	}
	if expected < 0 {
		return OzonPut{}, fail(contract.KindValidation, "expected_revision 不能小于 0")
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
	complex, err := decodeComplexValues(raw["complex_values"])
	if err != nil {
		return OzonPut{}, invalid()
	}
	// Ozon fields are saved before the AI step supplies the required tags.
	norm, err := NormalizeTags(tags, false)
	if err != nil {
		return OzonPut{}, err
	}
	prompt = strings.TrimSpace(prompt)
	if prompt != "" {
		prompt, err = CanonicalProfile(prompt)
		if err != nil {
			return OzonPut{}, fail(contract.KindValidation, err.Error())
		}
	}
	ai, err := decodeAI(raw["ai_output"])
	if err != nil {
		return OzonPut{}, err
	}
	return OzonPut{
		Category: category, TypeID: typeID, Language: language,
		Values: values, ValuesJSON: packed, ComplexJSON: complex, Tags: norm, Prompt: prompt, AI: ai, Expected: expected, Validate: *validate,
	}, nil
}

// Check the nested envelope even when category material is not available yet.
func decodeComplexValues(raw json.RawMessage) (json.RawMessage, error) {
	var groups []struct {
		ID    *int64 `json:"complex_id"`
		Items []struct {
			ID     *string                    `json:"item_id"`
			Values map[string]json.RawMessage `json:"values"`
		} `json:"items"`
	}
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.DisallowUnknownFields()
	if dec.Decode(&groups) != nil || groups == nil {
		return nil, invalid()
	}
	for _, group := range groups {
		if group.ID == nil || group.Items == nil {
			return nil, invalid()
		}
		for _, item := range group.Items {
			if item.ID == nil || item.Values == nil {
				return nil, invalid()
			}
		}
	}
	return bytes.TrimSpace(raw), nil
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

// BrowserGrant is the single PUT the browser receives.
type BrowserGrant struct {
	URL         string       `json:"url"`
	Headers     GrantHeaders `json:"headers"`
	ExpiresAtMs int64        `json:"expires_at_ms"`
}

// GrantHeaders uses the shared direct-upload wire contract.
type GrantHeaders struct {
	ContentType string `json:"content_type"`
	IfNoneMatch string `json:"if_none_match"`
	Checksum    string `json:"checksum_sha256,omitempty"`
}

// UploadPart is one presigned part.
type UploadPart struct {
	PartNumber  int    `json:"part_number"`
	URL         string `json:"url"`
	ByteLength  uint64 `json:"byte_length"`
	ExpiresAtMs int64  `json:"expires_at_ms"`
}

// MultipartPlan is present only for a large PSD.
// Field order follows the names the spec states; the parent declaration order
// is not pasted and is listed for the user to confirm.
type MultipartPlan struct {
	UploadID string       `json:"upload_id"`
	Ticket   string       `json:"ticket"`
	PartSize uint64       `json:"part_size"`
	Parts    []UploadPart `json:"parts"`
}

// UploadBody is the flattened DirectUploadTarget inside data.upload.
type UploadBody struct {
	Upload         *BrowserGrant  `json:"upload,omitempty"`
	UploadTicket   string         `json:"upload_ticket"`
	Multipart      *MultipartPlan `json:"multipart,omitempty"`
	AlreadyPresent bool           `json:"already_present,omitempty"`
}

// ConfirmedUpload is SupplierDbUploadConfirmedData.
type ConfirmedUpload struct {
	Key       string `json:"key"`
	PublicURL string `json:"public_url"`
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
