package contract

import (
	"bytes"
	"encoding/json"
	"errors"

	"github.com/xxww0098/podhub-go/internal/platform/seal"
)

var (
	// ErrSnapshotParse is a plaintext that is neither camelCase nor snake_case schema 1.
	ErrSnapshotParse = errors.New("已加密的连接配置快照无法解析")
	// ErrSnapshotVersion is a stored schema version this reader does not accept.
	ErrSnapshotVersion = errors.New("已存储的连接配置 schema 版本不受支持")
)

// currentSnapshot is the document this build writes. Retired storage settings
// are accepted only to discard them when the snapshot is rewritten.
type currentSnapshot struct {
	SchemaVersion  int             `json:"schemaVersion"`
	AIDefaultModel string          `json:"aiDefaultModel"`
	AIAccounts     []StoredAI      `json:"aiAccounts"`
	AIRuntime      *AIRuntime      `json:"aiRuntime"`
	RetiredStorage json.RawMessage `json:"storageBuckets,omitempty"`
	Payment        json.RawMessage `json:"payment"`
}

// previousSnapshot is read once and rewritten without its storage settings.
type previousSnapshot struct {
	SchemaVersion  int             `json:"schemaVersion"`
	AIDefaultModel string          `json:"aiDefaultModel"`
	AIAccounts     []StoredAI      `json:"aiAccounts"`
	MediaAccounts  json.RawMessage `json:"mediaAccounts"`
	Supplier       json.RawMessage `json:"supplierDbStorage"`
	Delegate       json.RawMessage `json:"delegateAssetsStorage"`
	Payment        json.RawMessage `json:"payment"`
}

// legacySnapshot is the snake_case spellings of previousSnapshot.
type legacySnapshot struct {
	SchemaVersion  int             `json:"schema_version"`
	AIDefaultModel string          `json:"ai_default_model"`
	AIAccounts     []legacyAI      `json:"ai_accounts"`
	MediaAccounts  json.RawMessage `json:"media_accounts"`
	Supplier       json.RawMessage `json:"supplier_db_storage"`
	Delegate       json.RawMessage `json:"delegate_assets_storage"`
	Payment        json.RawMessage `json:"payment"`
}

type legacyAI struct {
	ID             string `json:"id"`
	Label          string `json:"label"`
	BaseURL        string `json:"base_url"`
	APIFormat      string `json:"api_format"`
	Model          string `json:"model"`
	APIKey         string `json:"api_key"`
	Active         bool   `json:"active"`
	Thinking       string `json:"thinking"`
	ThinkingFormat string `json:"thinking_format"`
	Priority       int64  `json:"priority"`
}

// ParseStored reads stored snapshots and reports whether they need rewriting.
// Retired storage credentials are never returned or written again.
func ParseStored(plain []byte) (Snapshot, bool, error) {
	var current currentSnapshot
	if err := decodeStrict(plain, &current); err == nil {
		if current.SchemaVersion != 1 {
			return Snapshot{}, false, ErrSnapshotVersion
		}
		snap := Snapshot{
			SchemaVersion: 1, AIDefaultModel: current.AIDefaultModel, AIAccounts: current.AIAccounts,
			AIRuntime: DefaultAIRuntime(),
		}
		legacy := current.AIRuntime == nil || len(current.RetiredStorage) > 0
		if current.AIRuntime != nil {
			snap.AIRuntime = *current.AIRuntime
			if snap.AIRuntime.LeaseTTLSeconds < 1 {
				snap.AIRuntime.LeaseTTLSeconds = DefaultLeaseTTLSeconds
				legacy = true
			}
		}
		if snap.migratePurpose() {
			legacy = true
		}
		payment, err := decodePayment(current.Payment)
		if err != nil {
			return Snapshot{}, false, ErrSnapshotParse
		}
		snap.Payment = payment
		return snap, legacy, nil
	}

	var previous previousSnapshot
	if err := decodeStrict(plain, &previous); err == nil {
		if previous.SchemaVersion != 1 {
			return Snapshot{}, false, ErrSnapshotVersion
		}
		return previous.upgrade()
	}

	var old legacySnapshot
	if err := decodeStrict(plain, &old); err != nil {
		return Snapshot{}, false, ErrSnapshotParse
	}
	if old.SchemaVersion != 1 {
		return Snapshot{}, false, ErrSnapshotVersion
	}
	converted := previousSnapshot{
		SchemaVersion: 1, AIDefaultModel: old.AIDefaultModel, Payment: old.Payment,
	}
	for _, row := range old.AIAccounts {
		converted.AIAccounts = append(converted.AIAccounts, StoredAI{
			ID: row.ID, Label: row.Label, BaseURL: row.BaseURL, APIFormat: row.APIFormat,
			Model: row.Model, APIKey: row.APIKey, Active: row.Active, Thinking: row.Thinking,
			ThinkingFormat: row.ThinkingFormat, Priority: row.Priority,
		})
	}
	return converted.upgrade()
}

func decodeStrict(plain []byte, target any) error {
	dec := json.NewDecoder(bytes.NewReader(plain))
	dec.DisallowUnknownFields()
	if err := dec.Decode(target); err != nil {
		return err
	}
	if dec.More() {
		return ErrSnapshotParse
	}
	return nil
}

func decodePayment(raw json.RawMessage) (*seal.StoredPaymentConfig, error) {
	if len(bytes.TrimSpace(raw)) == 0 || string(raw) == "null" {
		return nil, nil
	}
	var payment seal.StoredPaymentConfig
	if err := json.Unmarshal(raw, &payment); err != nil {
		return nil, err
	}
	return &payment, nil
}

// migratePurpose gives every account without a purpose the one the model name
// implied before the field existed, and reports whether it changed a row.
// The slice is copied so the decoded document is not aliased.
func (s *Snapshot) migratePurpose() bool {
	changed := false
	rows := make([]StoredAI, len(s.AIAccounts))
	copy(rows, s.AIAccounts)
	for i := range rows {
		if rows[i].Purpose != "" {
			continue
		}
		rows[i].Purpose = PurposeOCR
		if rows[i].Model == legacyImageModel {
			rows[i].Purpose = PurposeImage
		}
		changed = true
	}
	if s.AIAccounts != nil {
		s.AIAccounts = rows
	}
	return changed
}

// upgrade preserves AI and payment configuration and discards retired storage.
func (old previousSnapshot) upgrade() (Snapshot, bool, error) {
	snap := Snapshot{
		SchemaVersion: 1, AIDefaultModel: old.AIDefaultModel, AIAccounts: old.AIAccounts,
		AIRuntime: DefaultAIRuntime(),
	}
	snap.migratePurpose()
	payment, err := decodePayment(old.Payment)
	if err != nil {
		return Snapshot{}, false, ErrSnapshotParse
	}
	snap.Payment = payment
	return snap, true, nil
}

// Marshal writes the current integration document without storage settings.
func (s Snapshot) Marshal() ([]byte, error) {
	doc := currentSnapshot{
		SchemaVersion: 1, AIDefaultModel: s.AIDefaultModel, AIAccounts: s.AIAccounts,
		AIRuntime: &s.AIRuntime,
	}
	if s.Payment != nil {
		raw, err := json.Marshal(s.Payment)
		if err != nil {
			return nil, err
		}
		doc.Payment = raw
	}
	return json.Marshal(doc)
}
