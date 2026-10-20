package domain

// Commission is one admin commission row. Field names stay snake_case.
type Commission struct {
	ID                   int64  `json:"id"`
	AgentEmail           string `json:"agent_email"`
	InviteeEmail         string `json:"invitee_email"`
	WorkspaceName        string `json:"workspace_name"`
	PaymentOrderPublicID string `json:"payment_order_public_id"`
	Product              string `json:"product"`
	OrderAmountCents     int64  `json:"order_amount_cents"`
	RebateBps            int64  `json:"rebate_bps"`
	AmountCents          int64  `json:"amount_cents"`
	Status               string `json:"status"`
	Note                 string `json:"note"`
	CreatedAt            string `json:"created_at"`
}

// CommissionList is the paged envelope.
type CommissionList struct {
	Data struct {
		Total       int64        `json:"total"`
		Page        int64        `json:"page"`
		PageSize    int64        `json:"page_size"`
		Commissions []Commission `json:"commissions"`
	} `json:"data"`
}

// Withdrawal is one admin withdrawal. Null optionals are omitted.
type AgentWithdrawal struct {
	PublicID     string  `json:"public_id"`
	AgentEmail   string  `json:"agent_email"`
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

// WithdrawalList wraps the rows.
type WithdrawalList struct {
	Data struct {
		Withdrawals []AgentWithdrawal `json:"withdrawals"`
	} `json:"data"`
}

// WithdrawalResponse wraps one row.
type WithdrawalResponse struct {
	Data AgentWithdrawal `json:"data"`
}

// PayoutAccount is omitted entirely when any column is missing.
type PayoutAccount struct {
	Channel  string `json:"channel"`
	Account  string `json:"account"`
	RealName string `json:"real_name"`
}

// Agent is one admin agent row.
type Agent struct {
	UserUUID           string         `json:"user_uuid"`
	Email              string         `json:"email"`
	Name               string         `json:"name"`
	InviteCode         string         `json:"invite_code"`
	Status             string         `json:"status"`
	PayoutAccount      *PayoutAccount `json:"payout_account,omitempty"`
	WalletBalanceCents int64          `json:"wallet_balance_cents"`
	WalletHeldCents    int64          `json:"wallet_held_cents"`
	InviteeCount       int64          `json:"invitee_count"`
	CreditedCount      int64          `json:"credited_count"`
	SkippedCount       int64          `json:"skipped_count"`
	CreditedTotalCents int64          `json:"credited_total_cents"`
	CreatedAt          string         `json:"created_at"`
	ReviewFlaggedAt    *string        `json:"review_flagged_at,omitempty"`
}

// Policy is the singleton rebate policy.
type Policy struct {
	DefaultRebateBps        int64 `json:"default_rebate_bps"`
	MinOrderCents           int64 `json:"min_order_cents"`
	AttributionValidityDays int64 `json:"attribution_validity_days"`
	MinWithdrawCents        int64 `json:"min_withdraw_cents"`
}

// AgentList is the admin agent list.
type AgentList struct {
	Data struct {
		DefaultRebateBps        int64   `json:"default_rebate_bps"`
		MinOrderCents           int64   `json:"min_order_cents"`
		AttributionValidityDays int64   `json:"attribution_validity_days"`
		MinWithdrawCents        int64   `json:"min_withdraw_cents"`
		Agents                  []Agent `json:"agents"`
	} `json:"data"`
}

// AgentResponse wraps one agent.
type AgentResponse struct {
	Data Agent `json:"data"`
}

// PolicyResponse echoes the written policy.
type PolicyResponse struct {
	Data Policy `json:"data"`
}
