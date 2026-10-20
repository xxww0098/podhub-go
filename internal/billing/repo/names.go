package billingrepo

import (
	"github.com/xxww0098/podhub-go/internal/billing/contract"
	"github.com/xxww0098/podhub-go/internal/billing/domain"
)

// Names the repo files already use. Aliasing them here keeps every function
// body unqualified after the declarations moved to contract and domain.
type (
	WalletRow       = contract.WalletRow
	WalletView      = contract.WalletView
	LedgerEntryView = contract.LedgerEntryView
	Settlement      = contract.Settlement
	Error           = contract.Error
	Price           = contract.Price
	PublishRequest  = contract.PublishRequest
	RedeemResult    = domain.RedeemResult
	RedeemError     = domain.RedeemError
)
