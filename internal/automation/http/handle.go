package automationhttp

import (
	"encoding/json"
	"net/http"

	"github.com/go-chi/chi/v5"

	"github.com/xxww0098/podhub-go/internal/automation/contract"
	"github.com/xxww0098/podhub-go/internal/automation/domain"
	"github.com/xxww0098/podhub-go/internal/automation/service"
)

func (h handler) listAssets(w http.ResponseWriter, r *http.Request, p Session) {
	sets, err := h.Actions.ListAssetSets(r.Context(), p.OrgID, p.UserID)
	if err != nil {
		writeFault(w, err)
		return
	}
	writeOK(w, map[string]any{"sets": assetWires(sets)})
}

func (h handler) createAsset(w http.ResponseWriter, r *http.Request, p Session) {
	var body struct {
		Name  *string `json:"name"`
		Items *[]struct {
			FileName  *string         `json:"fileName"`
			SHA256    *string         `json:"sha256"`
			SizeBytes json.RawMessage `json:"sizeBytes"`
			RuntimeID *string         `json:"runtimeId"`
		} `json:"items"`
	}
	if fault := readJSON(r, &body); fault != nil || body.Name == nil || body.Items == nil {
		writeFault(w, contract.Validation(contract.MsgBadJSON))
		return
	}
	items := make([]domain.ItemInput, len(*body.Items))
	for i, item := range *body.Items {
		if item.FileName == nil || item.SHA256 == nil {
			writeFault(w, contract.Validation(contract.MsgBadJSON))
			return
		}
		size, fault := parseSize(item.SizeBytes)
		if fault != nil {
			writeFault(w, fault)
			return
		}
		items[i] = domain.ItemInput{FileName: *item.FileName, SHA256: *item.SHA256, SizeBytes: size, RuntimeID: item.RuntimeID}
	}
	set, err := h.Actions.CreateAssetSet(r.Context(), p.OrgID, p.UserID, *body.Name, items)
	if err != nil {
		writeFault(w, err)
		return
	}
	writeOK(w, map[string]any{"set": assetWire(set)})
}

func (h handler) claim(w http.ResponseWriter, r *http.Request, p Session) {
	var body struct {
		RuntimeID *string `json:"runtimeId"`
		Limit     *int64  `json:"limit"`
	}
	if fault := readJSON(r, &body); fault != nil || body.RuntimeID == nil {
		writeFault(w, contract.Validation(contract.MsgBadJSON))
		return
	}
	cmds, lease, err := h.Actions.Claim(r.Context(), p.OrgID, p.UserID, *body.RuntimeID, body.Limit)
	if err != nil {
		writeFault(w, err)
		return
	}
	wires := make([]claimedWire, len(cmds))
	for i, cmd := range cmds {
		payload := cmd.Payload
		if len(payload) == 0 {
			payload = json.RawMessage(`null`)
		}
		wires[i] = claimedWire{
			OperationID: cmd.OperationID, Action: cmd.Action, ClientRequestID: cmd.ClientRequestID,
			ClaimEpoch: cmd.ClaimEpoch, Payload: payload, CancelRequested: cmd.CancelRequested,
		}
	}
	writeOK(w, claimData{Commands: wires, LeaseSeconds: lease})
}

func (h handler) renew(w http.ResponseWriter, r *http.Request, p Session) {
	var body struct {
		RuntimeID *string `json:"runtimeId"`
		Claims    *[]struct {
			OperationID *string `json:"operationId"`
			ClaimEpoch  *int64  `json:"claimEpoch"`
		} `json:"claims"`
	}
	if fault := readJSON(r, &body); fault != nil || body.RuntimeID == nil || body.Claims == nil {
		writeFault(w, contract.Validation(contract.MsgBadJSON))
		return
	}
	claims := make([]service.RenewClaim, len(*body.Claims))
	for i, claim := range *body.Claims {
		if claim.OperationID == nil || claim.ClaimEpoch == nil {
			writeFault(w, contract.Validation(contract.MsgBadJSON))
			return
		}
		claims[i] = service.RenewClaim{OperationID: *claim.OperationID, Epoch: *claim.ClaimEpoch}
	}
	leases, err := h.Actions.Renew(r.Context(), p.OrgID, p.UserID, *body.RuntimeID, claims)
	if err != nil {
		writeFault(w, err)
		return
	}
	wires := make([]leaseWire, len(leases))
	for i, lease := range leases {
		wires[i] = leaseWire{OperationID: lease.OperationID, Control: lease.Control, LeaseSeconds: lease.LeaseSeconds}
	}
	writeOK(w, map[string]any{"leases": wires})
}

