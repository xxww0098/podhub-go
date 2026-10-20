package domain

import "time"

// RedeemResult is the grant response. OcrCredits is always zero.
type RedeemResult struct {
	PlanKey       string
	PlanName      string
	MemberSeats   int64
	WalletCents   int64
	ReplacedLots  int64
	ReplacedSeats int64
	PlanExpiresAt *time.Time
}

// RedeemError is a client refusal with an HTTP status and a screaming code.
type RedeemError struct {
	Status  int
	Code    string
	Message string
}

func (e *RedeemError) Error() string { return e.Message }
