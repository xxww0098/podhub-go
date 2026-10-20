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

// currentSnapshot is the document this build writes. Unknown fields are
// refused so a downgrade cannot silently drop a bucket role.
type currentSnapshot struct {
	SchemaVersion  int             `json:"schemaVersion"`
	AIDefaultModel string          `json:"aiDefaultModel"`
	AIAccounts     []StoredAI      `json:"aiAccounts"`
	Buckets        []StoredBucket  `json:"storageBuckets"`
	Payment        json.RawMessage `json:"payment"`
}

// previousSnapshot is the single-account document written before bucket
// roles. It is read once and rewritten, not kept as a second format.
type previousSnapshot struct {
	SchemaVersion  int             `json:"schemaVersion"`
	AIDefaultModel string          `json:"aiDefaultModel"`
	AIAccounts     []StoredAI      `json:"aiAccounts"`
	MediaAccounts  []previousMedia `json:"mediaAccounts"`
	Supplier       *previousMedia  `json:"supplierDbStorage"`
	Delegate       *previousMedia  `json:"delegateAssetsStorage"`
	Payment        json.RawMessage `json:"payment"`
}

// legacySnapshot is the snake_case spellings of previousSnapshot.
type legacySnapshot struct {
	SchemaVersion  int             `json:"schema_version"`
	AIDefaultModel string          `json:"ai_default_model"`
	AIAccounts     []legacyAI      `json:"ai_accounts"`
	MediaAccounts  []legacyMedia   `json:"media_accounts"`
	Supplier       *legacyMedia    `json:"supplier_db_storage"`
	Delegate       *legacyMedia    `json:"delegate_assets_storage"`
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

type previousMedia struct {
	ID           string `json:"id"`
	Label        string `json:"label"`
	Provider     string `json:"provider"`
	Endpoint     string `json:"endpoint"`
	Region       string `json:"region"`
	Bucket       string `json:"bucket"`
	KeyPrefix    string `json:"keyPrefix"`
	PublicBase   string `json:"publicBaseUrl"`
	ForcePath    bool   `json:"forcePathStyle"`
	AccessKey    string `json:"accessKeyId"`
	SecretKey    string `json:"secretAccessKey"`
	SessionToken string `json:"sessionToken"`
	Active       bool   `json:"active"`
}

type legacyMedia struct {
	ID           string `json:"id"`
	Label        string `json:"label"`
	Provider     string `json:"provider"`
	Endpoint     string `json:"endpoint"`
	Region       string `json:"region"`
	Bucket       string `json:"bucket"`
	KeyPrefix    string `json:"key_prefix"`
	PublicBase   string `json:"public_base_url"`
	ForcePath    bool   `json:"force_path_style"`
	AccessKey    string `json:"access_key_id"`
	SecretKey    string `json:"secret_access_key"`
	SessionToken string `json:"session_token"`
	Active       bool   `json:"active"`
}

// ParseStored reads the current role document first, then the single-account
// document, then its snake_case spelling. legacy reports any non-current
// input so the caller re-seals it with the role list.
func ParseStored(plain []byte) (Snapshot, bool, error) {
	var current currentSnapshot
	if err := decodeStrict(plain, &current); err == nil {
		if current.SchemaVersion != 1 {
			return Snapshot{}, false, ErrSnapshotVersion
		}
		snap := Snapshot{
			SchemaVersion: 1, AIDefaultModel: current.AIDefaultModel, AIAccounts: current.AIAccounts,
		}
		payment, err := decodePayment(current.Payment)
		if err != nil {
			return Snapshot{}, false, ErrSnapshotParse
		}
		snap.Payment = payment
		for _, row := range current.Buckets {
			snap.Buckets = append(snap.Buckets, StoredBucket{
				ID: row.ID, Label: row.Label, Role: row.Role, Provider: row.Provider,
				Endpoint: row.Endpoint, Region: row.Region, Bucket: row.Bucket,
				KeyPrefix: row.KeyPrefix, PublicBase: row.PublicBase, ForcePath: row.ForcePath,
				AccessKey: row.AccessKey, SecretKey: row.SecretKey, SessionToken: row.SessionToken,
				Active: row.Active,
			})
		}
		return snap, false, nil
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
	for _, row := range old.MediaAccounts {
		converted.MediaAccounts = append(converted.MediaAccounts, row.camel())
	}
	if old.Supplier != nil {
		row := old.Supplier.camel()
		converted.Supplier = &row
	}
	if old.Delegate != nil {
		row := old.Delegate.camel()
		converted.Delegate = &row
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

// upgrade maps the single-account document onto bucket roles. The active
// media account is transit; the supplier and delegate sections keep their own
// roles. A document that names none produces an empty role list.
func (old previousSnapshot) upgrade() (Snapshot, bool, error) {
	snap := Snapshot{
		SchemaVersion: 1, AIDefaultModel: old.AIDefaultModel, AIAccounts: old.AIAccounts,
	}
	payment, err := decodePayment(old.Payment)
	if err != nil {
		return Snapshot{}, false, ErrSnapshotParse
	}
	snap.Payment = payment
	appendRole := func(row previousMedia, role string) {
		snap.Buckets = append(snap.Buckets, StoredBucket{
			ID: row.ID, Label: row.Label, Role: role, Provider: row.Provider,
			Endpoint: row.Endpoint, Region: row.Region, Bucket: row.Bucket,
			KeyPrefix: row.KeyPrefix, PublicBase: row.PublicBase, ForcePath: row.ForcePath,
			AccessKey: row.AccessKey, SecretKey: row.SecretKey, SessionToken: row.SessionToken,
			Active: row.Active,
		})
	}
	transit := previousMedia{}
	found := false
	for _, row := range old.MediaAccounts {
		if row.Active && !found {
			transit, found = row, true
		}
	}
	if !found && len(old.MediaAccounts) > 0 {
		transit = old.MediaAccounts[0]
	}
	if found || len(old.MediaAccounts) > 0 {
		appendRole(transit, "transit")
	}
	if old.Supplier != nil {
		appendRole(*old.Supplier, "assets")
	}
	if old.Delegate != nil {
		appendRole(*old.Delegate, "private")
	}
	return snap, true, nil
}

func (row legacyMedia) camel() previousMedia {
	return previousMedia{
		ID: row.ID, Label: row.Label, Provider: row.Provider, Endpoint: row.Endpoint,
		Region: row.Region, Bucket: row.Bucket, KeyPrefix: row.KeyPrefix, PublicBase: row.PublicBase,
		ForcePath: row.ForcePath, AccessKey: row.AccessKey, SecretKey: row.SecretKey,
		SessionToken: row.SessionToken, Active: row.Active,
	}
}

// Marshal writes the current role document. It is the only writer shape.
func (s Snapshot) Marshal() ([]byte, error) {
	doc := currentSnapshot{
		SchemaVersion: 1, AIDefaultModel: s.AIDefaultModel, AIAccounts: s.AIAccounts,
		Buckets: s.Buckets,
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
