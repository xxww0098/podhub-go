package contract

import "github.com/xxww0098/podhub-go/internal/platform/seal"

// Snapshot is the decrypted platform integration document.
// JSON names match seal.Snapshot and the stored camelCase document.
//
// Buckets is the whole storage configuration: transit, assets and private.
// The older single-account fields (mediaAccounts, supplierDbStorage,
// delegateAssetsStorage) are read only so an already-sealed document can be
// upgraded in place; a write always produces the role list.
type Snapshot struct {
	SchemaVersion  int                       `json:"schemaVersion"`
	AIAccounts     []StoredAI                `json:"aiAccounts"`
	AIDefaultModel string                    `json:"aiDefaultModel"`
	Buckets        []StoredBucket            `json:"storageBuckets"`
	Payment        *seal.StoredPaymentConfig `json:"payment,omitempty"`
}

// StoredAI is one sealed AI account, including the secret.
type StoredAI struct {
	ID             string `json:"id"`
	Label          string `json:"label"`
	BaseURL        string `json:"baseUrl"`
	APIFormat      string `json:"apiFormat"`
	Model          string `json:"model"`
	APIKey         string `json:"apiKey"`
	Active         bool   `json:"active"`
	Thinking       string `json:"thinking"`
	ThinkingFormat string `json:"thinkingFormat"`
	Priority       int64  `json:"priority"`
}

// StoredBucket is one sealed storage account, including secrets.
// Role is transit, assets or private; Bucket and PublicBaseURL must match
// the role exactly, and the write path enforces that before sealing.
type StoredBucket struct {
	ID           string `json:"id"`
	Label        string `json:"label"`
	Role         string `json:"role"`
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
