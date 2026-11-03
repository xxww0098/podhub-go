package contract

import "time"

// RedeemSpec is what gets inserted as a batch of wallet or plan codes.
type RedeemSpec struct {
	Quantity    int32
	WalletCents int64
	PlanKey     string
	PlanStores  int32
	PlanMonths  int32
	ExpiresAt   time.Time
	Note        *string
}

// TopupGrant is a manual wallet grant.
type TopupGrant struct {
	WorkspaceUUID string
	OperationID   string
	AmountCents   int64
	Note          string
}
