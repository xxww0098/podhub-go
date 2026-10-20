package storehttp

import (
	"context"
	"net/http"

	"github.com/xxww0098/podhub-go/internal/store/contract"
	"github.com/xxww0098/podhub-go/internal/store/domain"
)

// The credential routes. Each constant is the exact path this service mounts;
// the golden route table pins them.
const (
	// PathCredential registers, rotates, or drops one store's held key.
	PathCredential = "/api/workspaces/stores/{uuid}/credential"
	// PathCredentialTest spends one live Seller probe on the held key.
	PathCredentialTest = "/api/workspaces/stores/{uuid}/credential/test"
	// PathCredentialExport is the one surface plaintext leaves through.
	PathCredentialExport = "/api/workspaces/stores/credentials/export"
	// PathProductQuotaRefresh refills the Ozon upload-quota snapshots.
	PathProductQuotaRefresh = "/api/workspaces/stores/product-quotas/refresh"
	// PathFinanceBalanceRefresh refills the Finance → Balance snapshots.
	PathFinanceBalanceRefresh = "/api/workspaces/stores/finance-balances/refresh"
)

// CredentialActions is the key-custody half of the store service.
type CredentialActions interface {
	RegisterCredential(ctx context.Context, orgID, userID int64, uuid, clientID, apiKey string, expectedStoreRevision int64, expectedCredentialRevision *int64, confirmUpload bool) (domain.RegisterOutcome, *contract.APIError)
	DeleteCredential(ctx context.Context, orgID, userID int64, uuid string, expectedStoreRevision, expectedCredentialRevision int64) (string, int64, *contract.APIError)
	TestCredential(ctx context.Context, orgID, userID int64, uuid string) (domain.VerifyResult, *contract.APIError)
	ExportCredentials(ctx context.Context, orgID, userID int64) ([]domain.ExportedCredential, *contract.APIError)
}

// RefreshActions is the two snapshot refresh loops. Both answer with the whole
// roster, so the SPA repaints from one response instead of re-reading.
type RefreshActions interface {
	Roster(ctx context.Context, orgID, userID int64) (domain.Roster, domain.Actor, *contract.APIError)
	RefreshProductQuotas(ctx context.Context, orgID, userID int64) (domain.Roster, domain.Actor, *contract.APIError)
	RefreshFinanceBalances(ctx context.Context, orgID, userID int64) (domain.Roster, domain.Actor, *contract.APIError)
}

type registerCredentialBody struct {
	ClientID                   string `json:"client_id"`
	APIKey                     string `json:"api_key"`
	ConfirmUpload              bool   `json:"confirm_upload"`
	ExpectedStoreRevision      int64  `json:"expected_store_revision"`
	ExpectedCredentialRevision *int64 `json:"expected_credential_revision"`
}

type deleteCredentialBody struct {
	ExpectedStoreRevision      int64 `json:"expected_store_revision"`
	ExpectedCredentialRevision int64 `json:"expected_credential_revision"`
}

type registerCredentialData struct {
	StoreUUID          string `json:"store_uuid"`
	CredentialRevision int64  `json:"credential_revision"`
	Revision           int64  `json:"revision"`
	FingerprintChanged bool   `json:"fingerprint_changed"`
	Rotated            bool   `json:"rotated"`
}

type deleteCredentialData struct {
	StoreUUID       string `json:"store_uuid"`
	CredentialState string `json:"credential_state"`
	Revision        int64  `json:"revision"`
}

type verifyCredentialData struct {
	StoreUUID          string `json:"store_uuid"`
	CredentialRevision int64  `json:"credential_revision"`
	VerifiedAtMS       int64  `json:"verified_at_ms"`
}

type exportCredentialItem struct {
	UUID     string `json:"uuid"`
	Name     string `json:"name"`
	ClientID string `json:"client_id"`
	APIKey   string `json:"api_key"`
}

type exportCredentialsData struct {
	Items []exportCredentialItem `json:"items"`
}

