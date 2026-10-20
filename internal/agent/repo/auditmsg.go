package agentrepo

// Audit messages keep serde_json's struct field order. encoding/json sorts
// map keys, so these are structs.

type claimAudit struct {
	Summary             string `json:"summary"`
	AgentUserID         int64  `json:"agent_user_id"`
	AgentAttributionBps int64  `json:"agent_attribution_bps"`
}

type payoutAudit struct {
	Summary string  `json:"summary"`
	Channel *string `json:"channel"`
}

type transferDoneAudit struct {
	Summary     string `json:"summary"`
	AmountCents int64  `json:"amount_cents"`
	OrgID       int64  `json:"org_id"`
}

type transferReplayAudit struct {
	Summary     string `json:"summary"`
	AmountCents int64  `json:"amount_cents"`
}

type withdrawalAudit struct {
	Summary     string `json:"summary"`
	AmountCents int64  `json:"amount_cents"`
}
