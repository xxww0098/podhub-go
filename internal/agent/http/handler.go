// Package agenthttp mounts the seven agent routes.
// Auth is the session only. These handlers do not require a current org.
package agenthttp

import (
	"context"
	"net/http"

	"github.com/go-chi/chi/v5"

	"github.com/xxww0098/podhub-go/internal/agent/contract"
	"github.com/xxww0098/podhub-go/internal/agent/domain"
	"github.com/xxww0098/podhub-go/internal/agent/gen"
)

// Refusal is an auth answer already mapped to HTTP.
type Refusal struct {
	Status  int
	Code    string
	Message string
}

// Resolve reads the session. It does not trust an org id in the request.
type Resolve func(r *http.Request) (contract.Actor, *Refusal, error)

// API is the use-case surface. The HTTP package does not import the repo.
type API interface {
	Workbench(ctx context.Context, actor contract.Actor) (domain.Workbench, error)
	Ledger(ctx context.Context, actor contract.Actor) ([]domain.LedgerView, error)
	Withdrawals(ctx context.Context, actor contract.Actor) ([]domain.WithdrawalView, error)
	Claim(ctx context.Context, actor contract.Actor, code string) (string, error)
	SavePayout(ctx context.Context, actor contract.Actor, channel, account, realName *string) (domain.Payout, bool, error)
	Transfer(ctx context.Context, actor contract.Actor, operationID string, amountCents int64) (domain.Transfer, error)
	RequestWithdrawal(ctx context.Context, actor contract.Actor, amountCents int64) (domain.WithdrawalView, error)
}

// Deps is the HTTP seam.
type Deps struct {
	Service API
	Resolve Resolve
}

// Handler serves the generated agent operations.
type Handler struct {
	deps Deps
}

// Mount registers the agent routes on r.
func Mount(r chi.Router, d Deps) {
	gen.HandlerFromMux(Handler{deps: d}, r)
}

func (h Handler) AgentWorkbench(w http.ResponseWriter, r *http.Request) {
	actor, ok := h.actor(w, r)
	if !ok {
		return
	}
	view, err := h.deps.Service.Workbench(r.Context(), actor)
	if err != nil {
		writeFailure(w, err)
		return
	}
	if view.Agent == nil {
		writeErr(w, http.StatusNotFound, "你不是代理", "NOT_FOUND", "")
		return
	}
	writeOK(w, workbenchJSON(view))
}

func (h Handler) ClaimAgentInvite(w http.ResponseWriter, r *http.Request) {
	actor, ok := h.actor(w, r)
	if !ok {
		return
	}
	obj, fail := decodeObject(r, "code")
	if fail != nil {
		writeFailure(w, fail)
		return
	}
	code, fail := requiredString(obj["code"])
	if fail != nil {
		writeFailure(w, fail)
		return
	}
	name, err := h.deps.Service.Claim(r.Context(), actor, code)
	if err != nil {
		writeFailure(w, err)
		return
	}
	var body claimResp
	body.Data.AgentName = name
	writeOK(w, body)
}

func (h Handler) ListAgentLedger(w http.ResponseWriter, r *http.Request) {
	actor, ok := h.actor(w, r)
	if !ok {
		return
	}
	rows, err := h.deps.Service.Ledger(r.Context(), actor)
	if err != nil {
		writeFailure(w, err)
		return
	}
	writeOK(w, ledgerJSON(rows))
}

func (h Handler) SaveAgentPayoutAccount(w http.ResponseWriter, r *http.Request) {
	actor, ok := h.actor(w, r)
	if !ok {
		return
	}
	obj, fail := decodeObject(r, "channel", "account", "real_name")
	if fail != nil {
		writeFailure(w, fail)
		return
	}
	channel, fail := optionalString(obj["channel"])
	if fail != nil {
		writeFailure(w, fail)
		return
	}
	account, fail := optionalString(obj["account"])
	if fail != nil {
		writeFailure(w, fail)
		return
	}
	realName, fail := optionalString(obj["real_name"])
	if fail != nil {
		writeFailure(w, fail)
		return
	}
	saved, cleared, err := h.deps.Service.SavePayout(r.Context(), actor, channel, account, realName)
	if err != nil {
		writeFailure(w, err)
		return
	}
	var body payoutResp
	if !cleared {
		body.Data = &payoutView{Channel: saved.Channel, Account: saved.Account, RealName: saved.RealName}
	}
	writeOK(w, body)
}

func (h Handler) TransferAgentCommission(w http.ResponseWriter, r *http.Request) {
	actor, ok := h.actor(w, r)
	if !ok {
		return
	}
	obj, fail := decodeObject(r, "operation_id", "amount_cents")
	if fail != nil {
		writeFailure(w, fail)
		return
	}
	operationID, fail := requiredString(obj["operation_id"])
	if fail != nil {
		writeFailure(w, fail)
		return
	}
	amount, fail := requiredInt64(obj["amount_cents"])
	if fail != nil {
		writeFailure(w, fail)
		return
	}
	moved, err := h.deps.Service.Transfer(r.Context(), actor, operationID, amount)
	if err != nil {
		writeFailure(w, err)
		return
	}
	var body transferResp
	body.Data.OperationID = moved.OperationID
	body.Data.AmountCents = moved.AmountCents
	body.Data.WalletBalanceMicrofen = moved.WalletBalanceMicrofen
	body.Data.WorkspaceUUID = moved.WorkspaceUUID
	body.Data.WorkspaceName = moved.WorkspaceName
	writeOK(w, body)
}

func (h Handler) ListAgentWithdrawals(w http.ResponseWriter, r *http.Request) {
	actor, ok := h.actor(w, r)
	if !ok {
		return
	}
	rows, err := h.deps.Service.Withdrawals(r.Context(), actor)
	if err != nil {
		writeFailure(w, err)
		return
	}
	writeOK(w, withdrawalListJSON(rows))
}

func (h Handler) RequestAgentWithdrawal(w http.ResponseWriter, r *http.Request) {
	actor, ok := h.actor(w, r)
	if !ok {
		return
	}
	obj, fail := decodeObject(r, "amount_cents")
	if fail != nil {
		writeFailure(w, fail)
		return
	}
	amount, fail := requiredInt64(obj["amount_cents"])
	if fail != nil {
		writeFailure(w, fail)
		return
	}
	row, err := h.deps.Service.RequestWithdrawal(r.Context(), actor, amount)
	if err != nil {
		writeFailure(w, err)
		return
	}
	writeOK(w, withdrawalResp{Data: withdrawalJSON(row)})
}

func (h Handler) actor(w http.ResponseWriter, r *http.Request) (contract.Actor, bool) {
	if h.deps.Resolve == nil {
		writeErr(w, http.StatusUnauthorized, "未登录", "AUTH_REQUIRED", "")
		return contract.Actor{}, false
	}
	actor, refusal, err := h.deps.Resolve(r)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "服务暂不可用", "INTERNAL", "")
		return contract.Actor{}, false
	}
	if refusal != nil {
		writeErr(w, refusal.Status, refusal.Message, refusal.Code, "")
		return contract.Actor{}, false
	}
	if actor.UserID <= 0 {
		writeErr(w, http.StatusUnauthorized, "未登录", "AUTH_REQUIRED", "")
		return contract.Actor{}, false
	}
	if h.deps.Service == nil {
		writeErr(w, http.StatusInternalServerError, "服务暂不可用", "INTERNAL", "")
		return contract.Actor{}, false
	}
	return actor, true
}
