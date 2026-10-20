package agenthttp

import "github.com/xxww0098/podhub-go/internal/agent/domain"

// Wire struct field order is the JSON key order. Optional keys use
// omitempty so a nil value omits the key.
// payout_account on the workbench is omitted when unset. The payout PUT
// response does not skip a null data field.

type payoutView struct {
	Channel  string `json:"channel"`
	Account  string `json:"account"`
	RealName string `json:"real_name"`
}

type walletView struct {
	BalanceCents   int64 `json:"balance_cents"`
	HeldCents      int64 `json:"held_cents"`
	AvailableCents int64 `json:"available_cents"`
}

type commissionView struct {
	ID               int64  `json:"id"`
	InviteeEmail     string `json:"invitee_email"`
	WorkspaceName    string `json:"workspace_name"`
	Product          string `json:"product"`
	OrderAmountCents int64  `json:"order_amount_cents"`
	RebateBps        int64  `json:"rebate_bps"`
	AmountCents      int64  `json:"amount_cents"`
	Status           string `json:"status"`
	Note             string `json:"note"`
	CreatedAt        string `json:"created_at"`
}

type workbenchData struct {
	InviteCode              string           `json:"invite_code"`
	Status                  string           `json:"status"`
	RebateBps               int64            `json:"rebate_bps"`
	MinOrderCents           int64            `json:"min_order_cents"`
	AttributionValidityDays int64            `json:"attribution_validity_days"`
	MinWithdrawCents        int64            `json:"min_withdraw_cents"`
	Wallet                  walletView       `json:"wallet"`
	Payout                  *payoutView      `json:"payout_account,omitempty"`
	TransferAvailable       bool             `json:"wallet_transfer_available"`
	InviteeCount            int64            `json:"invitee_count"`
	CreditedCount           int64            `json:"credited_count"`
	SkippedCount            int64            `json:"skipped_count"`
	CreditedTotal           int64            `json:"credited_total_cents"`
	Commissions             []commissionView `json:"commissions"`
}

type workbenchResp struct {
	Data workbenchData `json:"data"`
}

type claimResp struct {
	Data struct {
		AgentName string `json:"agent_name"`
	} `json:"data"`
}

type ledgerEntry struct {
	EntryType         string `json:"entry_type"`
	AmountCents       int64  `json:"amount_cents"`
	HeldDeltaCents    int64  `json:"held_delta_cents"`
	BalanceAfterCents int64  `json:"balance_after_cents"`
	Note              string `json:"note"`
	CreatedAt         string `json:"created_at"`
}

type ledgerResp struct {
	Data struct {
		Entries []ledgerEntry `json:"entries"`
	} `json:"data"`
}

type payoutResp struct {
	Data *payoutView `json:"data"`
}

type transferResp struct {
	Data struct {
		OperationID           string `json:"operation_id"`
		AmountCents           int64  `json:"amount_cents"`
		WalletBalanceMicrofen int64  `json:"wallet_balance_microfen"`
		WorkspaceUUID         string `json:"workspace_uuid"`
		WorkspaceName         string `json:"workspace_name"`
	} `json:"data"`
}

type withdrawalView struct {
	PublicID     string  `json:"public_id"`
	AmountCents  int64   `json:"amount_cents"`
	Channel      string  `json:"channel"`
	Account      string  `json:"account"`
	RealName     string  `json:"real_name"`
	Status       string  `json:"status"`
	Reference    *string `json:"reference,omitempty"`
	RejectReason *string `json:"reject_reason,omitempty"`
	RequestedAt  string  `json:"requested_at"`
	DecidedAt    *string `json:"decided_at,omitempty"`
}

type withdrawalListResp struct {
	Data struct {
		Withdrawals []withdrawalView `json:"withdrawals"`
	} `json:"data"`
}

type withdrawalResp struct {
	Data withdrawalView `json:"data"`
}

func workbenchJSON(view domain.Workbench) workbenchResp {
	data := workbenchData{
		Status:                  view.Agent.Status,
		InviteCode:              view.Agent.InviteCode,
		RebateBps:               int64(view.Policy.DefaultRebateBps),
		MinOrderCents:           view.Policy.MinOrderCents,
		AttributionValidityDays: int64(view.Policy.AttributionValidityDays),
		MinWithdrawCents:        view.Policy.MinWithdrawCents,
		Wallet: walletView{
			BalanceCents:   view.Wallet.BalanceCents,
			HeldCents:      view.Wallet.HeldCents,
			AvailableCents: view.AvailableCents,
		},
		TransferAvailable: view.TransferAvailable,
		InviteeCount:      view.InviteeCount,
		CreditedCount:     view.CreditedCount,
		SkippedCount:      view.SkippedCount,
		CreditedTotal:     view.CreditedTotal,
		Commissions:       make([]commissionView, 0, len(view.Commissions)),
	}
	if view.Agent != nil && !view.Agent.Payout.Empty() {
		data.Payout = &payoutView{
			Channel:  view.Agent.Payout.Channel,
			Account:  view.Agent.Payout.Account,
			RealName: view.Agent.Payout.RealName,
		}
	}
	for _, row := range view.Commissions {
		data.Commissions = append(data.Commissions, commissionView{
			ID:               row.ID,
			InviteeEmail:     row.InviteeEmail,
			WorkspaceName:    row.WorkspaceName,
			Product:          row.Product,
			OrderAmountCents: row.OrderAmountCents,
			RebateBps:        row.RebateBps,
			AmountCents:      row.AmountCents,
			Status:           row.Status,
			Note:             row.Note,
			CreatedAt:        row.CreatedAt,
		})
	}
	return workbenchResp{Data: data}
}

func ledgerJSON(rows []domain.LedgerView) ledgerResp {
	var out ledgerResp
	out.Data.Entries = make([]ledgerEntry, 0, len(rows))
	for _, row := range rows {
		out.Data.Entries = append(out.Data.Entries, ledgerEntry{
			EntryType:         row.EntryType,
			AmountCents:       row.AmountCents,
			HeldDeltaCents:    row.HeldDeltaCents,
			BalanceAfterCents: row.BalanceAfterCents,
			Note:              row.Note,
			CreatedAt:         row.CreatedAt,
		})
	}
	return out
}

func withdrawalJSON(row domain.WithdrawalView) withdrawalView {
	return withdrawalView{
		PublicID:     row.PublicID,
		AmountCents:  row.AmountCents,
		Channel:      row.Channel,
		Account:      row.Account,
		RealName:     row.RealName,
		Status:       row.Status,
		Reference:    row.Reference,
		RejectReason: row.RejectReason,
		RequestedAt:  row.RequestedAt,
		DecidedAt:    row.DecidedAt,
	}
}

func withdrawalListJSON(rows []domain.WithdrawalView) withdrawalListResp {
	var out withdrawalListResp
	out.Data.Withdrawals = make([]withdrawalView, 0, len(rows))
	for _, row := range rows {
		out.Data.Withdrawals = append(out.Data.Withdrawals, withdrawalJSON(row))
	}
	return out
}
