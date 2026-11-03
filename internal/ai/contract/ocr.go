// Package contract contains recognition task facts shared by its callers.
package contract

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
)

var ErrImageMissing = errors.New("recognition upload is missing")

type Lease struct {
	Owner string `json:"owner"`
	Epoch int64  `json:"epoch"`
}
type Claim struct {
	JobID string
	Lease Lease
}
type Routing struct {
	Primary string `json:"primary_model"`
}
type Prompt struct {
	ID             string   `json:"prompt_id"`
	Content        string   `json:"content"`
	SHA256         string   `json:"sha256"`
	FixedTags      []string `json:"fixed_tags"`
	TemplateSHA256 string   `json:"template_sha256"`
}
type Pin struct {
	PreparationOperation string          `json:"prepare_operation"`
	Executor             string          `json:"executor"`
	PinnedRevision       int64           `json:"pinned_revision"`
	SourceSHA256         string          `json:"source_sha256"`
	Contract             string          `json:"recognition_contract_version"`
	Prompt               Prompt          `json:"recognition_prompt"`
	Routing              Routing         `json:"model_routing"`
	FieldPolicy          json.RawMessage `json:"field_policy,omitempty"`
}
type Binding struct {
	Pin         Pin
	RowID       string
	Fingerprint string
	Key         string
	Lease       Lease
}
type Image struct {
	Bytes       uint64 `json:"bytes"`
	SHA256      string `json:"sha256"`
	ContentType string `json:"content_type"`
}
type Answer struct {
	RU          string          `json:"ru"`
	Description string          `json:"description"`
	Tags        []string        `json:"tags"`
	Candidates  json.RawMessage `json:"candidates"`
}

// ContractError is a paid answer that the shared OCR contract cannot apply.
type ContractError struct{ Message, ReasonCode, RetryClass string }

func (e *ContractError) Error() string { return e.Message }

// UpstreamError is a non-200 reply from the model provider. The ledger has already released or settled
// the call, so a caller may issue a fresh call under a new key; transport failures are not this type.
type UpstreamError struct{ Status int }

func (e *UpstreamError) Error() string {
	return fmt.Sprintf("识图服务返回 %d", e.Status)
}
func BindingHash(claim Claim, fingerprint string) string {
	raw, _ := json.Marshal(struct {
		Claim       Claim
		Fingerprint string
	}{claim, fingerprint})
	sum := sha256.Sum256(raw)
	return hex.EncodeToString(sum[:])
}
