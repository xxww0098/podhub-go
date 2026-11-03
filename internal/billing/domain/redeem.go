package domain

import "time"

// RedeemResult identifies the grant applied to the workspace.
type RedeemResult struct {
	WalletCents int64
	PlanKey     string
	PlanStores  int
	PlanMonths  int
	StartsAt    *time.Time
	EndsAt      *time.Time
}

// RedeemError is a client refusal with an HTTP status and a screaming code.
type RedeemError struct {
	Status  int
	Code    string
	Message string
}

func (e *RedeemError) Error() string { return e.Message }