func (h handler) progress(w http.ResponseWriter, r *http.Request, p Session) {
	var body struct {
		ClaimEpoch *int64          `json:"claimEpoch"`
		Progress   json.RawMessage `json:"progress"`
	}
	if fault := readJSON(r, &body); fault != nil || body.ClaimEpoch == nil || len(body.Progress) == 0 {
		writeFault(w, contract.Validation(contract.MsgBadJSON))
		return
	}
	res, err := h.Actions.Progress(r.Context(), p.OrgID, p.UserID, chi.URLParam(r, "id"), *body.ClaimEpoch, body.Progress)
	writeBack(w, res, err)
}

func (h handler) settle(w http.ResponseWriter, r *http.Request, p Session) {
	var body struct {
		ClaimEpoch *int64           `json:"claimEpoch"`
		Status     *string          `json:"status"`
		Result     *json.RawMessage `json:"result"`
		Error      *json.RawMessage `json:"error"`
	}
	if fault := readJSON(r, &body); fault != nil || body.ClaimEpoch == nil || body.Status == nil {
		writeFault(w, contract.Validation(contract.MsgBadJSON))
		return
	}
	res, err := h.Actions.Settle(r.Context(), p.OrgID, p.UserID, chi.URLParam(r, "id"), *body.ClaimEpoch, *body.Status, body.Result, body.Error)
	writeBack(w, res, err)
}

func writeBack(w http.ResponseWriter, res domain.WriteResult, err error) {
	if err != nil {
		writeFault(w, err)
		return
	}
	writeOK(w, writeBody{Accepted: res.Applied, CancelRequested: res.CancelRequested})
}

func (h handler) listGrants(w http.ResponseWriter, r *http.Request, p Session) {
	grants, err := h.Actions.ListGrants(r.Context(), p.UserID, p.OrgID)
	if err != nil {
		writeFault(w, err)
		return
	}
	wires := make([]grantWire, len(grants))
	for i, grant := range grants {
		wires[i] = grantWireOf(grant)
	}
	writeOK(w, map[string]any{"grants": wires})
}

func (h handler) createGrant(w http.ResponseWriter, r *http.Request, p Session) {
	var body struct {
		Name    *string   `json:"name"`
		Actions *[]string `json:"actions"`
		Expires *int64    `json:"expiresInDays"`
	}
	if fault := readJSON(r, &body); fault != nil || body.Name == nil || body.Actions == nil {
		writeFault(w, contract.Validation(contract.MsgBadJSON))
		return
	}
	view, token, err := h.Actions.CreateGrant(r.Context(), p.UserID, p.OrgID, p.WorkspaceRole, *body.Name, *body.Actions, body.Expires)
	if err != nil {
		writeFault(w, err)
		return
	}
	writeOK(w, createGrantData{Grant: grantWireOf(view), Token: token})
}

func (h handler) revokeGrant(w http.ResponseWriter, r *http.Request, p Session) {
	id, err := h.Actions.RevokeGrant(r.Context(), p.UserID, p.OrgID, chi.URLParam(r, "id"))
	if err != nil {
		writeFault(w, err)
		return
	}
	writeOK(w, revokeData{ID: id, Revoked: true})
}

func (h handler) listRuntimes(w http.ResponseWriter, r *http.Request, p Session) {
	rows, err := h.Actions.ListRuntimes(r.Context(), p.OrgID, p.UserID)
	if err != nil {
		writeFault(w, err)
		return
	}
	wires := make([]runtimeWire, len(rows))
	for i, row := range rows {
		wires[i] = runtimeWireOf(row)
	}
	writeOK(w, map[string]any{"runtimes": wires})
}

func (h handler) registerRuntime(w http.ResponseWriter, r *http.Request, p Session) {
	var body struct {
		GrantID  *string `json:"grantId"`
		Label    *string `json:"label"`
		Renderer *string `json:"rendererContract"`
	}
	if fault := readJSON(r, &body); fault != nil || body.GrantID == nil || body.Label == nil || body.Renderer == nil {
		writeFault(w, contract.Validation(contract.MsgBadJSON))
		return
	}
	row, lease, err := h.Actions.RegisterRuntime(r.Context(), p.OrgID, p.UserID, *body.GrantID, *body.Label, *body.Renderer)
	if err != nil {
		writeFault(w, err)
		return
	}
	writeOK(w, registerData{Runtime: runtimeWireOf(row), ClaimLeaseSeconds: lease})
}

func (h handler) deregister(w http.ResponseWriter, r *http.Request, p Session) {
	row, err := h.Actions.DeregisterRuntime(r.Context(), p.OrgID, p.UserID, chi.URLParam(r, "id"))
	if err != nil {
		writeFault(w, err)
		return
	}
	writeOK(w, map[string]any{"runtime": runtimeWireOf(row)})
}

func (h handler) heartbeat(w http.ResponseWriter, r *http.Request, p Session) {
	row, err := h.Actions.HeartbeatRuntime(r.Context(), p.OrgID, p.UserID, chi.URLParam(r, "id"))
	if err != nil {
		writeFault(w, err)
		return
	}
	writeOK(w, map[string]any{"runtime": runtimeWireOf(row)})
}
