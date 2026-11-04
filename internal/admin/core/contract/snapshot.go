package contract

import "github.com/xxww0098/podhub-go/internal/platform/seal"

// Snapshot is the decrypted platform integration document.
// JSON names match seal.Snapshot and the stored camelCase document.
type Snapshot struct {
	SchemaVersion  int                       `json:"schemaVersion"`
	AIAccounts     []StoredAI                `json:"aiAccounts"`
	AIDefaultModel string                    `json:"aiDefaultModel"`
	AIRuntime      AIRuntime                 `json:"aiRuntime"`
	SystemStorage  []StoredStorage           `json:"systemStorage,omitempty"`
	Payment        *seal.StoredPaymentConfig `json:"payment,omitempty"`
}

// StoredStorage is a system bucket and its sealed credentials.
type StoredStorage struct {
	ID              string `json:"id"`
	Role            string `json:"role"`
	Endpoint        string `json:"endpoint"`
	Bucket          string `json:"bucket"`
	PublicBaseURL   string `json:"publicBaseUrl"`
	KeyPrefix       string `json:"keyPrefix"`
	AccessKeyID     string `json:"accessKeyId"`
	SecretAccessKey string `json:"secretAccessKey"`
}

// AI account purposes. OCR serves recognition; image serves set generation;
// chat serves the three text wire formats.
const (
	PurposeOCR   = "ocr"
	PurposeImage = "image"
	PurposeChat  = "chat"
)

// legacyImageModel is the one model that identified an image account before
// accounts carried a purpose. Only the one-time document migration reads it.
const legacyImageModel = "qwen-image-2.1-pro"

// DefaultLeaseTTLSeconds is the AI lease lifetime when nothing is stored.
const DefaultLeaseTTLSeconds = 90

// AIRuntime is the platform AI ceilings and the public-endpoint switch.
// Zero concurrency or rate turns that ceiling off.
type AIRuntime struct {
	MaxConcurrencyGlobal  int  `json:"maxConcurrencyGlobal"`
	MaxConcurrencyUser    int  `json:"maxConcurrencyUser"`
	MaxConcurrencyAccount int  `json:"maxConcurrencyAccount"`
	UserRatePerMinute     int  `json:"userRatePerMinute"`
	LeaseTTLSeconds       int  `json:"leaseTtlSeconds"`
	AllowPublicEgress     bool `json:"allowPublicEgress"`
}

// DefaultAIRuntime is every ceiling off, a 90 second lease, public dial off.
func DefaultAIRuntime() AIRuntime {
	return AIRuntime{LeaseTTLSeconds: DefaultLeaseTTLSeconds}
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
	Purpose        string `json:"purpose"`
}