// registerCredential is POST PathCredential.
func (h handler) registerCredential(w http.ResponseWriter, r *http.Request) {
	p, _, ok := h.requireActor(w, r)
	if !ok {
		return
	}
	uuid, ok := storeUUID(w, r)
	if !ok {
		return
	}
	var body registerCredentialBody
	if !readStrict(r, &body) {
		writeAPIError(w, contract.Validation(contract.MsgInvalidJSON))
		return
	}
	outcome, api := h.Credential.RegisterCredential(r.Context(), p.OrgID, p.UserID, uuid,
		body.ClientID, body.APIKey, body.ExpectedStoreRevision, body.ExpectedCredentialRevision, body.ConfirmUpload)
	if api != nil {
		writeAPIError(w, api)
		return
	}
	writeJSON(w, http.StatusOK, registerCredentialData{
		StoreUUID: outcome.StoreUUID, CredentialRevision: outcome.CredentialRevision,
		Revision: outcome.Revision, FingerprintChanged: outcome.FingerprintChanged,
		Rotated: outcome.Rotated,
	})
}

// deleteCredential is DELETE PathCredential.
func (h handler) deleteCredential(w http.ResponseWriter, r *http.Request) {
	p, _, ok := h.requireActor(w, r)
	if !ok {
		return
	}
	uuid, ok := storeUUID(w, r)
	if !ok {
		return
	}
	var body deleteCredentialBody
	if !readStrict(r, &body) {
		writeAPIError(w, contract.Validation(contract.MsgInvalidJSON))
		return
	}
	storeUUID, revision, api := h.Credential.DeleteCredential(r.Context(), p.OrgID, p.UserID, uuid,
		body.ExpectedStoreRevision, body.ExpectedCredentialRevision)
	if api != nil {
		writeAPIError(w, api)
		return
	}
	writeJSON(w, http.StatusOK, deleteCredentialData{
		StoreUUID: storeUUID, CredentialState: "absent", Revision: revision,
	})
}

// testCredential is POST PathCredentialTest. It has no body.
func (h handler) testCredential(w http.ResponseWriter, r *http.Request) {
	p, _, ok := h.requireActor(w, r)
	if !ok {
		return
	}
	uuid, ok := storeUUID(w, r)
	if !ok {
		return
	}
	result, api := h.Credential.TestCredential(r.Context(), p.OrgID, p.UserID, uuid)
	if api != nil {
		writeAPIError(w, api)
		return
	}
	writeJSON(w, http.StatusOK, verifyCredentialData{
		StoreUUID: result.StoreUUID, CredentialRevision: result.CredentialRevision,
		VerifiedAtMS: result.VerifiedAtMS,
	})
}

// exportCredentials is POST PathCredentialExport.
func (h handler) exportCredentials(w http.ResponseWriter, r *http.Request) {
	p, _, ok := h.requireActor(w, r)
	if !ok {
		return
	}
	items, api := h.Credential.ExportCredentials(r.Context(), p.OrgID, p.UserID)
	if api != nil {
		writeAPIError(w, api)
		return
	}
	body := exportCredentialsData{
		Items: make([]exportCredentialItem, 0, len(items)),
	}
	for _, item := range items {
		body.Items = append(body.Items, exportCredentialItem{
			UUID: item.UUID, Name: item.Name, ClientID: item.ClientID, APIKey: item.APIKey,
		})
	}
	// A plaintext export must never be cached by an intermediary.
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, http.StatusOK, body)
}

// refreshProductQuotas is POST PathProductQuotaRefresh.
func (h handler) refreshProductQuotas(w http.ResponseWriter, r *http.Request) {
	h.refreshRoster(w, r, h.Refresh.RefreshProductQuotas)
}

// refreshFinanceBalances is POST PathFinanceBalanceRefresh.
func (h handler) refreshFinanceBalances(w http.ResponseWriter, r *http.Request) {
	h.refreshRoster(w, r, h.Refresh.RefreshFinanceBalances)
}

// refreshRoster runs one best-effort refresh loop and answers the whole roster,
// so the SPA repaints from this response instead of issuing a second read.
func (h handler) refreshRoster(w http.ResponseWriter, r *http.Request, refresh func(context.Context, int64, int64) (domain.Roster, domain.Actor, *contract.APIError)) {
	p, _, ok := h.requireActor(w, r)
	if !ok {
		return
	}
	roster, actor, api := refresh(r.Context(), p.OrgID, p.UserID)
	if api != nil {
		writeAPIError(w, api)
		return
	}
	writeJSON(w, http.StatusOK, toRosterData(roster, actor, domain.NowMS()))
}
