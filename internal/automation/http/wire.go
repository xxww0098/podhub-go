package automationhttp

import (
	"encoding/json"

	"github.com/xxww0098/podhub-go/internal/automation/domain"
	"github.com/xxww0098/podhub-go/internal/automation/service"
)

type assetItemWire struct {
	ID        string  `json:"id"`
	FileName  string  `json:"fileName"`
	SHA256    string  `json:"sha256"`
	SizeBytes int64   `json:"sizeBytes"`
	RuntimeID *string `json:"runtimeId,omitempty"`
}

type assetSetWire struct {
	ID          string          `json:"id"`
	Name        string          `json:"name"`
	CreatedAtMS int64           `json:"createdAtMs"`
	Items       []assetItemWire `json:"items"`
}

type claimedWire struct {
	OperationID     string          `json:"operationId"`
	Action          string          `json:"action"`
	ClientRequestID string          `json:"clientRequestId"`
	ClaimEpoch      int64           `json:"claimEpoch"`
	Payload         json.RawMessage `json:"payload"`
	CancelRequested bool            `json:"cancelRequested"`
}

type claimData struct {
	Commands     []claimedWire `json:"commands"`
	LeaseSeconds int64         `json:"lease_seconds"`
}

type leaseWire struct {
	OperationID  string `json:"operationId"`
	Control      string `json:"control"`
	LeaseSeconds int64  `json:"leaseSeconds"`
}

type writeBody struct {
	Accepted        bool `json:"accepted"`
	CancelRequested bool `json:"cancelRequested"`
}

type grantWire struct {
	ID           string   `json:"id"`
	Name         string   `json:"name"`
	Actions      []string `json:"actions"`
	TokenPrefix  string   `json:"tokenPrefix"`
	CreatedAtMS  int64    `json:"createdAtMs"`
	ExpiresAtMS  *int64   `json:"expiresAtMs,omitempty"`
	LastUsedAtMS *int64   `json:"lastUsedAtMs,omitempty"`
	RevokedAtMS  *int64   `json:"revokedAtMs,omitempty"`
}

type createGrantData struct {
	Grant grantWire `json:"grant"`
	Token string    `json:"token"`
}

type revokeData struct {
	ID      string `json:"id"`
	Revoked bool   `json:"revoked"`
}

type runtimeWire struct {
	ID               string `json:"id"`
	GrantID          string `json:"grantId"`
	Label            string `json:"label"`
	RendererContract string `json:"rendererContract"`
	HeartbeatAtMS    int64  `json:"heartbeatAtMs"`
	Live             bool   `json:"live"`
	CreatedAtMS      int64  `json:"createdAtMs"`
}

type registerData struct {
	Runtime           runtimeWire `json:"runtime"`
	ClaimLeaseSeconds int64       `json:"claim_lease_seconds"`
}

func assetWire(set domain.AssetSet) assetSetWire {
	return assetSetWire{ID: set.ID, Name: set.Name, CreatedAtMS: set.CreatedAtMS, Items: itemWires(set.Items)}
}

func assetWires(sets []domain.AssetSet) []assetSetWire {
	out := make([]assetSetWire, len(sets))
	for i, set := range sets {
		out[i] = assetWire(set)
	}
	return out
}

func itemWires(items []domain.AssetItem) []assetItemWire {
	out := make([]assetItemWire, len(items))
	for i, item := range items {
		out[i] = assetItemWire{ID: item.ID, FileName: item.FileName, SHA256: item.SHA256, SizeBytes: item.SizeBytes, RuntimeID: item.RuntimeID}
	}
	return out
}

func grantWireOf(view domain.GrantView) grantWire {
	actions := view.Actions
	if actions == nil {
		actions = []string{}
	}
	return grantWire{
		ID: view.ID, Name: view.Name, Actions: actions, TokenPrefix: view.TokenPrefix,
		CreatedAtMS: view.CreatedAtMS, ExpiresAtMS: view.ExpiresAtMS,
		LastUsedAtMS: view.LastUsedAtMS, RevokedAtMS: view.RevokedAtMS,
	}
}

func runtimeWireOf(row service.Runtime) runtimeWire {
	return runtimeWire{
		ID: row.ID, GrantID: row.GrantID, Label: row.Label, RendererContract: row.RendererContract,
		HeartbeatAtMS: row.HeartbeatAtMS, Live: row.Live, CreatedAtMS: row.CreatedAtMS,
	}
}
