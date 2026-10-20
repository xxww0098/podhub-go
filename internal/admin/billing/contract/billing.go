package contract

import "time"

// RedeemSpec is what gets inserted. PlanKey is the catalogue key or "wallet".
type RedeemSpec struct {
	Product      string
	PlanKey      string
	PlanName     string
	MemberSeats  int64
	Tier         string
	OcrCredits   int64
	WalletCents  int64
	Quantity     int32
	DurationDays int32
	ExpiresAt    time.Time
	Note         *string
	NeedsPlan    bool
}

// TopupGrant is a manual wallet grant.
type TopupGrant struct {
	WorkspaceUUID string
	OperationID   string
	AmountCents   int64
	Note          string
}
